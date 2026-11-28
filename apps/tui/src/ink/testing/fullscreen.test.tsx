/** @jsxImportSource react */
import {useTerminalSize} from '../hooks/use-terminal-size';
import {afterEach, expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanup} from 'ink-testing-library';
import {noteInput, settle, trackFrames, waitForCondition, waitForFrame} from './wait';
import {Text, renderToString, render as inkRender} from 'ink';
import type {ModelEvent} from '@cosmew/contracts';
import {ThemeEngine} from '../../theme/theme';
import {InkApp} from '../app';
import {IntegratedShell} from '../integrated-shell';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {Welcome} from '../features/welcome';
import {runInkTui} from '../runtime';
import {LiveDialog} from '../ui';
import {PermissionRequestDialog} from '../features/permissions';
import {ThemeProvider} from '../theme';
import {useTextInput} from '../hooks/input-scope';
import {buildKeymap, keymapStore} from '../hooks/keymap';
import {queryTerminalBackground} from '../../theme/terminal-background';
import {createTerminalMouseInput} from '../../input/mouse-input';
import {TerminalMouseProvider} from '../hooks/use-terminal-wheel';

afterEach(cleanup);

class SizedStream extends EventEmitter {
  isTTY = true;
  columns: number;
  rows: number;
  frames: string[] = [];
  private last = '';
  private pending: string[] = [];
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.setMaxListeners(32);
    trackFrames(this);
  }
  write = (frame: string, callback?: () => void) => {
    this.frames.push(frame);
    if (callback) queueMicrotask(callback);
    this.last = frame;
    // Ink reads stdin in paused mode (`readable` + `read()`), not via `data`.
    if (this.listenerCount('readable') > 0) {
      this.pending.push(frame);
      this.emit('readable');
      noteInput(frame, true);
    }
    return true;
  };
  lastFrame = () => this.last;
  setEncoding() {}
  setRawMode(_mode?: boolean) {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    if (!this.pending.length) return null;
    const chunk = this.pending.join('');
    this.pending = [];
    return chunk;
  };
}

/** Ink's public render options are Node streams. The test double only implements what Ink calls. */
function asWrite(stream: SizedStream): NodeJS.WriteStream {
  return stream as unknown as NodeJS.WriteStream;
}
function asRead(stream: SizedStream): NodeJS.ReadStream {
  return stream as unknown as NodeJS.ReadStream;
}

