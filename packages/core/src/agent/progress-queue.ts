import type {CommandOutputChunk, ModelEvent, SubagentEvent, ToolCall} from '@cosmew/contracts';

/** Bounds on live command output buffered between the tool and the event stream. */
const MAX_QUEUED_EVENTS = 128;
const MAX_QUEUED_BYTES = 64000;

/**
 * Live progress of running tools (command output and subagent lifecycle/progress), yielded between
 * model events and tool results. Command output is bounded: beyond the limits, deltas are dropped
 * from the live stream only; the final tool result still carries the bounded output.
 */
export class ProgressQueue {
  private readonly events: ModelEvent[] = [];
  private queuedBytes = 0;
  private waiter?: () => void;

  get size(): number {
    return this.events.length;
  }

  publish(call: ToolCall, chunk: CommandOutputChunk): void {
    const bytes = Buffer.byteLength(chunk.text);
    if (this.queuedBytes + bytes > MAX_QUEUED_BYTES || this.events.length >= MAX_QUEUED_EVENTS) return;
    this.events.push({type: 'toolOutputDelta', callId: call.id, name: call.name, ...chunk});
    this.queuedBytes += bytes;
    this.wake();
  }

  publishSubagent(event: SubagentEvent): void {
    if (event.type === 'subagent.progress') {
      const existingIndex = this.events.findIndex(
        queued => queued.type === 'subagent.progress' && queued.callId === event.callId,
      );
      if (existingIndex >= 0) {
        this.events[existingIndex] = event;
        this.wake();
        return;
      }
      if (this.events.length >= MAX_QUEUED_EVENTS) return;
    }
    this.events.push(event);
    this.wake();
  }

  take(): ModelEvent {
    const next = this.events.shift()!;
    if (next.type === 'toolOutputDelta') this.queuedBytes -= Buffer.byteLength(next.text);
    return next;
  }

  /** Resolves when an event is queued or `wake()` is called. Only the latest waiter is woken. */
  ready(): Promise<undefined> {
    return new Promise(resolve => {
      this.waiter = () => resolve(undefined);
      if (this.events.length) resolve(undefined);
    });
  }

  wake(): void {
    this.waiter?.();
  }

  clearWaiter(): void {
    this.waiter = undefined;
  }
}
