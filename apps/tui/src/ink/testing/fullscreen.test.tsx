/** @jsxImportSource react */
import {useTerminalSize} from '../hooks/use-terminal-size';
import {afterEach, expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanup} from 'ink-testing-library';
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
  }
  write = (frame: string, callback?: () => void) => {
    this.frames.push(frame);
    if (callback) queueMicrotask(callback);
    this.last = frame;
    // Ink reads stdin in paused mode (`readable` + `read()`), not via `data`.
    if (this.listenerCount('readable') > 0) {
      this.pending.push(frame);
      this.emit('readable');
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

function openSized(columns: number, rows: number, debug = true, answerLines = 0, hang = false) {
  const prompts: string[] = [];
  let client: ReturnType<typeof dialogFixture>['client'];
  const fixture = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'session-1', selection, messages: []}),
    async *sendTurn(_id, content, signal): AsyncIterable<ModelEvent> {
      prompts.push(content);
      if (answerLines) {
        yield {
          type: 'textDelta',
          text: Array.from({length: answerLines}, (_, index) => `answer line ${index + 1}`).join('\n\n'),
        };
        if (hang) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve()));
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
    stdout,
    stdin,
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

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 40));

async function waitFor(read: () => string, text: string) {
  const deadline = Date.now() + 4000;
  while (!read().includes(text) && Date.now() < deadline) await settle();
  expect(read(), text).toContain(text);
}

/** Opens the app past the startup gate, then returns the ready view. */
async function openReady(columns: number, rows: number, debug = true, answerLines = 0, hang = false) {
  const view = openSized(columns, rows, debug, answerLines, hang);
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
      expect(frame[rule + 3]!.trim()).toBe('');
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
    for (let wait = 0; wait < 100 && view.fullFrame().includes('Jump to bottom'); wait++) await settle();
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
    output.indexOf('Resume this session with: fyn --resume session-1'),
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
  expect(new ThemeEngine({env: {FUTRYN_THEME_MODE: 'light'}}).getEffectiveMode()).toBe('light');
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

test('detailed transcript: { and } jump between prompts, Ctrl+Home/Ctrl+End go to the ends, q leaves', async () => {
  const view = await openReady(100, 30, true, 40);
  try {
    for (const prompt of ['first prompt', 'second prompt']) {
      view.stdin.write(prompt);
      await settle();
      view.stdin.write('\r');
      await waitFor(view.fullFrame, 'answer line 40');
      for (let wait = 0; wait < 50 && !view.fullFrame().includes('manual mode on'); wait++) await settle();
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
    const view = await openReady(80, 24, true, 2);
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
      const deadline = Date.now() + 3000;
      while (!(await stat(copy).catch(() => undefined)) && Date.now() < deadline) await settle();
      expect(await readFile(copy, 'utf8')).toContain('> editor prompt\n\nanswer line 1');
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
    await Bun.sleep(100);
    expect(escapes).toBe(1); // Actual Escape still reaches the input layer.
  } finally {
    view.unmount();
  }
});
