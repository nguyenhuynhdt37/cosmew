// UI-only presentation state. Never dispatches commands or resolves approvals.
export type FynState = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'done' | 'error' | 'cancelled' | 'sleep';

export const FYN_LABELS: Record<FynState, string> = {
  idle: 'ready',
  thinking: 'processing',
  streaming: 'replying',
  waiting: 'awaiting approval',
  done: 'complete',
  error: 'error',
  cancelled: 'cancelled',
  sleep: 'sleeping',
};
