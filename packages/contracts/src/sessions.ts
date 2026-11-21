import {z} from 'zod';
import type {Message, Selection} from './models';

export interface StoredMessage extends Message {
  revision: number;
  state: 'pending' | 'committed' | 'interrupted';
}

export interface SessionSummary {
  id: string;
  title: string;
  selection: Selection;
  revision: number;
  messageCount: number;
  lastState: 'idle' | 'pending' | 'committed' | 'interrupted';
  preview: string;
}

export interface SessionRecord extends SessionSummary {
  messages: StoredMessage[];
  turns?: import('./telemetry').TurnReceipt[];
  recovery?: import('./recovery').RecoveredConversation;
}

export const diffLineSchema = z.strictObject({
  type: z.enum(['context', 'add', 'del', 'hunk']),
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable(),
  content: z.string(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

export const workspaceDiffFileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  lines: z.array(diffLineSchema).max(5000),
  layer: z.enum(['staged', 'unstaged', 'untracked']).optional(),
  oldPath: z.string().optional(),
  binary: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type WorkspaceDiffFile = z.infer<typeof workspaceDiffFileSchema>;

export type WorkspaceDiffBase = 'session' | 'uncommitted' | 'branch';
export interface WorkspaceDiffOptions {
  base?: WorkspaceDiffBase;
}
export interface WorkspaceDiffCapability {
  available: boolean;
  reason?: string;
}
export interface WorkspaceDiffReport {
  /** Effective comparison; Current in the TUI means session. Older hosts may omit this. */
  base?: WorkspaceDiffBase;
  capabilities?: Record<WorkspaceDiffBase, WorkspaceDiffCapability>;
  workspace: string;
  gitAvailable: boolean;
  branch?: string;
  state?: 'ready' | 'not-repository' | 'git-unavailable' | 'denied' | 'error';
  message?: string;
  truncated?: boolean;
  files: WorkspaceDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Answer to steering input (Codex `TurnInputSubmission` / `NotSubmittedReason`, ADR 0033). Accepted
 * input is durable and is delivered to the model before the active turn's next request.
 */
export type SteerOutcome =
  | {accepted: true; turnId: string; steerId: string}
  | {accepted: false; reason: 'no_active_turn' | 'turn_mismatch' | 'not_steerable' | 'empty_input'};

/** Result of a manual `/compact` (ADR 0054). `compacted: false` leaves the model-visible context unchanged. */
export interface CompactionOutcome {
  compacted: boolean;
  strategy?: 'model' | 'excerpt';
  tokensBefore: number;
  tokensAfter: number;
  usage: import('./models').Usage | null;
  fallback?: boolean;
  /** Why nothing changed (`empty`, `not_needed`, or the failing error code). */
  reason?: string;
}

export type PromptHistoryScope = 'session' | 'project' | 'everywhere';
export interface PromptHistoryEntry {
  id: string;
  sessionId: string;
  content: string;
  timestamp: string;
}
export interface RetractQueuedOptions {
  includeShell?: boolean;
  /** Shell is eligible only when it is the sole queued entry (checked atomically). */
  shellOnlyWhenAlone?: boolean;
}
export interface QueuedInputEntry {
  id: string;
  type: 'text' | 'shell';
  content: string;
}

export interface ConversationStore {
  create(selection: Selection): string;
  /** Optional v4 durable execution journal. Production SQLite implements this boundary. */
  /** `carried` lists undelivered steering (by steerId) that this turn consumes as input before `user`. */
  beginExecution?(
    id: string,
    user: Message,
    receipt: import('./telemetry').TurnReceipt,
    carried?: string[],
    queuedInputId?: string,
  ): number;
  /** User input accepted after the active turn stopped accepting steering. Never grants execution authority. */
  enqueueNextTurn?(id: string, content: string): {id: string; content: string};
  moveQueuedInputToInbox?(id: string, live: readonly {steerId: string; content: string}[]): void;
  retractQueuedInput?(
    id: string,
    live?: readonly {steerId: string; content: string}[],
    options?: RetractQueuedOptions & {claimedIds?: readonly string[]},
  ): {steerId: string; content: string}[];
  listNextTurn?(id: string): readonly {id: string; content: string}[];
  recordExecution?(id: string, turnId: string, event: import('./recovery').ExecutionEventData): number;
  recover?(id: string): import('./recovery').RecoveredConversation;
  saveTask?(id: string, task: import('./recovery').ActiveTaskCheckpoint): void;
  saveContextSnapshot?(id: string, snapshot: import('./recovery').ContextSnapshot): void;
  /** Media of one tool result (ADR 0041), stored apart from messages and the journal, bounded per session. */
  saveAttachments?(id: string, callId: string, attachments: import('./tools').Attachment[]): void;
  /** Workspace-relative directories whose nested AGENTS.md this session loaded (ADR 0041); durable. */
  addInstructionDirectory?(id: string, directory: string): void;
  listInstructionDirectories?(id: string): string[];
  /** The session's current plan (`update_plan`, ADR 0042); durable, replaced as a whole. */
  savePlan?(id: string, plan: import('./tools').PlanState): void;
  savePlanProposal?(id: string, proposal: import('./tools').PlanProposal): import('./tools').PlanProposal | void;
  loadPlanProposal?(id: string): import('./tools').PlanProposal | null;
  loadPlan?(id: string): import('./tools').PlanState | null;
  /** Durable subagent metadata linked to a parent conversation (Wave 2 S5). */
  saveSubagentSession?(record: import('./subagents').SubagentSessionRecord): void;
  updateSubagentSession?(
    id: string,
    patch: {
      status: import('./subagents').SubagentStatus;
      finishedAt?: string | null;
      errorCode?: string;
    },
  ): void;
  getSubagentSession?(id: string): import('./subagents').SubagentSessionRecord | undefined;
  listSubagentSessions?(parentConversationId: string): import('./subagents').SubagentSessionRecord[];
  append(
    id: string,
    message: Message,
    state: 'pending' | 'committed',
    receipt?: import('./telemetry').TurnReceipt,
  ): number;
  /** Commit the pending user message, any tool rounds of this turn (`intermediate`) and the final answer atomically. */
  complete(
    id: string,
    revision: number,
    message: Message,
    receipt?: import('./telemetry').TurnReceipt,
    intermediate?: Message[],
  ): void;
  interrupt(id: string, revision: number, receipt?: import('./telemetry').TurnReceipt, appliedSteps?: Message[]): void;
  observeTurn?(id: string, revision: number, receipt: import('./telemetry').TurnReceipt): void;
  /** Add the usage of a manual compaction call to the latest agent turn's receipt (session usage, ADR 0054). */
  addUsage?(id: string, usage: import('./models').Usage): void;
  list?(): SessionSummary[];
  get?(id: string): SessionRecord | undefined;
  delete?(id: string): boolean;
}