function frameLines(frame: string | undefined): string[] {
  // Ink joins the viewport rows with newlines and does not add a trailing one.
  // A blank last row is a real row of the fullscreen frame, so it stays.
  return (frame ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n');
}

function openSized(
  columns: number,
  rows: number,
  debug = true,
  answerLines = 0,
  hang = false,
  historyItems = 0,
  historyText = (n: number) => `history ${n} needle`,
  events?: readonly ModelEvent[] | (() => AsyncIterable<ModelEvent>),
) {
  const prompts: string[] = [];
  let finishStreaming = () => {};
  let interrupted = false;
  let client: ReturnType<typeof dialogFixture>['client'];
  const fixture = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({
      id: 'session-1',
      selection,
      messages: Array.from({length: historyItems}, (_, n) => ({
        role: n % 2 ? ('assistant' as const) : ('user' as const),
        content: historyText(n),
      })),
    }),
    async *sendTurn(_id, content, signal): AsyncIterable<ModelEvent> {
      prompts.push(content);
      if (events) {
        yield* typeof events === 'function' ? events() : events;
        return;
      }
      if (answerLines) {
        yield {
          type: 'textDelta',
          text: Array.from({length: answerLines}, (_, index) => `answer line ${index + 1}`).join('\n\n'),
        };
        if (hang) {
          await new Promise<void>(resolve => {
            finishStreaming = resolve;
            signal?.addEventListener('abort', () => {
              interrupted = true;
              resolve();
            });
          });
          if (!signal?.aborted) yield {type: 'textDelta', text: '\n\nstream completed'};
        }
        return;
      }
      yield {type: 'toolCallComplete', call: {id: 'read-1', name: 'read', input: {path: 'file'}}};
      const decision = await client.requestPermission(
        {
          capability: 'fs.read',
          action: 'Read fixture',
          target: Array.from({length: 60}, (_, index) => `body line ${index}`).join('\n'),
          reason: 'test',
          kind: 'secret',
          decisions: ['once', 'session'],
        },
        signal,
      );
      yield {
        type: 'toolResult',
        result: {
          callId: 'read-1',
          name: 'read',
          status: decision === 'deny' ? 'denied' : 'ok',
          content: `Read ${decision}`,
        },
      };
      yield {type: 'textDelta', text: 'Integrated answer'};
    },
  });
  client = fixture.client;
  if (historyItems) client.createSession();
  const stdout = new SizedStream(columns, rows);
  const stdin = new SizedStream(columns, rows);
  const stderr = new SizedStream(columns, rows);
  const themeEngine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
  const mouse = createTerminalMouseInput(asRead(stdin), asWrite(stdout));
  const view = inkRender(
    <TerminalMouseProvider value={mouse}>
      <InkApp client={fixture.client} themeEngine={themeEngine} />
    </TerminalMouseProvider>,
    {
      stdout: asWrite(stdout),
      stdin: mouse.stdin,
      stderr: asWrite(stderr),
      debug,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  const lines = () => {
    const all = frameLines(
      debug ? stdout.lastFrame() : stdout.frames.findLast(frame => frameLines(frame).join('').trim()),
    );
    const dialog = all.findIndex(line => line.startsWith('─'));
    return dialog < 0 ? all : all.slice(dialog);
  };
  return {
    fixture,
    prompts,
    finishStreaming: () => finishStreaming(),
    interrupted: () => interrupted,
    stdout,
    stdin,
    mouse,
    rows: () => frameLines(stdout.lastFrame()),
    lines,
    fullFrame: () => frameLines(stdout.lastFrame()).join('\n'),
    frame: () => lines().join('\n'),
    unmount: () => {
      view.unmount();
      mouse.dispose();
    },
    resize(nextColumns: number, nextRows: number) {
      stdout.columns = nextColumns;
      stdout.rows = nextRows;
      stdout.emit('resize');
    },
  };
}

async function waitFor(read: () => string, text: string) {
  const frame = await waitForFrame({lastFrame: read}, value => value.includes(text), 4000);
  expect(frame, text).toContain(text);
}

/** Opens the app past the startup gate, then returns the ready view. */
async function openReady(
  columns: number,
  rows: number,
  debug = true,
  answerLines = 0,
  hang = false,
  historyItems = 0,
  historyText = (n: number) => `history ${n} needle`,
  events?: readonly ModelEvent[] | (() => AsyncIterable<ModelEvent>),
) {
  const view = openSized(columns, rows, debug, answerLines, hang, historyItems, historyText, events);
  await waitFor(view.fullFrame, 'Accessing workspace:');
  view.stdin.write('\u001b[A');
  await settle();
  view.stdin.write('\r');
  await waitFor(view.fullFrame, 'manual mode on');
  return view;
}
const isRule = (line: string | undefined) => /^─{10,}$/.test(line ?? '');

for (const [columns, rows, rule] of [
  [100, 30, 25],
  [120, 36, 31],
] as const)
  test(`idle fullscreen frame at ${columns}x${rows} pins the composer to the reference rows`, async () => {
    const view = await openReady(columns, rows);
    try {
      const frame = view.rows();
      expect(frame).toHaveLength(rows);
      // Reference idle-100x30/01-ready: banner at rows 1-3, effort row, rule, prompt, rule, blank row, footer last.
      expect(frame[0]!.trim()).toBe('');
      expect(frame[1]).toContain('Cosmew v');
      expect(frame[2]).toContain('sample-model');
      expect(frame[rule - 1]).toContain('/effort');
      expect(isRule(frame[rule]), frame.join('\n')).toBe(true);
      expect(frame[rule + 1]).toContain('❯ ');
      expect(isRule(frame[rule + 2])).toBe(true);
      expect(frame[rule + 3]).toContain('tab/→ accept suggestion · ? shortcuts · shift+tab permissions');
      expect(frame.at(-1)).toContain('manual mode on');
      expect(frame.at(-1)).toBe(frame[rule + 4]);
    } finally {
      view.unmount();
    }
  });

test('ready interface fills the terminal after enlarging and shrinking the window', async () => {
  const view = await openReady(100, 30);
  try {
    for (const [columns, rows] of [
      [180, 50],
      [120, 36],
      [80, 24],
    ] as const) {
      view.resize(columns, rows);
      await settle();
      const frame = view.rows();
      expect(frame).toHaveLength(rows);
      expect(frame[rows - 5]).toBe('─'.repeat(columns));
      expect(frame[rows - 4]).toContain('❯ ');
      expect(frame.at(-1)).toContain('manual mode on');
      for (const line of frame) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  } finally {
    view.unmount();
  }
});

test('scrolling with PgUp/PgDn keeps the bottom block pinned, shows the jump chip and follows only at the bottom', async () => {
  const view = await openReady(100, 30, true, 50);
  try {
    view.stdin.write('say a lot');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 50');
    const pinned = (frame: string[]) => {
      expect(frame).toHaveLength(30);
      expect(isRule(frame[25])).toBe(true);
      expect(isRule(frame[27])).toBe(true);
      expect(frame.at(-1)).toContain('manual mode on');
    };
    pinned(view.rows());
    expect(view.fullFrame()).not.toContain('Jump to bottom');
    view.stdin.write('\u001b[5~');
    await waitFor(view.fullFrame, 'Jump to bottom · fn+↓ to scroll');
    await settle();
    const scrolled = view.rows();
    pinned(scrolled);
    expect(scrolled.join('\n')).not.toContain('answer line 50');
    view.stdin.write('\u001b[6~');
    await waitForFrame({lastFrame: view.fullFrame}, frame => !frame.includes('Jump to bottom'), 4000);
    expect(view.fullFrame()).not.toContain('Jump to bottom');
    expect(view.fullFrame()).toContain('answer line 50');
    pinned(view.rows());
  } finally {
    view.unmount();
  }
});

test('mouse wheel scrolls the conversation without editing the draft or moving the pinned composer', async () => {
  const view = await openReady(100, 30, true, 60);
  try {
    view.stdin.write('say a lot');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 60');
    view.stdin.write('keep draft');
    await settle();
    view.stdin.write('\x1b[<64;20;10M'.repeat(12));
    await settle();
    expect(view.fullFrame()).toContain('Jump to bottom');
    expect(view.fullFrame()).not.toContain('answer line 60');
    expect(view.fullFrame()).toContain('keep draft');
    expect(view.rows()).toHaveLength(30);
    view.stdin.write('\x1b[<65;20;10M'.repeat(12));
    await settle();
    expect(view.fullFrame()).not.toContain('Jump to bottom');
    expect(view.fullFrame()).toContain('answer line 60');
    expect(view.fullFrame()).toContain('keep draft');
  } finally {
    view.unmount();
  }
});

test('panels open with a full-width ▔ rule at the bottom while the transcript stays above', async () => {
  const view = await openReady(100, 30, true, 3);
  try {
    view.stdin.write('hello');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 3');
    view.stdin.write('/help');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'Help');
    const frame = view.rows();
    const panel = frame.findIndex(line => /^▔{20,}$/.test(line));
    expect(panel, frame.join('\n')).toBeGreaterThan(0);
    expect(frame.slice(0, panel).join('\n')).toContain('answer line');
    expect(frame.join('\n')).not.toContain('manual mode on');
    expect(frame).toHaveLength(30);
  } finally {
    view.unmount();
  }
});

test('permission dialog opens with a ─ rule, replaces the composer and keeps every choice visible at 80x12', async () => {
  const view = await openReady(80, 12);
  try {
    view.stdin.write('read it');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, '3. No');
    await settle();
    view.stdin.write('\x1b[<64;20;3M\x1b[<0;20;3M\x1b[<0;20;3m');
    await settle();
    expect(view.fixture.client.listPendingPermissions()).toHaveLength(1);
    const frame = view.rows();
    expect(frame.length).toBeLessThanOrEqual(12);
    const dialog = frame.findIndex(line => /^─{20,}$/.test(line));
    expect(dialog).toBeGreaterThan(0);
    // The transcript keeps at least its newest line above the dialog.
    expect(frame.slice(0, dialog).some(line => line.trim())).toBe(true);
    // Eleven dialog rows leave exactly one transcript row on a 12-row terminal.
    expect(frame.slice(0, dialog).filter(line => line.trim())).toHaveLength(1);
    for (const label of ['1. Yes', '2. Yes, and', '3. No', 'Esc to cancel · Tab to amend'])
      expect(frame.join('\n')).toContain(label);
    expect(frame.join('\n')).not.toContain('manual mode on');
    view.stdin.write('\t');
    await waitFor(view.fullFrame, 'Tell Cosmew what to do differently');
    expect(view.rows().length).toBeLessThanOrEqual(12);
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'manual mode on');
  } finally {
    view.unmount();
  }
});

test('a running turn puts the spinner and tip directly above the effort row', async () => {
  const view = await openReady(100, 30, true, 2, true);
  try {
    view.stdin.write('go');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'Tip:');
    const frame = view.rows();
    const tip = frame.findIndex(line => line.includes('⎿  Tip:'));
    expect(frame[tip - 1]).toMatch(/^[·✢✳✶✻✽] \S+…/);
    expect(frame.at(-1)).toContain('esc to interrupt');
    expect(frame[tip + 1]).toContain('/effort');
    expect(isRule(frame[tip + 2])).toBe(true);
    expect(frame).toHaveLength(30);
  } finally {
    view.unmount();
  }
});

