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
export const render: typeof testingRender = tree => {
  const view = trackFrames(testingRender(tree));
  const write = view.stdin.write.bind(view.stdin);
  view.stdin.write = keys => {
    write(keys);
    noteInput(keys);
  };
  return view;
};

function snapshot() {
  const frames: (readonly [FrameView, string | undefined, number])[] = [];
  for (const ref of views) {
    const view = ref.deref();
    if (view) frames.push([view, view.lastFrame(), view.frames.length]);
    else views.delete(ref);
  }
  return frames;
}

const quietTurns = 3;
const defaultTimeoutMs = 2000;
let pendingEscape: ReturnType<typeof setTimeout> | undefined;

/** Bare Escape is buffered by Ink for 20ms, plus 10ms through the terminal mouse filter. */
export function noteInput(keys: string, throughMouse = false): void {
  if (keys !== '\x1b') return;
  clearTimeout(pendingEscape);
  pendingEscape = setTimeout(
    () => {
      pendingEscape = undefined;
    },
    throughMouse ? 35 : 25,
  );
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(() => queueMicrotask(resolve)));
}

/**
 * Drain queued effects and promise work until frame text and paint counts stabilize.
 * Use a timed quiet window for fixtures with deliberate timers or out-of-process rendering.
 * Use waitForFrame for an asynchronous result with a known visible condition.
 */
export async function settle(ms = 0, timeoutMs = defaultTimeoutMs, {quietMs = 0} = {}): Promise<void> {
  const start = performance.now();
  let previous = snapshot();
  let quiet = 0;
  let quietSince = start;
  while (performance.now() - start < timeoutMs) {
    const now = performance.now();
    const readyAt = Math.max(start + ms, quietSince + quietMs);
    if (quiet >= quietTurns && (pendingEscape || readyAt > now)) {
      await Bun.sleep(Math.min(5, pendingEscape ? 5 : readyAt - now, timeoutMs - (now - start)));
    }
    await nextTurn();
    const current = snapshot();
    const unchanged =
      current.length === previous.length &&
      current.every((frame, i) => frame.every((value, j) => value === previous[i]?.[j]));
    const paintedAt = performance.now();
    quiet = unchanged ? quiet + 1 : 0;
    if (!unchanged) quietSince = paintedAt;
    previous = current;
    if (quiet >= quietTurns && !pendingEscape && paintedAt >= Math.max(start + ms, quietSince + quietMs)) return;
  }
  throw new Error(`Ink did not settle within ${timeoutMs}ms; last frame:\n${previous.at(-1)?.[1] ?? ''}`);
}

/** Check immediately, then give queued work a few turns before polling for slower external work. */
export async function waitForCondition<T>(check: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs;
  for (let turn = 0; ; turn++) {
    const result = check();
    if (result !== undefined) return result;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return undefined;
    if (turn >= quietTurns) await Bun.sleep(Math.min(5, remaining));
    await nextTurn();
  }
}

/** Wait for a specific current frame, with the last observed frame in timeout diagnostics. */
export async function waitForFrame(
  view: Pick<FrameView, 'lastFrame'>,
  predicate: (frame: string) => boolean,
  timeoutMs = defaultTimeoutMs,
): Promise<string> {
  let frame = '';
  const result = await waitForCondition(() => {
    frame = view.lastFrame() ?? '';
    return predicate(frame) ? frame : undefined;
  }, timeoutMs);
  if (result !== undefined) return result;
  throw new Error(`Timed out waiting for Ink frame after ${timeoutMs}ms (${predicate}); last frame:\n${frame}`);
}
