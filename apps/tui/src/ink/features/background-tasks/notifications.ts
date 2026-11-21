import type {BackgroundTaskEvent, FutrynClient} from '@cosmew/sdk';
import {safeText} from '../../ui';

type SubagentNotice = Parameters<Parameters<FutrynClient['onSubagentNotice']>[0]>[0];
export interface TaskNotification {
  id: string;
  text: string;
}

/** One terminal notice per task, shared by SDK task projections and child notices. */
export class TaskNotifications {
  private sessionId: string | undefined;
  private readonly seen = new Set<string>();

  reset(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.seen.clear();
  }

  private take(
    activeSessionId: string | undefined,
    owner: string | undefined,
    kind: string,
    id: string,
  ): string | undefined {
    if (this.sessionId !== activeSessionId) this.reset(activeSessionId);
    // Missing attribution cannot prove ownership. Late events from an old session stay invisible.
    if (!activeSessionId || owner !== activeSessionId) return;
    const key = `${kind}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    return `background:${activeSessionId}:${key}`;
  }

  background(activeSessionId: string | undefined, event: BackgroundTaskEvent): TaskNotification | undefined {
    if (event.type === 'task.started' && activeSessionId && event.parentSessionId === activeSessionId) {
      if (this.sessionId !== activeSessionId) this.reset(activeSessionId);
      this.seen.delete(`${event.task.kind}:${event.task.id}`);
      return;
    }
    // Foreground child completion is already rendered with its tool result. No delivery = no out-of-turn notice.
    if (event.type !== 'task.finished' || !event.delivery || event.task.status === 'running') return;
    const task = event.task;
    const id = this.take(activeSessionId, event.parentSessionId, task.kind, task.id);
    if (!id) return;
    const status = task.status === 'done' ? 'completed' : task.status === 'stopped' ? 'cancelled/stopped' : 'failed';
    return {
      id,
      text: safeText(
        `${task.kind === 'agent' ? 'Agent' : 'Background command'} "${task.description}" [${task.id}] ${status}${task.exitCode === undefined ? '' : ` (exit code ${task.exitCode})`}. Open /tasks → ${task.id}.`,
      ),
    };
  }

  subagent(activeSessionId: string | undefined, notice: SubagentNotice): TaskNotification | undefined {
    if (notice.delivery === 'consumed') return;
    const id = this.take(activeSessionId, notice.parentSessionId, 'agent', notice.agentId);
    if (!id) return;
    return {
      id,
      text: safeText(
        `Agent ${notice.agentType} "${notice.description}" [${notice.agentId}] ${notice.status}. Open /tasks → ${notice.agentId}.`,
      ),
    };
  }
}