test('interactive runtime enters the alternate screen, leaves it before the resume hint and exits on SIGTERM', async () => {
  const fixture = dialogFixture({startSession: () => ({id: 'session-1', selection, messages: []})});
  fixture.client.createSession();
  const stdout = new SizedStream(80, 12),
    stdin = new SizedStream(80, 12);
  const run = runInkTui({
    client: fixture.client,
    stdout: asWrite(stdout),
    stdin: asRead(stdin),
    themeEngine: new ThemeEngine({env: {NO_COLOR: '1'}}),
    slots: {status: <Text>RUNTIME_READY</Text>},
  });
  await waitFor(() => stdout.frames.join(''), 'RUNTIME_READY');
  await settle();
  process.emit('SIGTERM');
  await run;
  const output = stdout.frames.join('');
  expect(output).toContain('\x1b[?1049h');
  expect(output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(output.indexOf('\x1b[?1049h'));
  expect(output.lastIndexOf('\x1b[?1049l')).toBeLessThan(
    output.indexOf('Resume this session with: cosmew --resume session-1'),
  );
});

test('non-TTY run stays one frame without terminal control sequences', async () => {
  const fixture = dialogFixture();
  const chunks: string[] = [];
  await runInkTui({
    client: fixture.client,
    stdout: {isTTY: false, columns: 60, write: (chunk: string) => !!chunks.push(chunk)} as never,
    stdin: {isTTY: false} as never,
    themeEngine: new ThemeEngine({env: {NO_COLOR: '1'}}),
    cols: 60,
  });
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toContain('Non-TTY preview');
  expect(chunks[0]).not.toContain('\x1b[?1049');
});

/** A terminal that answers the OSC 11 background query like a real emulator. */
function terminalAnswering(reply: string | undefined) {
  const stdin = new SizedStream(80, 12);
  const stdout = new SizedStream(80, 12);
  const raw: boolean[] = [];
  const written: string[] = [];
  stdin.setRawMode = (mode: boolean) => void raw.push(mode);
  const write = stdout.write;
  stdout.write = (text: string, callback?: () => void) => {
    written.push(text);
    if (reply && text === '\x1b]11;?\x07') queueMicrotask(() => stdin.write(reply));
    return write(text, callback);
  };
  return {stdin, stdout, raw, written};
}

for (const [name, reply, mode] of [
  ['light', '\x1b]11;rgb:ffff/ffff/ffff\x07', 'light'],
  ['dark', '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', 'dark'],
] as const)
  test(`theme auto follows a ${name} terminal background answered through OSC 11`, async () => {
    const terminal = terminalAnswering(reply);
    const fixture = dialogFixture({startSession: () => ({id: 'session-1', selection, messages: []})});
    // COLORFGBG says the opposite: the terminal's own answer must win.
    const engine = new ThemeEngine({env: {NO_COLOR: '1', COLORFGBG: mode === 'light' ? '15;0' : '0;15'}});
    const run = runInkTui({
      client: fixture.client,
      stdout: asWrite(terminal.stdout),
      stdin: asRead(terminal.stdin),
      themeEngine: engine,
      slots: {status: <Text>RUNTIME_READY</Text>},
    });
    await waitFor(() => terminal.stdout.frames.join(''), 'RUNTIME_READY');
    expect(engine.getActiveAppearance().mode).toBe('system');
    expect(engine.getEffectiveMode()).toBe(mode);
    expect(terminal.written[0]).toBe('\x1b]11;?\x07');
    expect(terminal.raw.slice(0, 2)).toEqual([true, false]);
    process.emit('SIGTERM');
    await run;
  });

test('theme auto bounds the query and startup drain for a silent terminal, then falls back to COLORFGBG and dark', async () => {
  const silent = terminalAnswering(undefined);
  const started = Date.now();
  expect(await queryTerminalBackground(silent as never)).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(900);
  expect(silent.raw).toEqual([true, false]);
  const light = new ThemeEngine({env: {COLORFGBG: '0;15'}});
  light.applyTerminalBackground(undefined);
  expect(light.getEffectiveMode()).toBe('light');
  expect(new ThemeEngine({env: {}}).getEffectiveMode()).toBe('dark');
  expect(new ThemeEngine({env: {COSMEW_THEME_MODE: 'light'}}).getEffectiveMode()).toBe('light');
});

for (const width of [80, 36])
  test(`welcome banner at ${width} columns`, () => {
    const fixture = dialogFixture();
    const status = {...fixture.client.status(), workspace: '/very/long/workspace/directory/project'};
    const frame = renderToString(
      <ThemeProvider engine={new ThemeEngine({env: {NO_COLOR: '1'}})}>
        <Welcome status={status} width={width} />
      </ThemeProvider>,
      {columns: width},
    );
    expect(frame).toContain('Cosmew v0.2.0');
    expect(frame).toContain('project');
    expect(frame.split('\n').filter(line => line.trim())).toHaveLength(4);
    for (const line of frame.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    expect(frame).not.toContain('Quiet desk');
  });

test('welcome shows effort only when supplied and labels a missing account', () => {
  const fixture = dialogFixture();
  const frame = (status: ReturnType<typeof fixture.client.status>) =>
    renderToString(
      <ThemeProvider engine={new ThemeEngine({env: {NO_COLOR: '1'}})}>
        <Welcome status={status} width={80} />
      </ThemeProvider>,
      {columns: 80},
    );
  expect(frame({...fixture.client.status(), reasoningEffort: 'high'})).toContain(
    'sample-model with high effort · Personal',
  );
  const absent = frame({...fixture.client.status(), activeAccount: null, reasoningEffort: null});
  expect(absent).toContain('no account');
  expect(absent).not.toContain('with');
});

test('terminal size subscribers share one resize listener and release it on unmount', async () => {
  const stdout = new SizedStream(80, 24),
    stdin = new SizedStream(80, 24);
  function Dimensions() {
    const {columns} = useTerminalSize();
    return <Text>{`width=${columns}`}</Text>;
  }
  const view = inkRender(
    <>
      {Array.from({length: 16}, (_, i) => (
        <Dimensions key={i} />
      ))}
    </>,
    {stdout: asWrite(stdout), stdin: asRead(stdin), patchConsole: false, exitOnCtrlC: false, debug: true},
  );
  try {
    await settle();
    expect(stdout.listenerCount('resize')).toBeLessThanOrEqual(3);
    stdout.columns = 36;
    stdout.emit('resize');
    await settle();
    expect(stdout.lastFrame()).toContain('width=36');
  } finally {
    view.unmount();
  }
  expect(stdout.listenerCount('resize')).toBe(0);
});

test('a narrow short permission keeps NO SANDBOX and the command above active choices', async () => {
  const {client} = dialogFixture();
  const request = client.enqueuePermissionRequest({
    capability: 'process.execute',
    action: 'exec_command dangerouslyDisableSandbox',
    target: 'rm demo.txt',
    reason: 'NO SANDBOX',
    decisions: ['once', 'session'],
  });
  const stdout = new SizedStream(36, 12),
    stdin = new SizedStream(36, 12);
  const view = inkRender(
    <InkApp
      client={client}
      themeEngine={new ThemeEngine({env: {NO_COLOR: '1'}})}
      slots={{
        composer: (
          <LiveDialog rows={8}>
            <PermissionRequestDialog width={36} request={request} />
          </LiveDialog>
        ),
      }}
    />,
    {stdout: asWrite(stdout), stdin: asRead(stdin), debug: true, patchConsole: false, exitOnCtrlC: false},
  );
  try {
    await settle();
    const frame = frameLines(stdout.lastFrame()).join('\n');
    expect(frame).toContain('NO SANDBOX');
    expect(frame).toContain('rm demo.txt');
    expect(frame).toContain('1. Yes');
    expect(frame).toContain('2. Yes');
    expect(frame).toContain('3. No');
    expect(frame.split('\n').length).toBeLessThanOrEqual(8);
    expect(client.listPendingPermissions()).toHaveLength(1);
  } finally {
    view.unmount();
  }
});

test('detailed transcript toggles during streaming, shows working and lets the turn finish', async () => {
  const view = await openReady(120, 30, true, 2, true);
  try {
    view.stdin.write('go');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 2');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'working · Showing detailed transcript');
    expect(view.fullFrame()).not.toContain('verbose');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Tip:');
    expect(view.fullFrame()).not.toContain('Showing detailed transcript');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'working · Showing detailed transcript');
    expect(view.interrupted()).toBe(false);
    view.finishStreaming();
    await waitFor(view.fullFrame, 'stream completed');
    await waitFor(view.fullFrame, 'verbose');
    expect(view.fullFrame()).not.toContain('working ·');
    expect(view.interrupted()).toBe(false);
    expect(view.prompts).toEqual(['go']);
  } finally {
    view.unmount();
  }
});

for (const kind of ['permission', 'question'] as const)
  test(`detailed transcript shows dialog waiting during a ${kind} overlay`, async () => {
    const view = await openReady(120, 36);
    try {
      if (kind === 'permission') {
        view.stdin.write('read it');
        await settle();
        view.stdin.write('\r');
        await waitFor(view.fullFrame, '3. No');
      } else {
        void view.fixture.client.askUser([
          {
            id: 'choice',
            header: 'Choice',
            question: 'Which option?',
            options: [
              {label: 'First', description: 'First option'},
              {label: 'Second', description: 'Second option'},
            ],
          },
        ]);
        await waitFor(view.fullFrame, 'Which option?');
      }
      view.stdin.write('\x0f');
      await waitFor(view.fullFrame, 'dialog waiting · Showing detailed transcript');
      expect(view.fullFrame()).not.toContain('verbose');
      expect(view.rows().length).toBeLessThanOrEqual(36);
      expect(
        kind === 'permission'
          ? view.fixture.client.listPendingPermissions()
          : view.fixture.client.listPendingQuestions(),
      ).toHaveLength(1);
      view.stdin.write('\x0f');
      await settle();
      expect(view.fullFrame()).not.toContain('Showing detailed transcript');
      expect(
        kind === 'permission'
          ? view.fixture.client.listPendingPermissions()
          : view.fixture.client.listPendingQuestions(),
      ).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });

/** Answer paragraphs are two terminal rows apart; recover the visible content offset from any numbered row. */
function answerPosition(view: Awaited<ReturnType<typeof openReady>>): number {
  const rows = view.rows();
  const row = rows.findIndex(line => /answer line \d+/.test(line));
  expect(row, view.fullFrame()).toBeGreaterThanOrEqual(0);
  return Number(/answer line (\d+)/.exec(rows[row]!)![1]) * 2 - row;
}

for (const [family, up, down, distance] of [
  ['j/k', 'k', 'j', 1],
  ['Ctrl+P/N', '\x10', '\x0e', 1],
  ['arrows', '\x1b[A', '\x1b[B', 1],
  ['half viewport', '\x15', '\x04', 14],
  ['Ctrl+B/F', '\x02', '\x06', 28],
  ['b/space', 'b', ' ', 28],
] as const)
  test(`detailed transcript scroll keys: ${family} move the expected rows without editing the draft`, async () => {
    const view = await openReady(100, 30, true, 100);
    try {
      view.stdin.write('long answer');
      await settle();
      view.stdin.write('\r');
      await waitFor(view.fullFrame, 'answer line 100');
      // Keep the prompt empty: Ctrl+D must scroll rather than arm the global exit.
      view.stdin.write('\x0f');
      await waitFor(view.fullFrame, 'Showing detailed transcript');
      // Footer uses two rows, leaving a 28-row viewport (half is 14).
      expect(view.rows()).toHaveLength(30);
      expect(isRule(view.rows()[28])).toBe(true);
      view.stdin.write('\x1b[5~');
      await settle();
      view.stdin.write('\x1b[5~');
      await settle();
      view.stdin.write('\x1b[5~');
      await settle();
      const before = answerPosition(view);
      view.stdin.write(up);
      await settle();
      expect(answerPosition(view)).toBe(before - distance);
      view.stdin.write(down);
      await settle();
      expect(answerPosition(view)).toBe(before);
      expect(view.fullFrame()).toContain('Showing detailed transcript');
      expect(view.fullFrame()).not.toContain('Press Ctrl-D');
      view.stdin.write('q');
      await waitFor(view.fullFrame, 'manual mode on');
      view.stdin.write('unchanged');
      await settle();
      expect(view.rows()[26]).toContain('❯ unchanged');
    } finally {
      view.unmount();
    }
  });

for (const [family, top, bottom] of [
  ['g/G', 'g', 'G'],
  ['Home/End', '\x1b[H', '\x1b[F'],
] as const)
  test(`detailed transcript scroll keys: ${family} reach both ends`, async () => {
    const view = await openReady(100, 30, true, 50);
    try {
      view.stdin.write('long answer');
      await settle();
      view.stdin.write('\r');
      await waitFor(view.fullFrame, 'answer line 50');
      view.stdin.write('\x0f');
      await waitFor(view.fullFrame, 'Showing detailed transcript');
      view.stdin.write(top);
      await waitFor(view.fullFrame, 'Cosmew v');
      expect(view.fullFrame()).not.toContain('answer line 50');
      view.stdin.write(bottom);
      await waitFor(view.fullFrame, 'answer line 50');
      expect(view.fullFrame()).not.toContain('Jump to bottom');
    } finally {
      view.unmount();
    }
  });

test('detailed transcript scroll aliases keep normal prompt typing and composer editing outside the mode', async () => {
  const view = await openReady(100, 30, true, 1);
  try {
    for (const key of ['j', 'k', 'g', 'G', ' ', 'b', 'q', 'n']) {
      view.stdin.write(key);
      await settle();
    }
    expect(view.rows()[26]).toContain('❯ jkgG bqn');
    // The normal composer still owns history navigation and Ctrl+D deletion.
    view.stdin.write('\x1b[D');
    await settle();
    view.stdin.write('\x04');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 1');
    expect(view.prompts).toEqual(['jkgG bq']);
    view.stdin.write('\x10');
    await settle();
    expect(view.rows()[26]).toContain('❯ jkgG bq');
    view.stdin.write('\x0e');
    await settle();
    expect(view.rows()[26]).not.toContain('jkgG bq');
  } finally {
    view.unmount();
  }
});

for (const [label, key] of [
  ['Esc', '\x1b'],
  ['q', 'q'],
  ['Ctrl+C', '\x03'],
] as const)
  test(`detailed transcript still exits with ${label} and restores composer focus`, async () => {
    const view = await openReady(100, 30);
    try {
      view.stdin.write('kept draft');
      await settle();
      view.stdin.write('\x0f');
      await waitFor(view.fullFrame, 'Showing detailed transcript');
      view.stdin.write(key);
      await waitFor(view.fullFrame, 'manual mode on');
      expect(view.fullFrame()).not.toContain('Showing detailed transcript');
      view.stdin.write('!');
      await settle();
      expect(view.rows()[26]).toContain('❯ kept draft!');
    } finally {
      view.unmount();
    }
  });

test('detailed transcript: { and } jump between prompts, Ctrl+Home/Ctrl+End go to the ends, q leaves', async () => {
  const view = await openReady(100, 30, true, 40);
  try {
    for (const prompt of ['first prompt', 'second prompt']) {
      view.stdin.write(prompt);
      await settle();
      view.stdin.write('\r');
      await waitFor(view.fullFrame, 'answer line 40');
      await waitFor(view.fullFrame, 'manual mode on');
    }
    view.stdin.write('\x0f'); // Ctrl+O
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    expect(view.fullFrame()).not.toContain('❯ first prompt');
    view.stdin.write('{');
    await waitFor(view.fullFrame, '❯ second prompt');
    view.stdin.write('{');
    await waitFor(view.fullFrame, '❯ first prompt');
    expect(view.fullFrame()).not.toContain('❯ second prompt');
    view.stdin.write('}');
    await waitFor(view.fullFrame, '❯ second prompt');
    view.stdin.write('\x1b[1;5H'); // Ctrl+Home
    await waitFor(view.fullFrame, 'Cosmew v');
    view.stdin.write('\x1b[1;5F'); // Ctrl+End
    await waitFor(view.fullFrame, 'answer line 40');
    expect(view.fullFrame()).not.toContain('Jump to bottom');
    view.stdin.write('q');
    await waitFor(view.fullFrame, 'manual mode on');
    expect(view.fullFrame()).not.toContain('Showing detailed transcript');
  } finally {
    view.unmount();
  }
});

test('fullscreen transcript [ suspends Ink, writes the conversation and resumes the detailed viewer', async () => {
  const view = await openReady(80, 24, true, 2);
  try {
    view.stdin.write('scrollback prompt');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 2');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    const start = view.stdout.frames.length;
    view.stdin.write('[');
    await waitFor(() => view.stdout.frames.slice(start).join(''), 'Conversation written to the terminal scrollback.');
    const writes = view.stdout.frames.slice(start);
    const printed = writes.findIndex(chunk => chunk.includes('> scrollback prompt\n\nanswer line 1'));
    expect(printed, writes.join('')).toBeGreaterThanOrEqual(0);
    // suspendTerminal restores the cursor before native output, then hides it when Ink resumes.
    expect(writes.slice(0, printed).join('')).toContain('\x1b[?25h');
    expect(writes.slice(printed + 1).join('')).toContain('Showing detailed transcript');
  } finally {
    view.unmount();
  }
});

test.skipIf(process.platform === 'win32')(
  'transcript v runs a real VISUAL editor on a private temporary copy and resumes Ink',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-transcript-test-'));
    const editor = join(dir, 'editor');
    const copy = join(dir, 'copy.md');
    const oldVisual = process.env.VISUAL;
    const oldCopy = process.env.FUTRYN_TEST_TRANSCRIPT_COPY;
    await writeFile(editor, '#!/bin/sh\n/bin/cp -p "$1" "$FUTRYN_TEST_TRANSCRIPT_COPY"\n', {mode: 0o700});
    process.env.VISUAL = editor;
    process.env.FUTRYN_TEST_TRANSCRIPT_COPY = copy;
    const view = await openReady(80, 24, true, 2, false, 1000);
    try {
      view.stdin.write('editor prompt');
      await settle();
      view.stdin.write('\r');
      await waitFor(view.fullFrame, 'answer line 2');
      view.stdin.write('\x0f');
      await waitFor(view.fullFrame, 'Showing detailed transcript');
      const messages = structuredClone(view.fixture.client.activeSession()?.messages);
      const start = view.stdout.frames.length;
      view.stdin.write('v');
      await waitFor(() => view.stdout.frames.slice(start).join(''), 'Showing detailed transcript');
      await waitForCondition(() => (existsSync(copy) ? true : undefined), 3000);
      const exported = await readFile(copy, 'utf8');
      expect(exported).toContain('> history 0 needle');
      expect(exported).toContain('history 999 needle');
      expect(exported).toContain('> editor prompt\n\nanswer line 1');
      expect((await stat(copy)).mode & 0o777).toBe(0o600);
      expect(view.fixture.client.activeSession()?.messages).toEqual(messages);
      expect(view.stdout.frames.slice(start).join('')).toContain('\x1b[?25h');
    } finally {
      view.unmount();
      if (oldVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = oldVisual;
      if (oldCopy === undefined) delete process.env.FUTRYN_TEST_TRANSCRIPT_COPY;
      else process.env.FUTRYN_TEST_TRANSCRIPT_COPY = oldCopy;
      await rm(dir, {recursive: true, force: true});
    }
  },
);

test('raw terminal replies never emit Escape or cancel workspace consent', async () => {
  const stdin = new SizedStream(100, 30);
  const stdout = new SizedStream(100, 30);
  let escapes = 0;
  function InputProbe() {
    useTextInput((_input, key) => {
      if (key.escape) escapes++;
    });
    return null;
  }
  const fixture = dialogFixture({});
  const query = queryTerminalBackground({stdin: asRead(stdin), stdout: asWrite(stdout)}, 10);
  for (const reply of [
    '\x1b]11;rgb:ffff/ffff/ffff\x07',
    '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
    '\x1bPignored\x1b\\',
    '\x1b_ignored\x1b\\',
    '\x1b\\',
  ]) {
    for (const byte of reply) stdin.write(byte);
    await settle();
  }
  await query;
  const view = inkRender(
    <InkApp
      client={fixture.client}
      themeEngine={new ThemeEngine({env: {NO_COLOR: '1'}})}
      slots={{
        status: (
          <>
            <IntegratedShell />
            <InputProbe />
          </>
        ),
      }}
    />,
    {
      stdin: asRead(stdin),
      stdout: asWrite(stdout),
      stderr: asWrite(new SizedStream(100, 30)),
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  try {
    await settle();
    expect(stdout.lastFrame()).toContain('Accessing workspace:');
    expect(escapes).toBe(0);
    expect(fixture.client.workspaceTrusted()).toBe(false);
    stdin.write('\x1b[A');
    await settle();
    expect(stdout.lastFrame()).toContain('❯ Yes, I trust this folder');
    stdin.write('\x1b');
    await settle();
    expect(escapes).toBe(1); // Actual Escape still reaches the input layer.
  } finally {
    view.unmount();
  }
});

test('detailed transcript Ctrl+E reveals and collapses inline history, resets on entry and yields to the composer', async () => {
  const view = await openReady(120, 0, true, 1);
  try {
    for (let n = 0; n < 17; n++) {
      view.stdin.write(`window-prompt-${String(n).padStart(3, '0')}`);
      await settle();
      view.stdin.write('\r');
      await settle();
    }
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Ctrl+E to show 4 previous messages');
    expect(view.fullFrame()).not.toContain('window-prompt-000');
    view.stdin.write('\x05');
    await waitFor(view.fullFrame, 'ctrl+e to collapse');
    expect(view.fullFrame()).toContain('window-prompt-000');
    expect(view.fullFrame()).toContain('Ctrl+E to hide 4 previous messages');
    view.stdin.write('\x05');
    await waitFor(view.fullFrame, 'Ctrl+E to show 4 previous messages');
    expect(view.fullFrame()).not.toContain('window-prompt-000');
    view.stdin.write('\x05');
    await waitFor(view.fullFrame, 'ctrl+e to collapse');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'manual mode on');
    view.stdin.write('draft');
    await settle();
    view.stdin.write('\x01');
    await settle();
    view.stdin.write('\x05');
    await settle();
    view.stdin.write('!');
    await settle();
    expect(view.fullFrame()).toContain('❯ draft!');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Ctrl+E to show 4 previous messages');
    expect(view.fullFrame()).not.toContain('window-prompt-000');
  } finally {
    view.unmount();
  }
}, 15000);

test('detailed transcript Ctrl+E is disabled while fullscreen history scrolling is active', async () => {
  const view = await openReady(120, 30, true, 50);
  try {
    view.stdin.write('long answer');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 50');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    view.stdin.write('g');
    await settle();
    const before = view.fullFrame();
    view.stdin.write('\x05');
    await settle();
    expect(view.fullFrame()).toBe(before);
    expect(view.fullFrame()).not.toContain('ctrl+e to collapse');
    expect(view.fullFrame()).not.toContain('previous messages');
  } finally {
    view.unmount();
  }
});

test('short inline detailed transcript suppresses the footer show-all hint', async () => {
  const view = await openReady(120, 0, true, 1);
  try {
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    expect(view.fullFrame()).not.toContain('ctrl+e to show all');
    expect(view.fullFrame()).not.toContain('previous messages');
  } finally {
    view.unmount();
  }
});

test('detailed transcript search owns text, keeps on Enter, cycles and cancels before exit', async () => {
  const view = await openReady(100, 30, true, 80);
  try {
    view.stdin.write('inspect');
    await settle();
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'answer line 80');
    view.stdin.write('\x0f');
    await settle();
    view.stdin.write('/');
    await waitFor(view.fullFrame, 'Search transcript…');
    view.stdin.write('jkgqnx');
    await waitFor(view.fullFrame, 'jkgqnx');
    view.stdin.write('\x7f');
    await settle();
    expect(view.fullFrame()).not.toContain('jkgqnx');
    await waitFor(view.fullFrame, 'jkgqn');
    expect(view.fullFrame()).toContain('no matches');
    view.stdin.write('\x1b');
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    view.stdin.write('/');
    await settle();
    view.stdin.write('answer line');
    await waitFor(view.fullFrame, '1 of 80');
    expect(view.fullFrame()).toContain('answer line 1');
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'n/N to navigate');
    view.stdin.write('N');
    await waitForFrame(
      {lastFrame: view.fullFrame},
      frame => frame.includes('80 of 80') && frame.includes('answer line 80'),
    );
    expect(view.fullFrame()).toContain('80 of 80');
    expect(view.fullFrame()).toContain('answer line 80');
    view.stdin.write('n');
    await waitForFrame(
      {lastFrame: view.fullFrame},
      frame => frame.includes('1 of 80') && /answer line 1\b/.test(frame),
    );
    expect(view.fullFrame()).toContain('1 of 80');
    expect(view.fullFrame()).toContain('answer line 1');
    view.stdin.write('/');
    await waitFor(view.fullFrame, 'enter to keep');
    view.stdin.write('\x1b');
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    view.stdin.write('\x1b');
    await waitFor(view.fullFrame, 'manual mode on');
    expect(view.fullFrame()).not.toContain('Showing detailed transcript');
  } finally {
    view.unmount();
  }
});

test('detailed transcript search keeps a 5000-item history responsive while warming and revealing old matches', async () => {
  const view = await openReady(100, 30, true, 0, false, 5000);
  try {
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    view.stdin.write('/');
    await waitFor(view.fullFrame, 'Search transcript…');
    const start = performance.now();
    view.stdin.write('jkgqn');
    await new Promise<void>(resolve => setImmediate(resolve));
    // A synchronous full-history scan/render of 5000 items takes seconds; the budget only has to catch that order of
    // magnitude, so it is generous enough not to flake when the machine is busy (a frame budget of 16.7 ms did).
    expect(performance.now() - start).toBeLessThan(250);
    await waitFor(view.fullFrame, 'jkgqn');
    view.stdin.write('\x15');
    await settle();
    view.stdin.write('history 0');
    await waitFor(view.fullFrame, '1 of 1');
    await waitFor(view.fullFrame, 'history 0 needle');
    // Search must reveal the oldest item through a bounded mounted window, not mount all 5000.
    expect(view.fullFrame()).not.toContain('history 4999 needle');
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'n/N to navigate');
    const matched = view.fullFrame();
    view.stdin.write('\x05');
    await settle();
    expect(view.fullFrame()).toBe(matched);
    const printedAt = view.stdout.frames.length;
    view.stdin.write('[');
    const printed = () =>
      view.stdout.frames
        .slice(printedAt)
        .some(text => text.includes('history 0 needle') && text.includes('history 4999 needle'));
    await waitForCondition(() => (printed() ? true : undefined), 4000);
    expect(printed()).toBe(true);
    await settle();
    view.stdin.write('G');
    await waitFor(view.fullFrame, 'history 4999 needle');
    view.stdin.write('g');
    await waitFor(view.fullFrame, 'history 0 needle');
  } finally {
    view.unmount();
  }
});

