import {
  AUTOMATION_LIMITS,
  FutrynError,
  formatDurationMs,
  parseDurationMs,
  parseLoopCommand,
  parseScheduleCommand,
  type AutomationParseOptions,
  type ParsedAutomationCommand,
  type ScheduledJobEvent,
  type ScheduledJobSpec,
  type ScheduledJobStatus,
  type ScheduledJobView,
} from '@cosmew/contracts';

export {
  formatDurationMs,
  parseDurationMs,
  parseLoopCommand,
  parseScheduleCommand,
  type AutomationParseOptions,
  type ParsedAutomationCommand,
};

const BUSY_RECHECK_MS = 1_000;

export interface SessionSchedulerOptions {
  /** Return true when the session currently has an active turn or pending interaction prompt. */
  isBusy(sessionId: string): boolean;
  /** Execute one scheduled iteration on the session; returns last response text and incremental USD cost. */
  execute(job: ScheduledJobView, iteration: number, signal: AbortSignal): Promise<{text?: string; costUSD?: number}>;
  /** Optional cumulative cost reader for budget enforcement across turns. */
  getSessionCostUSD?(sessionId: string): number;
  onEvent?(event: ScheduledJobEvent): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  minIntervalMs?: number;
  busyRecheckMs?: number;
}

interface InternalJob {
  id: string;
  sessionId: string;
  spec: ScheduledJobSpec;
  status: ScheduledJobStatus;
  completedIterations: number;
  consecutiveErrors: number;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  stopReason?: string;
  baselineCostUSD: number;
  cumulativeCostUSD: number;
  timer?: unknown;
  abortController: AbortController;
  waitingForIdle: boolean;
}

/**
 * In-session autonomous loop and recurring scheduler (ADR 0125).
 * Enforces hard iteration/cost/error caps, zero re-entrancy while busy, and clean cancellation on stop/Esc/close.
 */
export class SessionScheduler {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly listeners = new Set<(event: ScheduledJobEvent) => void>();
  private nextId = 1;
  private closed = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly minIntervalMs: number;
  private readonly busyRecheckMs: number;

  constructor(private readonly options: SessionSchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.minIntervalMs = options.minIntervalMs ?? AUTOMATION_LIMITS.minIntervalMs;
    this.busyRecheckMs = options.busyRecheckMs ?? BUSY_RECHECK_MS;
  }

