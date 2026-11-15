import type {CommandRuntime, ToolDescriptor} from '@hannes/contracts';
import type {ResolvedPath} from '@hannes/workspace';
import type {PatchPlan, ApplyPatchRuntime} from '../runtimes/apply-patch';
import type {ToolOutput} from '../context';

/** Only the execution shapes needed by the registered built-ins. No plugin or arbitrary runtime port. */
export type PreparedTool = {
  execute(signal?: AbortSignal): ToolOutput | Promise<ToolOutput>;
} & (
  | {kind:'patch'; plan:PatchPlan; runtime:ApplyPatchRuntime}
  | {kind: 'read'; file: ResolvedPath}
  | {kind: 'search'; file: ResolvedPath; reason: 'listing' | 'search-skips-secrets'}
  | {kind: 'command'; file: ResolvedPath; command: string; workdir: string; label: string; runtime: CommandRuntime; runtimeId: string}
);
export interface ToolHandler {
  readonly descriptor: ToolDescriptor;
  available(): boolean;
  /** Registered tools may be unavailable without becoming unknown (e.g. the closed exec gate). */
  unavailable?: ToolOutput;
  prepare(input: unknown): PreparedTool | ToolOutput;
}