for (const mode of ['search', 'legend'] as const)
  test(`detailed transcript ${mode} yields focus and space to a new dialog`, async () => {
    const view = await openReady(40, 24);
    try {
      view.stdin.write('\x0f');
      await settle();
      view.stdin.write(mode === 'search' ? '/' : '?');
      await settle();
      void view.fixture.client.askUser([
        {
          id: 'choice',
          header: 'Choice',
          question: 'Which option?',
          options: [
            {label: 'First', description: 'First option'},
            {label: 'Second', description: 'Second option'},
          ],
        },
      ]);
      await waitFor(view.fullFrame, 'Which option?');
      expect(view.fullFrame()).not.toContain('Search transcript…');
      expect(view.fullFrame()).not.toContain('print to scrollback');
      expect(view.fullFrame()).toContain('Second');
      expect(view.rows()).toHaveLength(24);
    } finally {
      view.unmount();
    }
  });

test('detailed transcript search reveals a match after wide emoji output', async () => {
  const view = await openReady(40, 24, true, 0, false, 2, n => (n ? `${'🚀'.repeat(1000)} target` : 'prompt'));
  try {
    view.stdin.write('\x0f');
    await settle();
    view.stdin.write('/');
    await settle();
    view.stdin.write('target');
    await waitFor(view.fullFrame, '1 of 1');
    await waitFor(() => view.fullFrame().split('─')[0] ?? '', 'target');
  } finally {
    view.unmount();
  }
});