  observe(listener: (event: ScheduledJobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private toView(job: InternalJob): ScheduledJobView {
    return {
      id: job.id,
      sessionId: job.sessionId,
      kind: job.spec.kind,
      prompt: job.spec.prompt,
      intervalMs: job.spec.intervalMs,
      maxIterations: job.spec.maxIterations,
      completedIterations: job.completedIterations,
      consecutiveErrors: job.consecutiveErrors,
      ...(job.spec.maxEstimatedCostUSD !== undefined ? {maxEstimatedCostUSD: job.spec.maxEstimatedCostUSD} : {}),
      ...(job.spec.untilSubstring !== undefined ? {untilSubstring: job.spec.untilSubstring} : {}),
      ...(job.spec.oneShot ? {oneShot: true} : {}),
      status: job.status,
      createdAt: job.createdAt,
      ...(job.lastRunAt ? {lastRunAt: job.lastRunAt} : {}),
      ...(job.nextRunAt ? {nextRunAt: job.nextRunAt} : {}),
      ...(job.stopReason ? {stopReason: job.stopReason} : {}),
    };
  }

  private emit(type: ScheduledJobEvent['type'], job: InternalJob, message?: string): void {
    const event: ScheduledJobEvent = {type, job: this.toView(job), ...(message ? {message} : {})};
    try {
      this.options.onEvent?.(event);
    } catch {
      /* observers cannot break scheduler */
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* observers cannot break scheduler */
      }
    }
  }

  private clearJobTimer(job: InternalJob): void {
    if (job.timer !== undefined) {
      this.clearTimer(job.timer);
      job.timer = undefined;
    }
  }

  private isTerminal(status: ScheduledJobStatus): boolean {
    return status !== 'active' && status !== 'running';
  }

  start(sessionId: string, spec: ScheduledJobSpec): ScheduledJobView {
    if (this.closed) throw new FutrynError('UNSUPPORTED');
    if (!sessionId || !spec.prompt.trim() || spec.prompt.length > AUTOMATION_LIMITS.maxPromptChars) {
      throw new FutrynError('INVALID_INPUT');
    }
    if (
      !Number.isFinite(spec.intervalMs) ||
      spec.intervalMs < this.minIntervalMs ||
      spec.intervalMs > AUTOMATION_LIMITS.maxIntervalMs
    ) {
      throw new FutrynError('INVALID_INPUT');
    }
    if (
      !Number.isInteger(spec.maxIterations) ||
      spec.maxIterations < 1 ||
      spec.maxIterations > AUTOMATION_LIMITS.maxIterationsCap
    ) {
      throw new FutrynError('INVALID_INPUT');
    }
    if (
      spec.maxEstimatedCostUSD !== undefined &&
      (!Number.isFinite(spec.maxEstimatedCostUSD) || spec.maxEstimatedCostUSD <= 0)
    ) {
      throw new FutrynError('INVALID_INPUT');
    }

    const activeForSession = [...this.jobs.values()].filter(
      j => j.sessionId === sessionId && !this.isTerminal(j.status),
    );
    if (activeForSession.length >= AUTOMATION_LIMITS.maxJobsPerSession) {
      throw new FutrynError('POLICY');
    }

    const prefix = spec.kind === 'loop' ? 'loop' : 'sched';
    const id = `${prefix}-${this.nextId++}`;
    const baselineCostUSD = this.options.getSessionCostUSD?.(sessionId) ?? 0;
    const job: InternalJob = {
      id,
      sessionId,
      spec: {...spec, prompt: spec.prompt.trim()},
      status: 'active',
      completedIterations: 0,
      consecutiveErrors: 0,
      createdAt: new Date(this.now()).toISOString(),
      baselineCostUSD,
      cumulativeCostUSD: 0,
      abortController: new AbortController(),
      waitingForIdle: false,
    };
    this.jobs.set(id, job);
    this.scheduleNext(job, spec.runImmediately ? 0 : spec.intervalMs);
    this.emit('scheduled.started', job);
    return this.toView(job);
  }

  list(sessionId?: string): ScheduledJobView[] {
    const out: ScheduledJobView[] = [];
    for (const job of this.jobs.values()) {
      if (sessionId && job.sessionId !== sessionId) continue;
      out.push(this.toView(job));
    }
    return out;
  }

  activeCount(sessionId?: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (sessionId && job.sessionId !== sessionId) continue;
      if (!this.isTerminal(job.status)) count++;
    }
    return count;
  }

  stop(idOrAll: string, sessionId?: string, reason = 'Stopped by user'): ScheduledJobView[] {
    const stopped: ScheduledJobView[] = [];
    for (const job of this.jobs.values()) {
      if (sessionId && job.sessionId !== sessionId) continue;
      if (idOrAll !== 'all' && job.id !== idOrAll) continue;
      if (this.isTerminal(job.status)) continue;
      this.clearJobTimer(job);
      job.waitingForIdle = false;
      job.status = 'stopped';
      job.nextRunAt = undefined;
      job.stopReason = reason;
      job.abortController.abort();
      stopped.push(this.toView(job));
      this.emit('scheduled.stopped', job, reason);
    }
    return stopped;
  }

  stopForSession(sessionId: string, reason = 'Session closed or switched'): ScheduledJobView[] {
    return this.stop('all', sessionId, reason);
  }

