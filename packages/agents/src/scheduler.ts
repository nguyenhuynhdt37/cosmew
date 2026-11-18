import {
  DEFAULT_AGENT_MAX_THREADS,
  type SubagentStatus,
  type SubagentTranscriptStep,
  type SubagentType,
  type Usage,
} from '@futryn/contracts';

export interface ActiveSubagentTask {
  agentId: string;
  parentConversationId: string;
  parentTurnId: string | null;
  callId: string;
  depth: number;
  agentType: SubagentType;
  description: string;
  modelId: string;
  reasoningEffort?: string;
  forkContext: boolean;
  background: boolean;
  status: SubagentStatus;
  startedAt: number;
  finishedAt?: number;
  toolCount: number;
  currentTool?: string;
  usage: Usage | null;
  steps: SubagentTranscriptStep[];
  abortController: AbortController;
}

export interface SlotReservation {
  release(): void;
}

/**
 * Concurrency limiter and live registry for subagent threads (ported from Codex
 * `AgentRegistry::reserve_spawn_slot` in `codex-rs/core/src/agent/registry.rs`).
 *
 * Up to `maxThreads` subagents may hold active slots simultaneously. Attempting to spawn a
 * `maxThreads + 1`-th concurrent subagent fails with `AGENT_LIMIT_REACHED` (Codex
 * `AgentLimitReached { max_threads }`). Releasing a slot is idempotent and guaranteed on exit.
 */
export class SubagentScheduler {
  private active = 0;
  private readonly liveTasks = new Map<string, ActiveSubagentTask>();
  private readonly getMaxThreads: () => number;

  constructor(maxThreads: number | (() => number) = DEFAULT_AGENT_MAX_THREADS) {
    this.getMaxThreads = typeof maxThreads === 'function' ? maxThreads : () => maxThreads;
  }

  activeThreads(): number {
    return this.active;
  }

  activeCount(): number {
    return this.active;
  }

  maxThreads(): number {
    return Math.max(1, this.getMaxThreads());
  }

  tryReserveSlot(): {ok: true; reservation: SlotReservation} | {ok: false; maxThreads: number; active: number} {
    const limit = this.maxThreads();
    if (this.active >= limit) {
      return {ok: false, maxThreads: limit, active: this.active};
    }
    this.active++;
    let released = false;
    return {
      ok: true,
      reservation: {
        release: () => {
          if (released) return;
          released = true;
          this.active = Math.max(0, this.active - 1);
        },
      },
    };
  }

  registerTask(task: ActiveSubagentTask): void {
    this.liveTasks.set(task.agentId, task);
  }

  getTask(agentId: string): ActiveSubagentTask | undefined {
    return this.liveTasks.get(agentId);
  }

  listTasks(parentConversationId?: string): ActiveSubagentTask[] {
    const all = [...this.liveTasks.values()];
    return parentConversationId ? all.filter(t => t.parentConversationId === parentConversationId) : all;
  }

  removeTask(agentId: string): void {
    this.liveTasks.delete(agentId);
  }

  /** Cancel all live subagents owned by a specific parent turn or parent conversation. */
  cancelForParent(parentConversationId: string, parentTurnId?: string): void {
    for (const task of this.liveTasks.values()) {
      if (task.parentConversationId !== parentConversationId) continue;
      if (parentTurnId !== undefined && task.parentTurnId !== parentTurnId) continue;
      task.abortController.abort();
    }
  }

  cancelAll(): void {
    for (const task of this.liveTasks.values()) {
      task.abortController.abort();
    }
    this.liveTasks.clear();
  }
}
