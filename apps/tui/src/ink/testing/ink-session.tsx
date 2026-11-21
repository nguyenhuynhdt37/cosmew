/** @jsxImportSource react */
import {render, settle, waitForCondition, waitForFrame} from './wait';
import type {FutrynClient} from '@cosmew/sdk';
import {InkApp} from '../app';
import {messagesToTranscript, type TranscriptItem} from '../features/transcript/logic';

export const ESC = '\x1b';
export const ENTER = '\r';
export const UP = '\x1b[A';
export const DOWN = '\x1b[B';
export const SHIFT_TAB = '\x1b[Z';
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface InkSessionOptions {
  width?: number;
  rows?: number;
  initialCommand?: string;
  /** Skip the consent dialog: false leaves the startup gate in front of the test. */
  consent?: boolean;
}
export interface InkSession {
  client: FutrynClient;
  /** Current Ink frame without ANSI. */
  frame(): string;
  /** Every frame rendered so far, joined (transcript rows scrolled into Static stay visible). */
  frames(): string;
  discardCapturedFrames(): void;
  pressToFrame(keys: string, predicate: (frame: string) => boolean): Promise<number>;
  press(keys: string): Promise<void>;
  type(text: string): Promise<void>;
  /** Types text, presses Enter, and resolves once no turn or slash command is running. */
  submit(text: string): Promise<void>;
  /** Resolves when the first predicate-matching frame appears. */
  waitFor(text: string | RegExp, ms?: number): Promise<string>;
  /** Waits for the next pending permission on the SDK client and returns it. */
  nextPermission(ms?: number): Promise<ReturnType<FutrynClient['listPendingPermissions']>[number]>;
  /** Waits until no `sendMessage` stream is open. */
  idle(ms?: number): Promise<void>;
  close(): Promise<void>;
  /** Stored conversation as transcript items (messages the model saw; failed requests are only in the frame). */
  getTranscript(): TranscriptItem[];
  /** Named key such as Escape, Enter, Ctrl+X, Shift+Tab or a literal character. */
  handleKey(name: string): Promise<void>;
  /** Types a prompt and Enter; resolves when the turn has finished (pending prompts must be answered meanwhile). */
  submitPrompt(text: string): Promise<void>;
  executeSlashCommand(text: string): Promise<void>;
  computeFrameSnapshot(): {plainText: string};
  advanceStartupGate(): void;
  shutdown(): Promise<void>;
}
const KEYS: Record<string, string> = {
  Escape: ESC,
  Enter: ENTER,
  Tab: '\t',
  'Shift+Tab': SHIFT_TAB,
  Up: UP,
  Down: DOWN,
  ArrowUp: UP,
  ArrowDown: DOWN,
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Backspace: '\x7f',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
};

/**
 * Mounts the real Ink TUI over a real SDK client (ink-testing-library; no PTY). The startup gate is driven
 * through its own dialog: Yes, I trust this folder. First-run coverage drives onboarding separately.
 */