const expandEvents: ModelEvent[] = [
  {type: 'reasoningDelta', text: 'Reasoning fixture body'},
  {type: 'toolCallComplete', call: {id: 'bash-1', name: 'exec_command', input: {cmd: 'fixture command'}}},
  {type: 'toolCallComplete', call: {id: 'read-1', name: 'read', input: {path: 'fixture.ts'}}},
  {
    type: 'toolResult',
    result: {
      callId: 'bash-1',
      name: 'exec_command',
      status: 'ok',
      content: Array.from({length: 500}, (_, n) => `fixture output row ${n}`).join('\n'),
    },
  },
  {type: 'toolResult', result: {callId: 'read-1', name: 'read', status: 'ok', content: 'file fixture body'}},
  {type: 'toolCallComplete', call: {id: 'refused', name: 'grep', input: {pattern: 'fixture'}}},
  {type: 'toolResult', result: {callId: 'refused', name: 'grep', status: 'denied', content: 'denied fixture'}},
  {type: 'textDelta', text: 'Finished expandable turn'},
];

async function openExpansionFixture() {
  const view = await openReady(100, 38, true, 0, false, 0, undefined, expandEvents);
  view.stdin.write('expand fixture');
  await waitFor(view.fullFrame, '❯ expand fixture');
  view.stdin.write('\r');
  await waitFor(view.fullFrame, 'Finished expandable turn');
  return view;
}

