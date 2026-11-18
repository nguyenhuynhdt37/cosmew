import type {
  ToolResult,
  MemoriesPort,
  CommandRuntime,
  CommandSandbox,
  PlanState,
  UserInputOutcome,
  UserQuestion,
  PermissionDecision,
} from '@futryn/contracts';
import {evaluateRead, type SessionGrants, type SandboxEscalation} from '@futryn/security';
import type {LspManager} from '@futryn/code-intel';
import type {SkillCatalog, WorkspaceRoot} from '@futryn/workspace';

/**
 * The answer to an approval prompt (ADR 0055, Codex `ReviewDecision`): `session` is
 * ApprovedForSession; `always` is the persistent project Allow rule, which the approval adapter has
 * already saved - for the dispatcher it authorizes exactly this call, like `once`.
 */
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';

export interface ApprovalRequest {
  tool: string;
  /** `network.connect` is a `request_permissions` grant (ADR 0040). */
  capability: 'agent.state.write' | 'fs.read' | 'fs.write' | 'process.execute' | 'network.connect' | 'network.search';
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
  /** The command asks to run once WITHOUT the sandbox (`require_escalated`, ADR 0053). */
  unsandboxed?: boolean;
  /** True when the command matched the dangerous-command heuristic (`forced-rm`), even if combined with network/escalation. */
  dangerous?: boolean;
  /** Commands: parsed sub-commands for project rules, null when the script is unparsed (ADR 0040). */
  commands?: string[] | null;
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
  /** Discovered exact skill files; no arbitrary outside-workspace reads. */
  skills?: SkillCatalog;
  memories?: MemoriesPort;
  /** Plan/Review workflow restriction, checked again after awaiting approval. */
  analysisOnly?: () => boolean;
  grants: SessionGrants;
  /** Ask the user; must resolve to 'deny' when the prompt is dismissed or cancelled. */
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  /** Redact all outputs; incomplete prefixes must withhold any partial registered secret suffix. */
  redact(text: string, incomplete?: boolean): string;
  audit?(record: ToolAuditRecord): void;
  stateDirectory?: string;
  /** Pure current project read-rule decision; hard builtin deny/secret gates always remain. */
  readPolicy?(relative: string, absolute: string): 'allow' | 'ask' | 'deny' | undefined;
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
  sandbox?: () => SandboxConfig;
  /**
   * Identity of the running turn. `request_permissions` answered "once" grants for this turn only
   * (Codex); without it such grants cover only the request itself.
   */
  turnId?: () => string | undefined;
  /** Language servers (ADR 0043); `lsp`/`lsp_rename` are offered only while they are available. */
  codeIntel?: LspManager;
  /** Public web operations, wired only by the composition root. */
  web?: {search?(query: string, numResults: number, signal?: AbortSignal): Promise<string>; searchEndpoint?: string};
  /**
   * The agent's own session state (ADR 0042), owned by the composition root. Tools that need it
   * are offered only when it is wired.
   */
  agentState?: {
    updatePlan?(plan: PlanState): void;
    /** Ask the user (ADR 0042); resolves `unavailable` without a UI, and on abort the call is cancelled. */
    askUser?(questions: UserQuestion[], signal?: AbortSignal): Promise<UserInputOutcome>;
    /** Whether a user can answer now; the tool is offered only then (never in non-interactive runs). */
    canAskUser?(): boolean;
  };
}

/** Grant keys for `request_permissions` (ADR 0040), stored in the session grants. */
export const PERMISSION_GRANT = {
  capability: 'sandbox.grant',
  network: (scope: string) => JSON.stringify({grant: 'network', scope}),
  write: (scope: string, path: string) => JSON.stringify({grant: 'write', scope, path}),
} as const;

/** Scopes a `request_permissions` grant may live in right now: the session, and the running turn. */
export function grantScopes(options: ToolDispatcherOptions): string[] {
  const turn = options.turnId?.();
  return turn ? ['session', `turn:${turn}`] : ['session'];
}

export function networkGranted(options: ToolDispatcherOptions): boolean {
  return grantScopes(options).some(scope =>
    options.grants.has(PERMISSION_GRANT.capability, PERMISSION_GRANT.network(scope)),
  );
}

/** A workspace-relative path lies in a writable root granted by `request_permissions`. */
export function writeGranted(options: ToolDispatcherOptions, path: string): boolean {
  const grants = options.grants.list().filter(g => g.capability === PERMISSION_GRANT.capability);
  const scopes = new Set(grantScopes(options));
  return grants.some(g => {
    try {
      const parsed = JSON.parse(g.target) as {grant: string; scope: string; path?: string};
      return (
        parsed.grant === 'write' &&
        scopes.has(parsed.scope) &&
        !!parsed.path &&
        (path === parsed.path || path.startsWith(parsed.path + '/'))
      );
    } catch {
      return false;
    }
  });
}

/**
 * The session's configured sandbox, read per call: the mode (Read Only / Auto / Full Access presets,
 * ADR 0055), whether the approval policy still allows escalating (`never`: no), and whether the
 * user's config gives sandboxed commands network (`network_access`, `FUTRYN_SANDBOX_NETWORK`;
 * applies to `workspace-write` only, like Codex).
 */
export interface SandboxConfig {
  mode: CommandSandbox['mode'];
  escalation: SandboxEscalation;
  network?: boolean;
}

export const sandboxConfig = (options: ToolDispatcherOptions): SandboxConfig =>
  options.sandbox?.() ?? {mode: 'read-only' as const, escalation: 'on-request' as const};

/** Configured network for sandboxed commands: only the workspace-write sandbox has the setting. */
export const networkConfigured = (options: ToolDispatcherOptions): boolean => {
  const config = sandboxConfig(options);
  return config.network === true && config.mode === 'workspace-write';
};

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
  // Full Access is never downgraded silently: a runtime that cannot run unsandboxed refuses (ADR 0055).
  if (configured === 'danger-full-access') return modes.includes(configured) ? configured : undefined;
  return modes.includes(configured) ? configured : modes.includes('read-only') ? 'read-only' : undefined;
}

export function readDecision(
  options: Pick<ToolDispatcherOptions, 'stateDirectory' | 'readPolicy' | 'skills'>,
  relative: string,
  absolute: string,
  skillRead = false,
): PermissionDecision {
  const stateSkill = skillRead && options.skills?.isStateSkillFile(absolute, options.stateDirectory);
  const builtin = evaluateRead(relative, absolute, {stateDirectory: stateSkill ? undefined : options.stateDirectory});
  if (builtin.effect === 'deny') return builtin;
  const project = options.readPolicy?.(relative, absolute);
  if (project === 'deny') return {effect: 'deny', reason: 'project-read-rule'};
  if (project === 'ask' && builtin.effect === 'allow') return {effect: 'ask', reason: 'project-read-rule'};
  return builtin;
}
