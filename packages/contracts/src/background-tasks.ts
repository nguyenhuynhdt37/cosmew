/** Live execution tasks. Shell IDs are the existing unified-exec session IDs (ADR 0070). */
export interface BackgroundTask {
  id: string;
  kind: 'shell' | 'agent';
  description: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  exitCode?: number;
  outputTail: string;
}

export interface BackgroundTaskEvent {
  type: 'task.started' | 'task.updated' | 'task.finished';
  task: BackgroundTask;
  parentSessionId?: string;
  /** Completion has already been delivered to the parent before observers are notified. */
  delivery?: 'steered' | 'queued';
}