function clickLine(view: Awaited<ReturnType<typeof openExpansionFixture>>, text: string, code = 0) {
  const row = view.rows().findIndex(line => line.includes(text));
  expect(row, text).toBeGreaterThanOrEqual(0);
  const col = view.rows()[row]!.search(/\S/) + 1;
  view.stdin.write(`\x1b[<${code};${col};${row + 1}M`);
}

test('normal transcript SGR toggles merged tools and thinking and offers the omitted output', async () => {
  const view = await openExpansionFixture();
  try {
    const summary = 'Read 1 file, ran 1 shell command';
    await waitFor(view.fullFrame, 'click or ctrl+o to expand');
    expect(view.fullFrame()).toContain('denied fixture');
    clickLine(view, summary, 4); // Shift-click belongs to terminal selection.
    await settle();
    expect(view.fullFrame()).not.toContain('fixture command');
    clickLine(view, summary);
    await waitFor(view.fullFrame, 'fixture command');
    expect(view.fullFrame()).toContain('file fixture body');
    expect(view.fullFrame()).toContain('… +488 lines');
    expect(view.fullFrame()).toContain('fixture output row 499');
    expect(view.fullFrame()).not.toContain('fixture output row 250');
    clickLine(view, summary);
    await settle();
    expect(view.fullFrame()).not.toContain('fixture command');
    clickLine(view, 'Thinking');
    await waitFor(view.fullFrame, 'Reasoning fixture body');
    clickLine(view, 'Thinking');
    await settle();
    expect(view.fullFrame()).not.toContain('Reasoning fixture body');
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, '… +488 lines');
    clickLine(view, '… +488 lines');
    await waitFor(view.fullFrame, 'fixture output row 499');
    view.stdin.write('g');
    await waitFor(view.fullFrame, 'fixture output row 0');
    expect(view.fullFrame()).toContain('hide full output');
  } finally {
    view.unmount();
  }
});

