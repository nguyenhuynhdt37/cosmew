import type {CommandRuntime, ToolDescriptor} from '@hannes/contracts';
import type {ResolvedPath} from '@hannes/workspace';
import type {ToolOutput} from '../context';

/** Only the execution shapes needed by the four built-ins. No plugin or arbitrary runtime port. */
export type PreparedTool = {
  file: ResolvedPath;
  execute(signal?: AbortSignal): ToolOutput | Promise<ToolOutput>;
} & (
  | {kind: 'read'}
  | {kind: 'search'; reason: 'listing' | 'search-skips-secrets'}
  | {kind: 'command'; command: string; workdir: string; label: string; runtime: CommandRuntime; runtimeId: string}
);
export interface ToolHandler {
  readonly descriptor: ToolDescriptor;
  available(): boolean;
  /** Registered tools may be unavailable without becoming unknown (e.g. the closed exec gate). */
  unavailable?: ToolOutput;
  prepare(input: unknown): PreparedTool | ToolOutput;
}
