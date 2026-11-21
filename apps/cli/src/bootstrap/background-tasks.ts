import type {BackgroundTask, BackgroundTaskEvent, CommandRuntime} from '@cosmew/contracts';

import type {BackgroundTaskHistory} from '@cosmew/persistence';

/** Session ownership and completion delivery for existing unified-exec sessions (ADR 0070). */
export class BackgroundTasks {
  private readonly owners = new Map<string, string>();
  private readonly sources = new Map<string, CommandRuntime>();
  private readonly finished = new Set<string>();
  private readonly listeners = new Set<(event: BackgroundTaskEvent) => void>();
  constructor(
    private readonly options: {
      runtime: () => CommandRuntime;
      history?: BackgroundTaskHistory;
      currentSession: () => string | undefined;
      redact: (text: string) => string;
      deliver: (parentSessionId: string, text: string) => 'steered' | 'queued';
    },
  ) {}

  observe(listener: (event: BackgroundTaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  accept(event: BackgroundTaskEvent, sourceRuntime?: CommandRuntime): void {
    if (this.finished.has(event.task.id)) return;
    const existingSource = this.sources.get(event.task.id);
    if (sourceRuntime && existingSource && sourceRuntime !== existingSource) return;
    const parentSessionId = this.owners.get(event.task.id) ?? event.parentSessionId ?? this.options.currentSession();
    if (!parentSessionId) return;
    this.owners.set(event.task.id, parentSessionId);
    this.sources.set(event.task.id, existingSource ?? sourceRuntime ?? this.options.runtime());
    const task = {
      ...event.task,
      description: this.options.redact(event.task.description).slice(0, 1024),
      outputTail: this.options.redact(event.task.outputTail).slice(-8192),
    };
    this.options.history?.save(parentSessionId, task);
    // Never expose a completion notice until its input is durable or accepted by the running turn.
    const delivery =
      event.type === 'task.finished'
        ? this.options.deliver(
            parentSessionId,
            `<task-notification>\nBackground command ${JSON.stringify(task.description)} ${task.status === 'done' ? 'completed' : task.status}${task.exitCode === undefined ? '' : ` (exit code ${task.exitCode})`}\n${JSON.stringify(task)}\n</task-notification>`,
          )
        : undefined;
    if (event.type === 'task.finished') {
      this.finished.add(event.task.id);
      if (this.finished.size > 200) {
        const oldest = this.finished.values().next().value!;
        this.finished.delete(oldest);
        this.owners.delete(oldest);
        this.sources.delete(oldest);
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener({...event, task, parentSessionId, ...(delivery ? {delivery} : {})});
      } catch {
        /* observers cannot break completion */
      }
    }
  }

  list(sessionId: string): BackgroundTask[] {
    const tasks = new Map<string, BackgroundTask>();
    for (const task of this.options.history?.list(sessionId) ?? []) {
      tasks.set(task.id, {
        ...task,
        // A durable snapshot proves history, never liveness or authority to stop a process.
        status: task.status === 'running' ? 'stopped' : task.status,
        description: this.options.redact(task.description).slice(0, 1024),
        outputTail: this.options.redact(task.outputTail).slice(-8192),
      });
    }
    for (const source of new Set(this.sources.values())) {
      for (const task of source.backgroundTasks?.() ?? []) {
        if (this.owners.get(task.id) !== sessionId || this.sources.get(task.id) !== source) continue;
        if (this.finished.has(task.id) && tasks.has(task.id)) continue;
        tasks.set(task.id, {
          ...task,
          description: this.options.redact(task.description).slice(0, 1024),
          outputTail: this.options.redact(task.outputTail).slice(-8192),
        });
      }
    }
    return [...tasks.values()];
  }

  stop(id: string, sessionId: string): Promise<boolean> {
    if (this.finished.has(id) || this.owners.get(id) !== sessionId) return Promise.resolve(false);
    const source = this.sources.get(id);
    const live = source?.backgroundTasks?.().find(task => task.id === id);
    return live?.status === 'running'
      ? (source?.stopBackgroundTask?.(id) ?? Promise.resolve(false))
      : Promise.resolve(false);
  }

  background(sessionId: string) {
    if (this.options.currentSession() !== sessionId) return undefined;
    return this.options.runtime().backgroundCurrentTask?.(sessionId);
  }
}