test('normal transcript focus and toggle keys reveal reasoning without inserting input', async () => {
  const view = await openExpansionFixture();
  const original = keymapStore.get();
  keymapStore.set(
    buildKeymap(
      JSON.stringify({
        bindings: [
          {
            context: 'Transcript',
            bindings: {
              'alt+up': null,
              'alt+enter': null,
              'alt+u': 'transcript:focusPrevious',
              'alt+a': 'transcript:toggleItem',
            },
          },
        ],
      }),
    ),
  );
  try {
    view.stdin.write('\x1bu');
    await waitFor(view.fullFrame, '›');
    view.stdin.write('\x1bu');
    await settle();
    view.stdin.write('\x1bu');
    await waitFor(view.fullFrame, '› ✻ Thinking');
    view.stdin.write('\x1ba');
    await waitFor(view.fullFrame, 'Reasoning fixture body');
    view.stdin.write('\x1ba');
    await settle();
    expect(view.fullFrame()).not.toContain('Reasoning fixture body');
    expect(view.fullFrame()).toContain('alt+a toggle');
    view.stdin.write('?');
    await waitFor(view.fullFrame, 'toggle activity');
  } finally {
    keymapStore.set(original);
    view.unmount();
  }
});

test('a running tool and thinking keep their expansion as more events arrive', async () => {
  const moveOn = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const view = await openReady(100, 38, true, 0, false, 24, undefined, async function* () {
    yield {type: 'reasoningDelta', text: 'First reasoning'};
    await moveOn.promise;
    yield {type: 'reasoningDelta', text: '\n\nMore reasoning'};
    const call = {id: 'live-bash', name: 'exec_command', input: {cmd: 'echo one\necho two'}};
    yield {type: 'toolCallComplete', call};
    yield {type: 'toolOutputDelta', callId: call.id, name: call.name, stream: 'stdout', text: 'live first'};
    await finish.promise;
    yield {type: 'toolOutputDelta', callId: call.id, name: call.name, stream: 'stdout', text: '\nlive second'};
    yield {
      type: 'toolResult',
      result: {callId: call.id, name: call.name, status: 'error', exitCode: 1, content: 'live first\nlive second'},
    };
    yield {type: 'textDelta', text: 'live turn finished'};
  });
  try {
    view.stdin.write('live fixture');
    await waitFor(view.fullFrame, '❯ live fixture');
    view.stdin.write('\r');
    await waitFor(view.fullFrame, '✻ Thinking…');
    clickLine(view, '✻ Thinking…');
    await waitFor(view.fullFrame, 'First reasoning');
    moveOn.resolve();
    await waitFor(view.fullFrame, 'Running 1 shell command');
    expect(view.fullFrame()).toContain('More reasoning');
    clickLine(view, 'Running 1 shell command');
    await waitFor(view.fullFrame, 'live first');
    expect(view.fullFrame()).toContain('echo two');
    finish.resolve();
    await waitFor(view.fullFrame, 'live turn finished');
    expect(view.fullFrame()).toContain('live second');
    expect(view.fullFrame()).toContain('More reasoning');
    view.stdin.write('\x1b[1;5H');
    await waitFor(view.fullFrame, 'history 0 needle');
    expect(view.fullFrame()).not.toContain('live second');
    view.stdin.write('\x1b[1;5F');
    await waitFor(view.fullFrame, 'live second');
    view.stdin.write('/clear');
    await waitFor(view.fullFrame, '❯ /clear');
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'Started a fresh conversation');
    expect(view.fullFrame()).not.toContain('First reasoning');
    expect(view.fullFrame()).not.toContain('live second');
  } finally {
    moveOn.resolve();
    finish.resolve();
    view.unmount();
  }
});

