import {createHash} from 'node:crypto';
import {
  FutrynError,
  toolResultSchema,
  type CommandOutputChunk,
  type PermissionDecision,
  type ToolCall,
  type ToolResult,
} from '@futryn/contracts';
import {evaluateRead, evaluateExec, evaluateStdin, evaluateWrite} from '@futryn/security';
import {WriteBoundaryError, WorkspaceDenied, type ResolvedPath} from '@futryn/workspace';
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
      const prepared = resolved.handler.prepare(call.input);
      if (!('kind' in prepared)) {
        if (prepared.status === 'denied')
          audit({target: null, phase: 'decided', decision: 'deny', reason: 'write-boundary'});
        return finish(prepared);
      }
      const authorization =
        prepared.kind === 'patch'
          ? await this.authorizePatch(call.name, prepared, audit, signal)
          : prepared.kind === 'command'
            ? await this.authorizeCommand(prepared, audit, signal)
            : prepared.kind === 'read'
              ? await this.authorizeRead(call.name, prepared.file, audit, signal)
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
      return finish(
        await prepared.execute(
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
        ),
      );
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
    const decision = evaluateRead(file.relative, file.absolute, {stateDirectory: this.options.stateDirectory});
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
    const current = evaluateRead(again.relative, again.absolute, {stateDirectory: this.options.stateDirectory});
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

  private authorizeSearch(prepared: Extract<PreparedTool, {kind: 'search'}>, audit: Audit): ToolOutput | null {
    const decision = evaluateRead(prepared.file.relative, prepared.file.absolute, {
      stateDirectory: this.options.stateDirectory,
    });
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

  private async authorizePatch(
    tool: string,
    prepared: Extract<PreparedTool, {kind: 'patch'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const {plan} = prepared;
    const denied = plan.changes
      .map(c =>
        evaluateWrite(c.snapshot.path, join(this.options.workspace.root, c.snapshot.path), {
          stateDirectory: this.options.stateDirectory,
        }),
      )
      .find(d => d.effect === 'deny');
    const decision = denied ?? {effect: 'ask' as const, reason: 'workspace-patch'};
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
    });
  }

  private async authorizeCommand(
    prepared: Extract<PreparedTool, {kind: 'command'}>,
    audit: Audit,
    signal?: AbortSignal,
  ): Promise<Authorization> {
    const {command, file, runtime, runtimeId, label} = prepared;
    const decision = this.commandDecision(prepared, file);
    const grant = commandGrantTarget(prepared.grantCommand ?? command, file.absolute, runtimeId, prepared.executionKey);
    const sandbox = prepared.sandbox
      ? `${runtime.label} · ${prepared.sandbox.mode}${prepared.sandbox.network ? ' + network' : ''}`
      : runtime.label;
    return this.permission(
      decision,
      {
        tool: prepared.toolName ?? 'exec_command',
        capability: 'process.execute',
        target: command,
        workdir: file.relative,
        sandbox,
        scopeKey: grant,
        reason: decision.reason,
        ...(prepared.sandbox?.network ? {network: true} : {}),
        ...(prepared.justification ? {justification: this.options.redact(prepared.justification)} : {}),
      },
      grant,
      label,
      audit,
      decision.reason === 'stdin-policy-tightened'
        ? 'This terminal was launched with broader permissions than the current sandbox allows; start a new command instead. Nothing was sent.'
        : `Command denied by policy (${decision.reason}). Nothing was run.`,
      'The user denied running this command. Nothing was run.',
      signal,
    );
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
