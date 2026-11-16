import type {ToolResult, CommandRuntime, CommandSandbox} from '@futryn/contracts';
import type {SessionGrants, SandboxEscalation} from '@futryn/security';
import type {WorkspaceRoot} from '@futryn/workspace';

export type ApprovalDecision = 'once' | 'session' | 'deny';

export interface ApprovalRequest {
  tool: string;
  capability: 'fs.read' | 'fs.write' | 'process.execute';
  /** Workspace-relative target, or the exact command for `process.execute`. */
  target: string;
  reason: string;
  /** For commands: the canonical working directory (workspace-relative) and the sandbox. */
  workdir?: string;
  sandbox?: string;
  scopeKey?: string;
  diffPreview?: string;
  /** The command asks for network access beyond the default sandbox (ADR 0034). */
  network?: boolean;
  /** Model-supplied, user-facing reason for additional permissions. */
  justification?: string;
}

/** One line of the tool audit trail. `requested` is written before any prompt or execution. */
export interface ToolAuditRecord {
  at: string;
  callId: string;
  tool: string;
  target: string | null;
  phase: 'requested' | 'decided' | 'completed';
  decision?: 'allow' | 'ask' | 'deny' | ApprovalDecision;
  reason?: string;
  outcome?: ToolResult['status'];
  code?: string;
  scopeHash?: string;
}

export interface ToolDispatcherOptions {
  workspace: WorkspaceRoot;
  grants: SessionGrants;
  /** Ask the user; must resolve to 'deny' when the prompt is dismissed or cancelled. */
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  /** Redact all outputs; incomplete prefixes must withhold any partial registered secret suffix. */
  redact(text: string, incomplete?: boolean): string;
  audit?(record: ToolAuditRecord): void;
  stateDirectory?: string;
  /** Search deadline; defaults to 30 s. */
  searchDeadlineMs?: number;
  /**
   * ripgrep executable for grep (ADR 0038). Omitted: the trusted `rg` on PATH, if any; `null`:
   * always use the built-in search. A path inside the workspace is never used.
   */
  ripgrep?: string | null;
  /** Sandboxed command runtime (ADR 0022). Without one, or while it is unavailable, exec_command is not offered. */
  commands?: CommandRuntime;
  /**
   * Configured command sandbox (ADR 0034). Read at prepare, authorization and revalidation, so a
   * change before launch invalidates the pending request. Defaults to read-only, on-request.
   */
  sandbox?: () => {mode: CommandSandbox['mode']; escalation: SandboxEscalation};
}

export const sandboxConfig = (options: ToolDispatcherOptions) =>
  options.sandbox?.() ?? {mode: 'read-only' as const, escalation: 'on-request' as const};

/** Session grant target for one command: bound to the text, the canonical directory and the sandbox policy. */
export function commandGrantTarget(
  command: string,
  workdirAbsolute: string,
  runtimeId: string,
  executionKey?: string,
): string {
  return JSON.stringify({
    exec: command,
    cwd: workdirAbsolute,
    sandbox: runtimeId,
    ...(executionKey ? {executionKey} : {}),
  });
}

export type ToolOutput = Omit<ToolResult, 'callId' | 'name'>;
export type Audit = (record: Omit<ToolAuditRecord, 'at' | 'callId' | 'tool'>) => void;

/**
 * The sandbox a command actually gets: the configured mode when the runtime can enforce it, otherwise
 * read-only when that is enforceable (stricter, never looser). Undefined means nothing can run.
 */
export function effectiveSandboxMode(
  options: ToolDispatcherOptions,
  runtime: CommandRuntime,
): CommandSandbox['mode'] | undefined {
  const modes = runtime.capabilities?.().modes ?? ['read-only'];
  const configured = sandboxConfig(options).mode;
  return modes.includes(configured) ? configured : modes.includes('read-only') ? 'read-only' : undefined;
}