test('a standalone edit title expands and collapses its diff in place', async () => {
  const apply = {id: 'edit-fixture', name: 'edit', input: {path: 'a.ts'}};
  const diff = '@@ -0,0 +1,60 @@\n' + Array.from({length: 60}, (_, n) => `+added-${n}`).join('\n');
  const view = await openReady(100, 92, true, 0, false, 0, undefined, [
    {type: 'toolCallComplete', call: apply},
    {
      type: 'toolResult',
      result: {
        callId: apply.id,
        name: apply.name,
        status: 'ok',
        content: JSON.stringify({changes: [{path: 'a.ts', action: 'update', diff}]}),
      },
    },
    {type: 'textDelta', text: 'Edit turn done'},
  ]);
  try {
    view.stdin.write('test edit');
    await waitFor(view.fullFrame, '❯ test edit');
    view.stdin.write('\r');
    await waitFor(view.fullFrame, 'Edit turn done');
    expect(view.fullFrame()).not.toContain('added-59');
    clickLine(view, 'Update(a.ts)');
    await waitFor(view.fullFrame, 'added-59');
    clickLine(view, 'Update(a.ts)');
    await settle();
    expect(view.fullFrame()).not.toContain('added-59');
  } finally {
    view.unmount();
  }
});

test('detailed transcript Ctrl+Q toggles text selection banner above DetailedFooter without overflowing', async () => {
  const view = await openReady(100, 30, true, 5);
  try {
    view.stdin.write('\x0f');
    await waitFor(view.fullFrame, 'Showing detailed transcript');
    expect(view.fullFrame()).not.toContain('Text selection enabled');

    view.stdin.write('\x11'); // Ctrl+Q
    await waitFor(view.fullFrame, 'Text selection enabled: drag to select');
    const enabledRows = view.rows();
    expect(enabledRows).toHaveLength(30);
    const bannerRow = enabledRows.findIndex(line => line.includes('Text selection enabled: drag to select'));
    expect(bannerRow).toBeGreaterThanOrEqual(0);
    expect(isRule(enabledRows[bannerRow + 1])).toBe(true);
    expect(enabledRows[bannerRow + 2]).toContain('Showing detailed transcript');

    view.stdin.write('\x11'); // Ctrl+Q again
    await waitForFrame({lastFrame: view.fullFrame}, frame => !frame.includes('Text selection enabled'), 4000);
    expect(view.fullFrame()).toContain('Showing detailed transcript');
    expect(view.fullFrame()).toContain('Mouse scrolling resumed.');
    expect(view.rows()).toHaveLength(30);
  } finally {
    view.unmount();
  }
});

test('useTerminalSelectionCopied shows copy confirmation on composer footer and DetailedFooter', async () => {
  const view = await openReady(120, 30);
  try {
    expect(typeof view.mouse.notifyCopied).toBe('function');
    view.mouse.notifyCopied?.('single line');
    await waitFor(view.fullFrame, 'Copied to clipboard');

    view.mouse.notifyCopied?.('first\nsecond\nthird');
    await waitFor(view.fullFrame, 'Copied 3 lines to clipboard');

    view.stdin.write('\x0f'); // Ctrl+O
    await waitFor(view.fullFrame, 'Showing detailed transcript');

    view.mouse.notifyCopied?.('one line');
    await waitFor(view.fullFrame, 'copied to clipboard');

    view.mouse.notifyCopied?.('alpha\nbeta');
    await waitFor(view.fullFrame, 'copied 2 lines');
  } finally {
    view.unmount();
  }
});

test('a single-theme start still measures the terminal background so turning sync on picks the right slot', async () => {
  const terminal = terminalAnswering('\x1b]11;rgb:ffff/ffff/ffff\x07');
  const fixture = dialogFixture({startSession: () => ({id: 'session-1', selection, messages: []})});
  // A fixed dark mode, as a single GitHub theme stores: nothing asks for the background but sync later.
  const engine = new ThemeEngine({env: {NO_COLOR: '1', COSMEW_THEME_MODE: 'dark'}});
  await engine.setTheme('github-dark');
  const run = runInkTui({
    client: fixture.client,
    stdout: asWrite(terminal.stdout),
    stdin: asRead(terminal.stdin),
    themeEngine: engine,
    slots: {status: <Text>RUNTIME_READY</Text>},
  });
  await waitFor(() => terminal.stdout.frames.join(''), 'RUNTIME_READY');
  expect(engine.getCommittedAppearance().mode).not.toBe('system');
  expect(terminal.written[0]).toBe('\x1b]11;?\x07');
  await engine.setSync({enabled: true});
  expect(engine.getActiveThemeManifest().id).toBe('github-light');
  process.emit('SIGTERM');
  await run;
});
