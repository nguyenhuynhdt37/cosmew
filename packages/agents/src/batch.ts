import {
  AUTOMATION_LIMITS,
  FutrynError,
  combineUsage,
  parseBatchCommand,
  type BatchRunRequest,
  type BatchRunResult,
  type BatchTaskItemView,
  type ParsedBatchCommand,
  type SubagentEvent,
  type SubagentExecutionPort,
  type Usage,
} from '@cosmew/contracts';

export {parseBatchCommand, type ParsedBatchCommand};

export interface BatchRunnerDeps {
  subagents: SubagentExecutionPort;
  maxThreads(): number;
  isAnalysisOnly(): boolean;
  redact(text: string): string;
}

/**
 * Parallel fan-out runner built directly on top of `SubagentExecutionPort` (ADR 0125).
 * Enforces concurrency caps, read-only `plan` mode invariants, optional Git worktree isolation, and clean cancellation.
 */
export class BatchRunner {
  constructor(private readonly deps: BatchRunnerDeps) {}

  async run(
    request: BatchRunRequest,
    options?: {
      signal?: AbortSignal;
      onProgress?: (items: readonly BatchTaskItemView[]) => void;
    },
  ): Promise<BatchRunResult> {
    if (!request.items.length || request.items.length > AUTOMATION_LIMITS.maxBatchItems) {
      throw new FutrynError('INVALID_INPUT');
    }
    if (this.deps.subagents.available && !this.deps.subagents.available()) {
      throw new FutrynError('UNSUPPORTED');
    }
    const analysisOnly = this.deps.isAnalysisOnly();
    const wantsWorktree = request.isolation === 'worktree' || request.items.some(item => item.isolation === 'worktree');
    if (analysisOnly && wantsWorktree) {
      throw new FutrynError('POLICY');
    }

    const startedAt = Date.now();
    const maxSlots = Math.max(1, this.deps.maxThreads());
    const concurrency = Math.max(1, Math.min(request.concurrency ?? maxSlots, maxSlots, request.items.length));

    const views: BatchTaskItemView[] = request.items.map((item, index) => {
      const requestedType = item.agentType ?? request.agentType ?? (analysisOnly ? 'explore' : 'worker');
      const effectiveType =
        analysisOnly && requestedType !== 'explore' && requestedType !== 'plan' ? 'explore' : requestedType;
      const effectiveIsolation = item.isolation ?? request.isolation;
      return {
        index,
        label: this.deps.redact(item.label).slice(0, 120),
        agentType: effectiveType,
        ...(effectiveIsolation ? {isolation: effectiveIsolation} : {}),
        status: 'queued',
      };
    });

    const notify = () => {
      try {
        options?.onProgress?.(views.map(v => ({...v})));
      } catch {
        /* observer errors cannot break execution */
      }
    };
    notify();

    let nextIndex = 0;
    let totalUsage: Usage | null = null;
    const signal = options?.signal;

    const runWorker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) return;
        const current = nextIndex++;
        if (current >= request.items.length) return;
        const spec = request.items[current]!;
        const view = views[current]!;
        view.status = 'running';
        notify();

        const itemStartedAt = Date.now();
        const callId = `batch-${Date.now()}-${current + 1}`;
        let capturedAgentId: string | undefined;
        let capturedToolCount = 0;
        let capturedUsage: Usage | null = null;

        try {
          const outcome = await this.deps.subagents.run(
            callId,
            {
              agent_type: view.agentType,
              description: `Batch ${current + 1}/${request.items.length}: ${view.label}`.slice(0, 200),
              prompt: spec.prompt,
              background: false,
              ...(view.isolation ? {isolation: view.isolation} : {}),
            },
            signal,
            (event: SubagentEvent) => {
              capturedAgentId = event.agentId;
              if (event.type === 'subagent.progress' || event.type === 'subagent.finished') {
                capturedToolCount = event.toolCount;
                if (event.usage) capturedUsage = event.usage;
              }
            },
          );
          view.agentId = capturedAgentId;
          view.toolCount = capturedToolCount;
          view.durationMs = Date.now() - itemStartedAt;
          view.usage = capturedUsage;
          if (capturedUsage) {
            totalUsage = totalUsage ? combineUsage(totalUsage, capturedUsage) : capturedUsage;
          }
          if (outcome.status === 'ok') {
            view.status = 'completed';
            view.summary = this.deps.redact(outcome.content).slice(0, 2000);
          } else if (outcome.code === 'CANCELLED' || signal?.aborted) {
            view.status = 'cancelled';
            view.errorCode = 'CANCELLED';
            view.summary = this.deps.redact(outcome.content).slice(0, 500);
          } else {
            view.status = 'failed';
            view.errorCode = outcome.code ?? 'ERROR';
            view.summary = this.deps.redact(outcome.content).slice(0, 500);
          }
        } catch (error) {
          view.agentId = capturedAgentId;
          view.toolCount = capturedToolCount;
          view.durationMs = Date.now() - itemStartedAt;
          if (signal?.aborted || (error instanceof FutrynError && error.code === 'CANCELLED')) {
            view.status = 'cancelled';
            view.errorCode = 'CANCELLED';
          } else {
            view.status = 'failed';
            view.errorCode = error instanceof FutrynError ? error.code : 'ERROR';
            view.summary = this.deps.redact(error instanceof Error ? error.message : 'Batch task failed').slice(0, 500);
          }
        }
        notify();
      }
    };

    await Promise.all(Array.from({length: concurrency}, () => runWorker()));

    // Mark any unstarted queued items as cancelled if aborted mid-run.
    for (const view of views) {
      if (view.status === 'queued' || view.status === 'running') {
        view.status = 'cancelled';
        view.errorCode = 'CANCELLED';
      }
    }
    notify();

    const completedCount = views.filter(v => v.status === 'completed').length;
    const failedCount = views.filter(v => v.status === 'failed').length;
    const cancelledCount = views.filter(v => v.status === 'cancelled').length;
    const status: BatchRunResult['status'] =
      cancelledCount > 0 && completedCount === 0 && failedCount === 0
        ? 'cancelled'
        : completedCount === views.length
          ? 'completed'
          : completedCount > 0
            ? 'partial'
            : 'failed';

    const lines = [
      `Batch ${status}: ${completedCount}/${views.length} completed` +
        (failedCount ? `, ${failedCount} failed` : '') +
        (cancelledCount ? `, ${cancelledCount} cancelled` : '') +
        ` (${((Date.now() - startedAt) / 1000).toFixed(1)}s).`,
      ...views.map(item => {
        const iso = item.isolation ? ` · ${item.isolation}` : '';
        const err = item.errorCode ? ` [${item.errorCode}]` : '';
        const preview = item.summary ? ` — ${item.summary.replace(/\s+/g, ' ').slice(0, 180)}` : '';
        return `${item.index + 1}. [${item.status}] (${item.agentType}${iso}) ${item.label}${err}${preview}`;
      }),
    ];

    return {
      status,
      items: views,
      completedCount,
      failedCount,
      cancelledCount,
      usage: totalUsage,
      durationMs: Date.now() - startedAt,
      summary: lines.join('\n'),
    };
  }
}
