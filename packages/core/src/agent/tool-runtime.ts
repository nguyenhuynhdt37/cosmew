import {FutrynError} from '@futryn/contracts';

/**
 * Port of Codex `tools/parallel.rs` `ToolCallRuntime::parallel_execution` (an `RwLock<()>`, pinned
 * reference openai/codex@710bee73a89385aaf2afb41d885edf82473d941f): a tool whose registration declares
 * `supports_parallel_tool_calls` takes the lock shared, every other tool takes it exclusively. Tokio's
 * RwLock is fair (FIFO), so a parallel call requested after a waiting exclusive call waits behind it;
 * this gate keeps that order. `maxShared` is Futryn's resource bound on concurrent shared holders.
 *
 * The gate only orders execution. Policy, approval and path checks stay in the injected ToolPort, so a
 * call that holds the gate still passes the whole permission pipeline.
 */
export class ExecutionGate {
  private shared = 0;
  private exclusive = false;
  private readonly queue: {exclusive: boolean; grant: () => void}[] = [];
  constructor(private readonly maxShared: number) {}

  /** Resolves with a release function; rejects with CANCELLED if `signal` aborts while queued. */
  acquire(exclusive: boolean, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new FutrynError('CANCELLED'));
        return;
      }
      const abort = () => {
        const at = this.queue.indexOf(waiter);
        if (at < 0) return;
        this.queue.splice(at, 1);
        reject(new FutrynError('CANCELLED'));
        this.pump();
      };
      const waiter = {
        exclusive,
        grant: () => {
          signal?.removeEventListener('abort', abort);
          resolve(this.releaser(exclusive));
        },
      };
      signal?.addEventListener('abort', abort, {once: true});
      this.queue.push(waiter);
      this.pump();
    });
  }

  private fits(exclusive: boolean): boolean {
    return exclusive ? !this.exclusive && this.shared === 0 : !this.exclusive && this.shared < this.maxShared;
  }

  private pump(): void {
    while (this.queue.length && this.fits(this.queue[0]!.exclusive)) {
      const next = this.queue.shift()!;
      if (next.exclusive) this.exclusive = true;
      else this.shared++;
      next.grant();
    }
  }

  private releaser(exclusive: boolean): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive) this.exclusive = false;
      else this.shared--;
      this.pump();
    };
  }
}
