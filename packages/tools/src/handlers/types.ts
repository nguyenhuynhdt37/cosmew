import type {CommandRuntime, CommandOutputChunk, CommandSandbox, ToolDescriptor} from '@futryn/contracts';
import type {ResolvedPath} from '@futryn/workspace';
import type {PatchPlan, ApplyPatchRuntime} from '../runtimes/apply-patch';
import type {ToolOutput} from '../context';

/** Only the execution shapes needed by the registered built-ins. No plugin or arbitrary runtime port. */
export type PreparedTool = {
  execute(signal?: AbortSignal, onOutput?: (chunk: CommandOutputChunk) => void): ToolOutput | Promise<ToolOutput>;
} & (
  | {kind: 'patch'; plan: PatchPlan; runtime: ApplyPatchRuntime}
  | {kind: 'read'; file: ResolvedPath}
  /** `request_permissions` (ADR 0040): a grant for later calls, never an action by itself. */
  | {kind: 'permissions'; network: boolean; writable: string[]; justification?: string}
  | {kind: 'search'; file: ResolvedPath; reason: 'listing' | 'search-skips-secrets'}
  | {
      kind: 'command';
      file: ResolvedPath;
      command: string;
      workdir: string;
      label: string;
      runtime: CommandRuntime;
      runtimeId: string;
      executionKey?: string;
      sessionId?: string;
      toolName?: string;
      /** Effective sandbox of a launch; stdin carries its session's launch sandbox instead. */
      sandbox?: CommandSandbox;
      justification?: string;
      stdin?: {chars: string; interrupt: boolean; tty: boolean; launch: CommandSandbox; sessionCommand?: string};
      /** Text the grant scope binds instead of `command` (stdin: the session, not the input). */
      grantCommand?: string;
      /** Tree-sitter classification (ADR 0040), computed once at authorization. */
      classification?: {dangerous: string | null; uncertain: boolean};
    }
);
export interface ToolHandler {
  readonly descriptor: ToolDescriptor;
  available(): boolean;
  /** Registered tools may be unavailable without becoming unknown (e.g. the closed exec gate). */
  unavailable?: ToolOutput;
  prepare(input: unknown): PreparedTool | ToolOutput;
}
