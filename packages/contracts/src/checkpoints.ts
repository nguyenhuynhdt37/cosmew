import type {Message} from './models';

export type RewindScope = 'conversation' | 'code' | 'both' | 'summarize';
export interface CheckpointView {
  id: string;
  sessionId: string;
  createdAt: string;
  conversationIndex: number;
  prompt: string;
  promptId: string;
  text: string;
  fileChanges: {path: string; additions: number; deletions: number}[];
  files: number;
  restorable: boolean;
}
/** Private contents cross only injected host/store/tool ports, never SDK views or tool results. */
export interface CheckpointFile {
  path: string;
  before: string | null;
  beforeMode: number;
  afterHash: string | null;
  afterMode: number | null;
  additions: number;
  deletions: number;
}
export interface CheckpointRecord extends CheckpointView {
  workspace: string;
  messages: Message[];
  changes: CheckpointFile[];
}
export interface RewindOutcome {
  checkpointId: string;
  scope: RewindScope;
  restored: boolean;
  sessionId?: string;
  code?: string;
  strategy?: 'model' | 'excerpt';
  fallback?: boolean;
}
