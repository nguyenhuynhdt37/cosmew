/** @jsxImportSource react */
import {render} from 'ink-testing-library';
import type {FutrynClient} from '@futryn/sdk';
import {InkApp} from '../app';
import {messagesToTranscript, type TranscriptItem} from '../features/transcript/logic';

export const ESC = '\x1b';
export const ENTER = '\r';
export const UP = '\x1b[A';
export const DOWN = '\x1b[B';
export const SHIFT_TAB = '\x1b[Z';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface InkSessionOptions {
  width?: number;
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
 * through its own dialog: Allow for this session, then the real account verification request.
 */
export async function openInk(client: FutrynClient, options: InkSessionOptions = {}): Promise<InkSession> {
  let open = 0;
  const send = client.sendMessage.bind(client);
  client.sendMessage = ((...args: Parameters<typeof send>) => {
    const source = send(...args);
    return (async function* () {
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
      initialCommand={options.initialCommand}
      registerShutdown={fn => {
        shutdown = fn;
      }}
    />,
  );
  const frame = () => (view.lastFrame() ?? '').replace(ANSI, '');
  const session: InkSession = {
    client,
    frame,
    frames: () => view.frames.join('\n').replace(ANSI, ''),
    async press(keys) {
      view.stdin.write(keys);
      await sleep(40);
    },
    async type(text) {
      view.stdin.write(text);
      await sleep(40);
    },
    async waitFor(text, ms = 8000) {
      const end = Date.now() + ms;
      const match = (s: string) => (typeof text === 'string' ? s.includes(text) : text.test(s));
      while (Date.now() < end) {
        const now = frame();
        if (match(now)) return now;
        const all = session.frames();
        if (match(all)) return all;
        await sleep(10);
      }
      throw new Error(`Timed out waiting for ${String(text)}; last frame:\n${frame()}`);
    },
    async nextPermission(ms = 4000) {
      const end = Date.now() + ms;
      while (!client.listPendingPermissions().length && Date.now() < end) await sleep(5);
      const pending = client.listPendingPermissions();
      if (!pending.length) throw new Error(`No permission request arrived; last frame:\n${frame()}`);
      await session.waitFor('4 Không', 3000);
      await sleep(120); // the dialog subscribes to input after its first paint
      return pending[0]!;
    },
    async idle(ms = 15000) {
      const end = Date.now() + ms;
      while (open > 0 && Date.now() < end) await sleep(10);
      await sleep(200); // let dialogs close and the composer take input again
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
      await session.submit(text);
      // Give a turn that starts asynchronously a moment to register, then wait for it unless a prompt blocks.
      const started = Date.now();
      while (open === 0 && Date.now() - started < 300) await sleep(10);
      while (open > 0 && !client.listPendingPermissions().length && !client.listPendingQuestions().length)
        await sleep(10);
    },
    async executeSlashCommand(text) {
      await session.submit(text);
      await sleep(200); // an opened dialog subscribes to input after its first paint
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
      await session.waitFor('Trust this folder?');
      await session.press(UP);
      await session.press(ENTER);
      const end = Date.now() + 10000;
      while (Date.now() < end && (frame().includes('Checking account') || !frame().includes('Ask anything')))
        await sleep(10);
      if (frame().includes('Checking account') || frame().includes('Trust this folder?'))
        throw new Error(
          `Startup gate did not open the composer:\n${frame()}\nhistory: ${session.frames().slice(-3000)}\nstderr: ${view.stderr.frames.join('\n')}`,
        );
      await sleep(250); // Ink re-subscribes raw input after the gate unmounts.
    }
  } catch (error) {
    await session.close(); // never leave a mounted app behind a failed startup
    throw error;
  }
  return session;
}
