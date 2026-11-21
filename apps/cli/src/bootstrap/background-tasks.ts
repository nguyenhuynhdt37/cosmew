import type {BackgroundTaskEvent, CommandRuntime} from '@cosmew/contracts';

/** Session ownership and completion delivery for existing unified-exec sessions (ADR 0070). */
export class BackgroundTasks {
  private readonly owners = new Map<string, string>();
  private readonly finished = new Set<string>();
  private readonly listeners = new Set<(event: BackgroundTaskEvent) => void>();
  constructor(
    private readonly options: {
      runtime: () => CommandRuntime;
      currentSession: () => string | undefined;
      redact: (text: string) => string;
      deliver: (parentSessionId: string, text: string) => 'steered' | 'queued';
    },
  ) {}

  observe(listener: (event: BackgroundTaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  accept(event: BackgroundTaskEvent): void {
    if (this.finished.has(event.task.id)) return;
    const parentSessionId = this.owners.get(event.task.id) ?? event.parentSessionId ?? this.options.currentSession();
    if (!parentSessionId) return;
    this.owners.set(event.task.id, parentSessionId);
    const task = {
      ...event.task,
      description: this.options.redact(event.task.description).slice(0, 1024),
      outputTail: this.options.redact(event.task.outputTail).slice(-8192),
    };
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

  list(sessionId: string) {
    return (
      this.options
        .runtime()
        .backgroundTasks?.()
        .filter(task => this.owners.get(task.id) === sessionId)
        .map(task => ({
          ...task,
          description: this.options.redact(task.description).slice(0, 1024),
          outputTail: this.options.redact(task.outputTail).slice(-8192),
        })) ?? []
    );
  }

  stop(id: string, sessionId: string): Promise<boolean> {
    return this.owners.get(id) === sessionId
      ? (this.options.runtime().stopBackgroundTask?.(id) ?? Promise.resolve(false))
      : Promise.resolve(false);
  }

  background(sessionId: string) {
    if (this.options.currentSession() !== sessionId) return undefined;
    return this.options.runtime().backgroundCurrentTask?.(sessionId);
  }
}
