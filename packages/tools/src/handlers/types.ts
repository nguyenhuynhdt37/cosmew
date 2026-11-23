import type {CommandClassification} from '@cosmew/security';
import type {
  CommandRuntime,
  CommandOutputChunk,
  CommandSandbox,
  ToolDescriptor,
  PermissionDecision,
  OutputArchiveSource,
  SubagentEvent,
} from '@cosmew/contracts';
import type {ResolvedPath} from '@cosmew/workspace';
import type {PatchPlan, ApplyPatchRuntime} from '../runtimes/apply-patch';
import type {ToolOutput} from '../context';

/** Only the execution shapes needed by the registered built-ins. No plugin or arbitrary runtime port. */
export type PreparedTool = {
  execute(
    signal?: AbortSignal,
    onOutput?: (chunk: CommandOutputChunk) => void,
    onEvent?: (event: SubagentEvent) => void,
    callId?: string,
  ): ToolOutput | Promise<ToolOutput>;
} & (
  | {kind: 'patch'; plan: PatchPlan; runtime: ApplyPatchRuntime}
  | {kind: 'read'; file: ResolvedPath; revalidate?: () => ResolvedPath; readDecision?: PermissionDecision}
  /** Agent session state (plan): no workspace effect, no approval; audited (ADR 0042). */
  | {kind: 'state'}
  | {kind: 'output'; source: OutputArchiveSource; valid(): boolean}
  /** Durable memory mutation; authorized as an edit, never as a workspace path. */
  | {kind: 'state-write'; target: string}
  /** A question to the user: no workspace effect; the answer is text (ADR 0042). */
  | {kind: 'question'}
  /** Subagent delegation (Wave 2 S5a): child tools enforce the same dispatcher/policy invariants. */
  | {kind: 'agent'; target: string; agentType: string}
  /** A user-configured MCP tool. The target is `mcp__server__tool`. */
  | {kind: 'mcp'; target: string; identity?: string}
  | {kind: 'web-search'; target: string}
  | {kind: 'web-fetch'; url: string; authorize?: (url: string, signal?: AbortSignal) => Promise<boolean>}
  /** Resolved asynchronously before policy (LSP rename asks the server first, ADR 0043). */
  | {kind: 'deferred'; file: ResolvedPath; resolve(signal?: AbortSignal): Promise<PreparedTool | ToolOutput>}
  | {kind: 'search'; file: ResolvedPath; reason: 'listing' | 'search-skips-secrets'}
  | {
      kind: 'command';
      file: ResolvedPath;
      command: string;
      workdir: string;
      outsideCwd: boolean;
      label: string;
      runtime: CommandRuntime;
      runtimeId: string;
      executionKey?: string;
      sessionId?: string;
      toolName?: string;
      /** Effective sandbox of a launch; stdin carries its session's launch sandbox instead. */
      sandbox?: CommandSandbox;
      justification?: string;
      /** `dangerouslyDisableSandbox` while the sandbox is enabled (ADR 0061). */
      escalation?: boolean;
      /** Set by the orchestrator: the command matched `sandbox.excludedCommands` and runs unsandboxed. */
      excluded?: boolean;
      stdin?: {chars: string; interrupt: boolean; tty: boolean; launch: CommandSandbox};
      /** Text the grant scope binds instead of `command` (stdin: the session, not the input). */
      grantCommand?: string;
      /** Shell `exec_command` runs the script with (Codex classifies `<shell> -c <script>`). */
      shell?: string;
      /** Codex-style classification (ADR 0040), computed once at authorization. */
      classification?: CommandClassification;
    }
);
export interface ToolHandler {
  readonly descriptor: ToolDescriptor;
  available(): boolean;
  /** Registered tools may be unavailable without becoming unknown (e.g. the closed exec gate). */
  unavailable?: ToolOutput;
  prepare(input: unknown, userSkill?: boolean): PreparedTool | ToolOutput;
}
