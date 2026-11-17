import {createHash} from 'node:crypto';
import {
  FutrynError,
  toolResultSchema,
  type CommandOutputChunk,
  type PermissionDecision,
  type ToolCall,
  type ToolResult,
} from '@futryn/contracts';
import {classifyCommand, commandText, evaluateRead, evaluateExec, evaluateStdin, evaluateWrite} from '@futryn/security';
import {ensureShellParser, shellParsers} from './exec/shell-parse';
import {toCodePointColumn, type LspDiagnostic} from '@futryn/code-intel';
import {WriteBoundaryError, WorkspaceDenied, type ResolvedPath} from '@futryn/workspace';
import {
  commandGrantTarget,
  readDecision,
  effectiveSandboxMode,
  networkGranted,
  PERMISSION_GRANT,
  sandboxConfig,
  writeGranted,
  type ApprovalRequest,
  type Audit,
  type ToolDispatcherOptions,
  type ToolOutput,
} from './context';
import type {PreparedTool} from './handlers/types';
import {join} from 'node:path';
import {clipBytes} from './limits';
import {plainTerminalText} from './exec/output';
import {ToolRouter} from './router';

type Authorization = {gate: ToolOutput | null; viaSession: boolean; scopeHash?: string};

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
    const finish = (result: ToolOutput): ToolResult => {
      const clipped = clipBytes(this.options.redact(result.content), 60000);
      const final = toolResultSchema.parse({
        ...result,
        ...(result.target ? {target: this.options.redact(result.target)} : {}),
        ...(result.attachments
          ? {attachments: result.attachments.map(a => ({...a, ...(a.name ? {name: this.options.redact(a.name)} : {})}))}
          : {}),
        content: clipped.text,
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
      let prepared = resolved.handler.prepare(call.input);
      // A tool that must ask a helper (language server) before it knows its effect resolves first;
      // what it resolves to then goes through the same validation, policy and approval (ADR 0043).
      if ('kind' in prepared && prepared.kind === 'deferred') {
        const read = await this.authorizeRead(call.name, prepared.file, audit, signal);
        if (read.gate) return finish(read.gate);
        signal?.throwIfAborted();
        const denied = this.revalidateRead(prepared.file, read.viaSession, audit);
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
      if (prepared.kind === 'permissions') return finish(await this.grantPermissions(prepared, audit, signal));
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
        prepared.kind === 'patch'
          ? await this.authorizePatch(call.name, prepared, audit, signal)
          : prepared.kind === 'command'
            ? await this.authorizeCommand(prepared, audit, signal)
            : prepared.kind === 'read'
              ? await this.authorizeRead(call.name, prepared.file, audit, signal)
              : prepared.kind === 'web-search'
                ? await this.authorizeWeb(call.name, prepared.target, true, audit, signal)
                : prepared.kind === 'web-fetch'
                  ? {gate: null, viaSession: false}
                  : prepared.kind === 'state' || prepared.kind === 'question'
                    ? this.authorizeState(audit, prepared.kind)
                    : {gate: this.authorizeSearch(prepared, audit), viaSession: false};
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
          ? this.revalidateRead(prepared.file, authorization.viaSession, audit)
          : prepared.kind === 'command'
            ? this.revalidateCommand(prepared, authorization.viaSession, audit)
            : null;
      if (revalidation) return finish(revalidation);
      if (prepared.kind === 'patch') {
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
            content: 'Access denied: the path is outside the approved workspace.',
          });
        }
        if (error.reason === 'inaccessible')
          return finish({status: 'error', code: 'UNREADABLE', content: 'File metadata is inaccessible.'});
        if (error.reason === 'not-found')
          return finish({status: 'error', code: 'NOT_FOUND', content: 'No such file or directory in the workspace.'});
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
    audit({target, phase: 'decided', decision: answer, reason: 'user', scopeHash});
    // Fail closed even if an injected approval adapter returns an unexpected value.
    if (answer !== 'once' && answer !== 'session')
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
  ): Promise<Authorization> {
    const decision = readDecision(this.options, file.relative, file.absolute);
    return this.permission(
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
  }

  revalidateRead(file: ResolvedPath, viaSession: boolean, audit: Audit, allowPrompt = true): ToolOutput | null {
    const again = this.options.workspace.resolve(file.relative);
    const current = readDecision(this.options, again.relative, again.absolute);
    if (
      again.absolute !== file.absolute ||
      again.kind !== file.kind ||
      current.effect === 'deny' ||
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
        const file = this.options.workspace.resolve(change.snapshot.path);
        if (readDecision(this.options, file.relative, file.absolute).effect !== 'allow') continue;
        known.set(change.snapshot.path, lsp.knownErrors(file));
      } catch {
        known.set(change.snapshot.path, undefined);
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
        file = this.options.workspace.resolve(path);
        if (readDecision(this.options, file.relative, file.absolute).effect !== 'allow') continue;
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

  private authorizeState(audit: Audit, kind: 'state' | 'question'): Authorization {
    audit({target: null, phase: 'decided', decision: 'allow', reason: kind === 'state' ? 'agent-state' : 'user-input'});
    return {gate: null, viaSession: false};
  }

  private authorizeSearch(prepared: Extract<PreparedTool, {kind: 'search'}>, audit: Audit): ToolOutput | null {
    const decision = readDecision(this.options, prepared.file.relative, prepared.file.absolute);
    if (decision.effect === 'deny') {
      audit({target: prepared.file.relative, phase: 'decided', decision: 'deny', reason: decision.reason});
      return {
        status: 'denied',
        code: 'DENIED',
        content: `Access denied by policy (${decision.reason}).`,
        target: prepared.file.relative,
      };
    }
    // Listing returns names; grep independently authorizes every content read and skips asks.
    audit({target: prepared.file.relative, phase: 'decided', decision: 'allow', reason: prepared.reason});
    return null;
  }

  /**
   * `request_permissions` (ADR 0040): always asks (or is refused under `never`). "once" grants for
   * the rest of the running turn, "session" for the session; nothing runs here.
   */
  private async grantPermissions(
    prepared: Extract<PreparedTool, {kind: 'permissions'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    const parts = [
      ...(prepared.network ? ['network access for commands'] : []),
      ...prepared.writable.map(path => `write ${path}`),
    ];
    const target = parts.join(', ').slice(0, 1024);
    if (prepared.network && sandboxConfig(this.options).escalation === 'never') {
      audit({target, phase: 'decided', decision: 'deny', reason: 'escalation-forbidden'});
      return {
        status: 'denied',
        code: 'DENIED',
        content: 'Sandbox escalation is disabled (approval policy never). Nothing was granted.',
      };
    }
    const decision = {effect: 'ask' as const, reason: 'request-permissions'};
    const key = JSON.stringify({network: prepared.network, writable: prepared.writable});
    const request: ApprovalRequest = {
      tool: 'request_permissions',
      capability: prepared.network ? 'network.connect' : 'fs.write',
      target,
      reason: decision.reason,
      scopeKey: key,
      ...(prepared.network ? {network: true} : {}),
      ...(prepared.justification ? {justification: this.options.redact(prepared.justification)} : {}),
    };
    // Never reuse an earlier answer silently: each request is a new escalation decision.
    const scopeHash = createHash('sha256')
      .update(JSON.stringify(['request_permissions', key]))
      .digest('hex');
    audit({target, phase: 'decided', decision: 'ask', reason: decision.reason, scopeHash});
    const answer = await this.options.approve(request, signal);
    signal?.throwIfAborted();
    audit({target, phase: 'decided', decision: answer, reason: 'user', scopeHash});
    if (answer !== 'once' && answer !== 'session')
      return {
        status: 'denied',
        code: 'DENIED',
        content: 'The user denied the permission request. Nothing was granted.',
      };
    const turn = this.options.turnId?.();
    const scope = answer === 'session' || !turn ? 'session' : `turn:${turn}`;
    if (answer === 'once' && !turn)
      return {
        status: 'denied',
        code: 'DENIED',
        content:
          'A one-time grant needs a running turn; ask again and approve it for the session. Nothing was granted.',
      };
    if (prepared.network) this.options.grants.grant(PERMISSION_GRANT.capability, PERMISSION_GRANT.network(scope));
    for (const path of prepared.writable)
      this.options.grants.grant(PERMISSION_GRANT.capability, PERMISSION_GRANT.write(scope, path));
    return {
      status: 'ok',
      content:
        `Granted ${scope === 'session' ? 'for this session' : 'for the rest of this turn'}: ${parts.join('; ')}. ${
          prepared.network
            ? 'Commands still need sandbox_permissions "with_additional_permissions" with network enabled to use it.'
            : ''
        }`.trim(),
      target,
    };
  }

  private async authorizePatch(
    tool: string,
    prepared: Extract<PreparedTool, {kind: 'patch'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const {plan} = prepared;
    // Codex assess_patch_safety: writes inside writable roots follow the approval policy; others escalate.
    const workspaceWritable = sandboxConfig(this.options).mode === 'workspace-write';
    const decisions = plan.changes.map(c =>
      evaluateWrite(c.snapshot.path, join(this.options.workspace.root, c.snapshot.path), {
        stateDirectory: this.options.stateDirectory,
        writable: workspaceWritable || writeGranted(this.options, c.snapshot.path),
      }),
    );
    const denied = decisions.find(d => d.effect === 'deny');
    const decision = denied ??
      decisions.find(d => d.reason === 'outside-writable-roots') ?? {effect: 'ask' as const, reason: 'workspace-patch'};
    const target = plan.changes
      .map(c => c.snapshot.path)
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

  /** Exec policy for a launch, or Codex stdin review for input to an owned session (ADR 0034). */
  private commandDecision(prepared: Extract<PreparedTool, {kind: 'command'}>, file: ResolvedPath): PermissionDecision {
    const config = sandboxConfig(this.options);
    if (prepared.stdin) {
      // Input is not a command: only its session's working directory is checked, never the text.
      const location = evaluateRead(file.relative === '.' ? '.' : file.relative + '/', file.absolute, {
        stateDirectory: this.options.stateDirectory,
      });
      if (location.effect === 'deny') return location;
      return evaluateStdin({
        ...prepared.stdin,
        current: {mode: config.mode, network: false},
        escalation: config.escalation,
      });
    }
    return evaluateExec(prepared.command, file.relative, file.absolute, {
      stateDirectory: this.options.stateDirectory,
      sandbox: prepared.sandbox,
      configuredMode: config.mode,
      escalation: config.escalation,
      classification: prepared.classification,
      networkGranted: networkGranted(this.options),
    });
  }

  private async authorizeCommand(
    prepared: Extract<PreparedTool, {kind: 'command'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const {command, file, runtime, runtimeId, label} = prepared;
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
    }
    const decision = this.commandDecision(prepared, file);
    const grant = commandGrantTarget(prepared.grantCommand ?? command, file.absolute, runtimeId, prepared.executionKey);
    const unsandboxed = prepared.sandbox?.unsandboxed === true;
    const sandbox = unsandboxed
      ? 'NO SANDBOX'
      : prepared.sandbox
        ? `${runtime.label} · ${prepared.sandbox.mode}${prepared.sandbox.network ? ' + network' : ''}`
        : runtime.label;
    const authorization = await this.permission(
      decision,
      {
        tool: prepared.toolName ?? 'exec_command',
        capability: 'process.execute',
        target: command,
        workdir: file.relative,
        sandbox,
        // An escalation is never remembered: its prompt scope is unique to this one call.
        scopeKey: unsandboxed ? `${grant}\0${crypto.randomUUID()}` : grant,
        reason: decision.reason,
        // A request_permissions network grant turns the launch into an ordinary command decision.
        ...(prepared.sandbox?.network && decision.reason === 'network-escalation' ? {network: true} : {}),
        ...(unsandboxed ? {unsandboxed: true} : {}),
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
        : decision.reason === 'escalation-forbidden' && unsandboxed
          ? 'Running a command without the sandbox is not allowed under the "never" approval policy. Nothing was run. Work inside the sandbox or ask the user to change the approval policy.'
          : `Command denied by policy (${decision.reason}). Nothing was run.`,
      unsandboxed
        ? 'The user denied running this command without the sandbox. Nothing was run.'
        : 'The user denied running this command. Nothing was run.',
      signal,
    );
    // An escalation covers this one command: a "session" answer never becomes a reusable grant.
    if (unsandboxed && authorization.viaSession) {
      this.options.grants.revoke('process.execute', grant);
      return {...authorization, viaSession: false};
    }
    return authorization;
  }

  private revalidateCommand(
    prepared: Extract<PreparedTool, {kind: 'command'}>,
    viaSession: boolean,
    audit: Audit,
  ): ToolOutput | null {
    const {command, file, runtime, runtimeId, label} = prepared;
    const grant = commandGrantTarget(prepared.grantCommand ?? command, file.absolute, runtimeId, prepared.executionKey);
    const again = this.options.workspace.resolve(prepared.workdir);
    const current = this.commandDecision(prepared, again);
    // The configured sandbox is part of the approval: a change before launch voids it (no retrofit).
    const sandboxChanged = !!prepared.sandbox && effectiveSandboxMode(this.options, runtime) !== prepared.sandbox.mode;
    if (
      again.absolute !== file.absolute ||
      again.kind !== 'directory' ||
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
    if (!runtime.availability().ok)
      return {
        status: 'error',
        code: 'SANDBOX_UNAVAILABLE',
        content: 'The command sandbox is unavailable. Nothing was run.',
        target: label,
      };
    return null;
  }
}
