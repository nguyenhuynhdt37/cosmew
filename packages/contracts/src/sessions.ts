import { z } from 'zod';
import type { Message, Selection } from './models';

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
});
export type WorkspaceDiffFile = z.infer<typeof workspaceDiffFileSchema>;

export interface WorkspaceDiffReport {
  workspace: string;
  gitAvailable: boolean;
  files: WorkspaceDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface ConversationStore {
  create(selection: Selection): string;
  /** Optional v4 durable execution journal. Production SQLite implements this boundary. */
  beginExecution?(id:string,user:Message,receipt:import('./telemetry').TurnReceipt):number;
  recordExecution?(id:string,turnId:string,event:import('./recovery').ExecutionEventData):number;
  recover?(id:string):import('./recovery').RecoveredConversation;
  saveTask?(id:string,task:import('./recovery').ActiveTaskCheckpoint):void;
  saveContextSnapshot?(id:string,snapshot:import('./recovery').ContextSnapshot):void;
  append(id: string, message: Message, state: 'pending' | 'committed', receipt?: import('./telemetry').TurnReceipt): number;
  /** Commit the pending user message, any tool rounds of this turn (`intermediate`) and the final answer atomically. */
  complete(id: string, revision: number, message: Message, receipt?: import('./telemetry').TurnReceipt, intermediate?: Message[]): void;
  interrupt(id: string, revision: number, receipt?: import('./telemetry').TurnReceipt, appliedSteps?: Message[]): void;
  observeTurn?(id: string, revision: number, receipt: import('./telemetry').TurnReceipt): void;
  list?(): SessionSummary[];
  get?(id: string): SessionRecord | undefined;
  delete?(id: string): boolean;
}
