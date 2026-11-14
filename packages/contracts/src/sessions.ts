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
  append(id: string, message: Message, state: 'pending' | 'committed'): number;
  complete(id: string, revision: number, message: Message): void;
  interrupt(id: string, revision: number): void;
  list?(): SessionSummary[];
  get?(id: string): SessionRecord | undefined;
  delete?(id: string): boolean;
}
