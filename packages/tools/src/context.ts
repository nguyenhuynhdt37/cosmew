import type {
  ToolResult,
  ToolOutputArchive,
  OutputArchiveScope,
  MemoriesPort,
  CommandRuntime,
  CommandSandbox,
  PermissionMode,
  PlanState,
  UserInputOutcome,
  UserQuestion,
  PermissionDecision,
  PermissionPromptRequest,
  SubagentExecutionPort,
  HookPort,
} from '@cosmew/contracts';
import {evaluateRead, type SessionGrants} from '@cosmew/security';
import type {LspManager} from '@cosmew/code-intel';
import type {SkillCatalog, WorkspaceRoot} from '@cosmew/workspace';

/**
 * The answer to an approval prompt (ADR 0055, 0061): `session` lasts for the session; `always` is a
 * saved Allow rule, which the approval adapter has already stored - for the dispatcher it authorizes
 * exactly this call, like `once`.
 */
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';

export interface ApprovalRequest {
  tool: string;
  capability:
    | 'agent.state.write'
    | 'agent.spawn'
    | 'fs.read'
    | 'fs.write'
    | 'process.execute'
    | 'network.connect'
    | 'network.search'
    | 'mcp.call';
  /** Workspace-relative target, or the exact command for `process.execute`. */
  target: string;
  reason: string;
  /** For commands: the canonical working directory (workspace-relative) and the sandbox. */
  workdir?: string;
  sandbox?: string;
  /** Why a shell launch has its effective sandbox. Absent for terminal input. */
  commandSandbox?: PermissionPromptRequest['commandSandbox'];
  scopeKey?: string;
  diffPreview?: string;
  /** The command asks to run once WITHOUT the sandbox (`dangerouslyDisableSandbox`, ADR 0061). */
  unsandboxed?: boolean;
  /** The command runs outside the sandbox because it matches a configured exclusion. */
  excluded?: boolean;
  /** True when the command matched the dangerous-command heuristic (`forced-rm`), for display. */
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
  /** Owning conversation captured at command launch, including subagents. */
  sessionId?: () => string | undefined;
  checkpoints?: {
    capture(changes: import('@cosmew/contracts').CheckpointFile[]): void;
    restore(id: string): import('@cosmew/contracts').CheckpointFile[];
  };
  workspace: WorkspaceRoot;
  outputArchive?: {
    store: ToolOutputArchive;
    scope(): OutputArchiveScope;
    /**
     * MUST fingerprint all effective source/tool policy configuration, including mutable policy
     * captured by any custom readPolicy closure. Search captures do not enumerate every source
     * file, so every changing rule must change this fingerprint. The dispatcher additionally
     * hashes grant scope/revocations, sandbox and mode; direct source-read revalidation supplements
     * this fingerprint and does not replace it.
     */
    permissionContext(): string;
    policy?(): 'allow' | 'ask' | 'deny' | undefined;
  };
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
  /** Current Edit rule, including canonical external targets; hard path restrictions remain. */
  writePolicy?(relative: string, absolute: string): 'allow' | 'ask' | 'deny' | undefined;
  /** Current named-tool rule, rechecked after agent_message approval. */
  toolPolicy?(tool: string): 'allow' | 'ask' | 'deny' | undefined;
  /** Search deadline; defaults to 30 s. */
  searchDeadlineMs?: number;
  /**
   * ripgrep executable for grep (ADR 0038). Omitted: the trusted `rg` on PATH, if any; `null`:
   * always use the built-in search. A path inside the workspace is never used.
   */
  ripgrep?: string | null;
  /** Command runtime (ADR 0022). Without one exec_command is not offered; sandbox health gates sandboxed launches. */
  commands?: CommandRuntime;
  /**
   * Configured command sandbox (ADR 0034). Read at prepare, authorization and revalidation, so a
   * change before launch invalidates the pending request. Defaults to read-only, on-request.
   */
  sandbox?: () => SandboxConfig;
  /** The sandbox network gate (ADR 0061); without it sandboxed commands have loopback only. */
  proxy?: {ensure(): Promise<string>};
  /** Identity of the running turn, when the composition root tracks it. */
  turnId?: () => string | undefined;
  /** Language servers (ADR 0043); `lsp`/`lsp_rename` are offered only while they are available. */
  codeIntel?: LspManager;
  /** Public web operations, wired only by the composition root. */
  web?: {search?(query: string, numResults: number, signal?: AbortSignal): Promise<string>; searchEndpoint?: string};
  /**
   * User-configured MCP tools (ADR 0068) and resources (ADR 0119), wired only by the composition
   * root. Names are `mcp__server__tool`. The dispatcher authorizes each call before `call`.
   */
  mcp?: {
    tools(): readonly {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      readOnlyHint?: boolean;
      identity?: string;
    }[];
    call(
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<string | {text: string; isError?: boolean}>;
    servers?(): readonly {name: string; identity: string}[];
    listResources?(
      server: string,
      signal?: AbortSignal,
    ): Promise<
      readonly {
        server: string;
        uri: string;
        name: string;
        description?: string;
        mimeType?: string;
        size?: number;
      }[]
    >;
    listResourceTemplates?(
      server: string,
      signal?: AbortSignal,
    ): Promise<
      readonly {
        server: string;
        uriTemplate: string;
        name: string;
        description?: string;
        mimeType?: string;
      }[]
    >;
    readResource?(server: string, uri: string, signal?: AbortSignal): Promise<string>;
  };
  /**
   * The agent's own session state (ADR 0042), owned by the composition root. Tools that need it
   * are offered only when it is wired.
   */
  agentState?: {
    updatePlan?(plan: PlanState): void;
    canProposePlan?(): boolean;
    proposePlan?(plan: string, signal?: AbortSignal): Promise<import('@cosmew/contracts').PlanApprovalOutcome>;
    /** Ask the user (ADR 0042); resolves `unavailable` without a UI, and on abort the call is cancelled. */
    askUser?(questions: UserQuestion[], signal?: AbortSignal): Promise<UserInputOutcome>;
    /** Whether a user can answer now; the tool is offered only then (never in non-interactive runs). */
    canAskUser?(): boolean;
  };
  /** Nested subagent execution port (Wave 2 S5a), wired by the composition root. */
  subagents?: SubagentExecutionPort;
  /** Trusted lifecycle hooks (`PreToolUse`, `PostToolUse`, ADR 0120). Never grants permissions. */
  hooks?: HookPort;
}

/**
 * The session's sandbox settings, read per call (ADR 0061): `sandbox.enabled`,
 * `autoAllowBashIfSandboxed`, `excludedCommands`, `allowUnsandboxedCommands`, the writable
 * `additionalDirectories`, the permission mode and the path globs of `Read`/`Edit` deny rules.
 * `readOnly` narrows a subagent profile to an OS sandbox that cannot write the workspace.
 */
export interface SandboxConfig {
  enabled: boolean;
  readOnly?: boolean;
  autoAllowBash: boolean;
  excludedCommands: string[];
  allowUnsandboxed: boolean;
  additionalDirectories: string[];
  /** Commands may use the network through the domain-filtering proxy. */
  network: boolean;
  permissionMode: PermissionMode;
  denyRead?: string[];
  denyWrite?: string[];
}

/** Without a configured sandbox a dispatcher is read-only: nothing can write and nothing escapes. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  readOnly: true,
  autoAllowBash: true,
  excludedCommands: [],
  allowUnsandboxed: false,
  additionalDirectories: [],
  network: false,
  permissionMode: 'default',
};

export const sandboxConfig = (options: ToolDispatcherOptions): SandboxConfig =>
  options.sandbox?.() ?? DEFAULT_SANDBOX_CONFIG;

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
 * The sandbox a command actually gets: the OS sandbox of the configured kind when the runtime can
 * enforce it, `danger-full-access` (no sandbox) when settings disable it and the runtime can run
 * that. A runtime that cannot enforce a workspace-write sandbox is stepped down to read-only, never
 * up. Undefined means nothing can run: there is never a silent fallback to no sandbox.
 */
export function effectiveSandboxMode(
  options: ToolDispatcherOptions,
  runtime: CommandRuntime,
): CommandSandbox['mode'] | undefined {
  const modes = runtime.capabilities?.().modes ?? ['read-only'];
  const config = sandboxConfig(options);
  if (!config.enabled) return modes.includes('danger-full-access') ? 'danger-full-access' : undefined;
  const configured = config.readOnly ? 'read-only' : 'workspace-write';
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
