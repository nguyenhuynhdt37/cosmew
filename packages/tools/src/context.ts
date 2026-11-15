import type {ToolResult, CommandRuntime} from '@hannes/contracts';
import type {SessionGrants} from '@hannes/security';
import type {WorkspaceRoot} from '@hannes/workspace';

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
  /** Sandboxed command runtime (ADR 0022). Without one, or while it is unavailable, exec_command is not offered. */
  commands?: CommandRuntime;
}

/** Session grant target for one command: bound to the text, the canonical directory and the sandbox policy. */
export function commandGrantTarget(command: string, workdirAbsolute: string, runtimeId: string): string {
  return JSON.stringify({ exec: command, cwd: workdirAbsolute, sandbox: runtimeId });
}

export type ToolOutput = Omit<ToolResult, 'callId' | 'name'>;
export type Audit = (record: Omit<ToolAuditRecord, 'at' | 'callId' | 'tool'>) => void;