export async function openInk(client: FutrynClient, options: InkSessionOptions = {}): Promise<InkSession> {
  for (const step of ['theme', 'auth', 'security']) client.completeOnboardingStep(step);
  let open = 0;
  let started = 0;
  const send = client.sendMessage.bind(client);
  client.sendMessage = ((...args: Parameters<typeof send>) => {
    const source = send(...args);
    return (async function* () {
      started++;
      open++;
      try {
        yield* source;
      } finally {
        open--;
      }
    })();
  }) as typeof client.sendMessage;
  let shutdown = async () => {};
  let closed = false;
  const view = render(
    <InkApp
      client={client}
      width={options.width ?? 110}
      rows={options.rows}
      initialCommand={options.initialCommand}
      registerShutdown={fn => {
        shutdown = fn;
      }}
    />,
  );
  if (options.rows !== undefined) {
    // The Ink test stream otherwise has no row count. Ink falls back to synchronous terminal-size
    // probes on every layout, even if InkApp has an explicit viewport height.
    Object.defineProperties(view.stdout, {
      rows: {value: options.rows},
      columns: {value: options.width ?? 110},
    });
  }
  const frame = () => (view.lastFrame() ?? '').replace(ANSI, '');
  const session: InkSession = {
    client,
    frame,
    frames: () => view.frames.join('\n').replace(ANSI, ''),
    discardCapturedFrames: () => {
      view.frames.splice(0, Math.max(0, view.frames.length - 1));
    },
    async pressToFrame(keys, predicate) {
      const start = performance.now();
      view.stdin.write(keys);
      await waitForFrame({lastFrame: frame}, predicate, 30000);
      return performance.now() - start;
    },
    async press(keys) {
      view.stdin.write(keys);
      await settle();
    },
    async type(text) {
      view.stdin.write(text);
      await settle();
    },
    async waitFor(text, ms = 8000) {
      const match = (s: string) => (typeof text === 'string' ? s.includes(text) : text.test(s));
      const result = await waitForCondition(() => {
        const now = frame();
        if (match(now)) return now;
        const all = session.frames();
        return match(all) ? all : undefined;
      }, ms);
      if (result !== undefined) return result;
      throw new Error(`Timed out waiting for ${String(text)}; last frame:\n${frame()}`);
    },
    async nextPermission(ms = 4000) {
      const pending = await waitForCondition(() => client.listPendingPermissions()[0], ms);
      if (!pending) throw new Error(`No permission request arrived; last frame:\n${frame()}`);
      await session.waitFor(
        pending.capability === 'settings.trust' ? 'No, skip this settings file' : 'Esc to cancel · Tab to amend',
        3000,
      );
      await settle();
      return pending;
    },
    async idle(ms = 15000) {
      await waitForCondition(() => (open === 0 ? true : undefined), ms);
      await settle();
      if (open > 0) throw new Error('A turn is still running');
    },
    async submit(text) {
      await session.type(text);
      await session.press(ENTER);
    },
    getTranscript: () => messagesToTranscript(client.activeSession()?.messages ?? []),
    async handleKey(name) {
      const ctrl = /^Ctrl\+([A-Za-z])$/.exec(name);
      await session.press(KEYS[name] ?? (ctrl ? String.fromCharCode(ctrl[1]!.toUpperCase().charCodeAt(0) - 64) : name));
    },
    async submitPrompt(text) {
      const previous = started;
      await session.submit(text);
      // A short turn can start and finish before submit() has drained its paints.
      await waitForCondition(() => (started !== previous || open > 0 ? true : undefined), 300);
      const ready = await waitForCondition(
        () =>
          open === 0 || client.listPendingPermissions().length || client.listPendingQuestions().length
            ? true
            : undefined,
        15000,
      );
      if (!ready) throw new Error(`A turn is still running; last frame:\n${frame()}`);
      await settle();
    },
    async executeSlashCommand(text) {
      await session.submit(text);
      await settle();
    },
    computeFrameSnapshot: () => ({plainText: frame()}),
    advanceStartupGate() {},
    shutdown: () => session.close(),
    async close() {
      // Idempotent: a second unmount frees the Yoga layout tree twice and poisons every later Ink instance.
      if (closed) return;
      closed = true;
      await shutdown();
      view.unmount();
    },
  };
  try {
    if (options.consent !== false) {
      if (!client.workspaceTrusted()) {
        await session.waitFor('Accessing workspace:');
        await session.press(UP);
        await session.press(ENTER);
      }
      if (!(await waitForCondition(() => (client.userInputReady() ? true : undefined), 10000)))
        throw new Error(
          `Startup gate did not open the composer:\n${frame()}\nhistory: ${session.frames().slice(-3000)}\nstderr: ${view.stderr.frames.join('\n')}`,
        );
      await settle();
    }
  } catch (error) {
    await session.close(); // never leave a mounted app behind a failed startup
    throw error;
  }
  return session;
}