  /** Trigger any active job waiting on a busy session to re-evaluate immediately once the turn settles. */
  notifyIdle(sessionId: string): void {
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (job.sessionId !== sessionId || job.status !== 'active' || !job.waitingForIdle) continue;
      this.clearJobTimer(job);
      job.waitingForIdle = false;
      void this.tick(job);
      break;
    }
  }

  shutdown(): void {
    this.closed = true;
    this.stop('all', undefined, 'Scheduler shutdown');
  }

  private scheduleNext(job: InternalJob, delayMs: number): void {
    if (this.closed || this.isTerminal(job.status)) return;
    this.clearJobTimer(job);
    job.nextRunAt = new Date(this.now() + Math.max(0, delayMs)).toISOString();
    job.timer = this.setTimer(
      () => {
        job.timer = undefined;
        void this.tick(job);
      },
      Math.max(0, delayMs),
    );
  }

  private budgetExceeded(job: InternalJob): boolean {
    if (job.spec.maxEstimatedCostUSD === undefined) return false;
    const sessionDelta =
      this.options.getSessionCostUSD !== undefined
        ? Math.max(0, this.options.getSessionCostUSD(job.sessionId) - job.baselineCostUSD)
        : 0;
    const spent = Math.max(job.cumulativeCostUSD, sessionDelta);
    return spent >= job.spec.maxEstimatedCostUSD;
  }

  private async tick(job: InternalJob): Promise<void> {
    if (this.closed || this.isTerminal(job.status)) return;
    if (this.budgetExceeded(job)) {
      job.status = 'budget_exceeded';
      job.nextRunAt = undefined;
      job.stopReason = `Cost cap $${job.spec.maxEstimatedCostUSD!.toFixed(4)} reached.`;
      this.emit('scheduled.completed', job, job.stopReason);
      return;
    }
    if (this.options.isBusy(job.sessionId)) {
      job.waitingForIdle = true;
      this.scheduleNext(job, this.busyRecheckMs);
      return;
    }

    job.waitingForIdle = false;
    job.status = 'running';
    job.nextRunAt = undefined;
    const iteration = job.completedIterations + 1;
    job.lastRunAt = new Date(this.now()).toISOString();
    this.emit('scheduled.tick', job, `Running iteration ${iteration}/${job.spec.maxIterations}`);

    try {
      const outcome = await this.options.execute(this.toView(job), iteration, job.abortController.signal);
      if (this.closed || job.abortController.signal.aborted || (job.status as ScheduledJobStatus) === 'stopped') return;

      job.completedIterations = iteration;
      job.consecutiveErrors = 0;
      if (typeof outcome.costUSD === 'number' && Number.isFinite(outcome.costUSD) && outcome.costUSD > 0) {
        job.cumulativeCostUSD += outcome.costUSD;
      }

      if (
        job.spec.untilSubstring &&
        typeof outcome.text === 'string' &&
        outcome.text.includes(job.spec.untilSubstring)
      ) {
        job.status = 'completed';
        job.stopReason = `Matched stop condition "${job.spec.untilSubstring}".`;
        this.emit('scheduled.completed', job, job.stopReason);
        return;
      }

      if (this.budgetExceeded(job)) {
        job.status = 'budget_exceeded';
        job.stopReason = `Cost cap $${job.spec.maxEstimatedCostUSD!.toFixed(4)} reached.`;
        this.emit('scheduled.completed', job, job.stopReason);
        return;
      }

      if (job.completedIterations >= job.spec.maxIterations) {
        job.status = 'completed';
        job.stopReason = `Completed ${job.completedIterations}/${job.spec.maxIterations} iterations.`;
        this.emit('scheduled.completed', job, job.stopReason);
        return;
      }

      job.status = 'active';
      this.scheduleNext(job, job.spec.intervalMs);
    } catch (error) {
      if (this.closed || job.abortController.signal.aborted || (job.status as ScheduledJobStatus) === 'stopped') return;
      if (error instanceof FutrynError && error.code === 'CANCELLED') {
        job.status = 'stopped';
        job.stopReason = 'Cancelled by user.';
        this.emit('scheduled.stopped', job, job.stopReason);
        return;
      }
      job.consecutiveErrors += 1;
      const reason = error instanceof Error && error.message ? error.message.slice(0, 160) : 'Scheduled turn failed';
      if (job.consecutiveErrors >= AUTOMATION_LIMITS.maxConsecutiveErrors) {
        job.status = 'failed';
        job.stopReason = `Stopped after ${job.consecutiveErrors} consecutive errors: ${reason}`;
        this.emit('scheduled.failed', job, job.stopReason);
        return;
      }
      job.status = 'active';
      this.scheduleNext(job, job.spec.intervalMs);
    }
  }
}
