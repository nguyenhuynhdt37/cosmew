import {render as testingRender} from 'ink-testing-library';

export interface FrameView {
  lastFrame(): string | undefined;
  readonly frames: readonly string[];
}
const views = new Set<WeakRef<FrameView>>();

/** Also used by the fullscreen stream harness, which renders without ink-testing-library. */
export function trackFrames<T extends FrameView>(view: T): T {
  views.add(new WeakRef(view));
  return view;
}
export const render: typeof testingRender = tree => trackFrames(testingRender(tree));

function snapshot() {
  const frames: (readonly [FrameView, string | undefined, number])[] = [];
  for (const ref of views) {
    const view = ref.deref();
    if (view) frames.push([view, view.lastFrame(), view.frames.length]);
    else views.delete(ref);
  }
  return frames;
}

const pollMs = 15;
const quietPolls = 3;
const defaultTimeoutMs = 2000;

/** Yield a timer turn and drain queued promise continuations / React passive effects. */
async function poll(ms: number) {
  await Bun.sleep(ms);
  await Promise.resolve();
}

/**
 * Wait for three quiet polls of every mounted test view, including identical-text repaints.
 * `ms` is a minimum wait; timeoutMs bounds continuously changing views (e.g. spinners).
 * This observes queued work through its paints, not arbitrary unresolved promises or long-lived
 * application timers. Use waitForFrame for a particular asynchronous result, even after a quiet frame.
 */
export async function settle(ms = 0, timeoutMs = defaultTimeoutMs): Promise<void> {
  const start = performance.now();
  let previous = snapshot();
  let quiet = 0;
  let quietSince = start;
  while (performance.now() - start < timeoutMs) {
    await poll(Math.min(pollMs, Math.max(0, timeoutMs - (performance.now() - start))));
    const current = snapshot();
    const unchanged =
      current.length === previous.length &&
      current.every((frame, i) => frame.every((value, j) => value === previous[i]?.[j]));
    const now = performance.now();
    quiet = unchanged ? quiet + 1 : 0;
    if (!unchanged) quietSince = now;
    previous = current;
    // A final, shortened deadline poll must not count as a full quiet period.
    if (quiet >= quietPolls && now - quietSince >= quietPolls * pollMs && now - start >= ms) return;
  }
  throw new Error(`Ink did not settle within ${timeoutMs}ms; last frame:\n${previous.at(-1)?.[1] ?? ''}`);
}

/** Wait for a specific current frame, with the last observed frame in timeout diagnostics. */
export async function waitForFrame(
  view: Pick<FrameView, 'lastFrame'>,
  predicate: (frame: string) => boolean,
  timeoutMs = defaultTimeoutMs,
): Promise<string> {
  const start = performance.now();
  while (true) {
    const frame = view.lastFrame() ?? '';
    if (predicate(frame)) return frame;
    if (performance.now() - start >= timeoutMs)
      throw new Error(`Timed out waiting for Ink frame after ${timeoutMs}ms (${predicate}); last frame:\n${frame}`);
    await poll(Math.min(pollMs, Math.max(0, timeoutMs - (performance.now() - start))));
  }
}
