import type {CommandOutputChunk, ModelEvent, ToolCall} from '@futryn/contracts';

/** Bounds on live command output buffered between the tool and the event stream. */
const MAX_QUEUED_EVENTS = 128;
const MAX_QUEUED_BYTES = 64000;

/**
 * Live progress of running tools (command output), yielded between model events and tool results.
 * It is bounded: beyond the limits, deltas are dropped from the live stream only; the final tool
 * result still carries the bounded output.
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
