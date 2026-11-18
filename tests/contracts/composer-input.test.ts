import {expect, test} from 'bun:test';
import {TerminalInputDecoder, parseRawTerminalKey} from '../../apps/tui/src/input/terminal-keys';
import {ChatController} from '../../apps/tui/src/features/chat/controller';
import {updateComposerValue} from '../../apps/tui/src/features/composer/logic';
import type {TuiHost} from '../../apps/tui/src/core/feature';

const chatFixture = () => {
  const commands: string[] = [];
  const chat = new ChatController({
    setBanner() {},
    runSlashCommand: async (command: string) => {
      commands.push(command);
    },
    client: {activeSession: () => null, isSkillCommand: () => false},
  } as unknown as TuiHost);
  return {chat, commands};
};

test('word editing, verbose transcript and reverse history search preserve drafts', async () => {
  const {chat} = chatFixture();
  chat.composer = updateComposerValue(chat.composer, 'first 日本語 final');
  await chat.handleKey('Alt+ArrowLeft');
  expect(chat.composer.cursor).toBe(10);
  await chat.handleKey('Ctrl+W');
  expect(chat.composer.value).toBe('first final');
  await chat.handleKey('Ctrl+U');
  expect(chat.composer.value).toBe('final');
  chat.composer.history = ['inspect tests', 'build project', 'inspect module'];
  await chat.handleKey('Alt+R');
  for (const ch of 'inspect') await chat.handleKey(ch);
  expect(chat.composer.value).toBe('inspect module');
  await chat.handleKey('Alt+R');
  expect(chat.composer.value).toBe('inspect tests');
  await chat.handleKey('Escape');
  expect(chat.composer.value).toBe('final');
  expect(parseRawTerminalKey('\x1bb\x1bf\x1br\x0f')).toEqual(['Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+R', 'Ctrl+O']);
});

test('keyboard selection replaces whole graphemes on typing and paste', async () => {
  const {chat} = chatFixture();
  chat.composer = updateComposerValue(chat.composer, 'first 日本👩🏽‍💻');
  await chat.handleKey('Shift+ArrowLeft');
  await chat.handleKey('Shift+ArrowLeft');
  await chat.handleKey('x');
  expect(chat.composer.value).toBe('first 日x');
  await chat.handleKey('Shift+ArrowLeft');
  await chat.handleKey('Paste:replacement');
  expect(chat.composer.value).toBe('first 日replacement');
  expect(parseRawTerminalKey('\x1b[1;2D\x1b[1;2C')).toEqual(['Shift+ArrowLeft', 'Shift+ArrowRight']);
});

test('bracketed paste survives chunk boundaries as literal data, including newlines and shortcuts', async () => {
  const decoder = new TerminalInputDecoder();
  const {chat, commands} = chatFixture();
  const keys: string[] = [];
  for (const chunk of ['\x1b[20', '0~/exit\r\n!touch marker\x03\x1b[', '201~']) keys.push(...decoder.feed(chunk));
  expect(keys).toHaveLength(1);
  expect(keys[0]).toStartWith('Paste:');
  for (const key of keys) await chat.handleKey(key);
  expect(commands).toEqual([]);
  expect(chat.composer.value).toBe('/exit\n!touch marker');
  expect(chat.composer.slashMenuOpen).toBe(false);
});

test('paste flush never submits an incomplete paste or loses its trailing marker', () => {
  const decoder = new TerminalInputDecoder();
  expect(decoder.feed('\x1b[200~one\r')).toEqual([]);
  expect(decoder.flush()).toEqual([]);
  expect(decoder.feed('two\x1b[20')).toEqual([]);
  expect(decoder.flush()).toEqual([]);
  expect(decoder.feed('1~')).toEqual(['Paste:one\ntwo']);
});

test('cursor movement, deletion and line boundaries preserve Unicode graphemes', async () => {
  const {chat} = chatFixture();
  const value = 'A👨‍👩‍👧‍👦e\u0301\n日本';
  chat.composer = updateComposerValue(chat.composer, value);
  await chat.handleKey('Home');
  expect(chat.composer.cursor).toBe(value.indexOf('日'));
  await chat.handleKey('ArrowUp');
  expect(chat.composer.cursor).toBe(0);
  await chat.handleKey('ArrowRight');
  await chat.handleKey('Delete');
  expect(chat.composer.value).toBe('Ae\u0301\n日本');
  await chat.handleKey('ArrowRight');
  await chat.handleKey('Backspace');
  expect(chat.composer.value).toBe('A\n日本');
  await chat.handleKey('End');
  expect(chat.composer.cursor).toBe(1);
  expect(parseRawTerminalKey('\x1b[H\x1b[F\x1b[13;2u')).toEqual(['Home', 'End', 'Shift+Enter']);
});

test('astral keyboard input is one printable key and inserts intact', async () => {
  const {chat} = chatFixture();
  expect(parseRawTerminalKey('😀')).toEqual(['😀']);
  await chat.handleKey('😀');
  expect(chat.composer.value).toBe('😀');
  await chat.handleKey('Backspace');
  expect(chat.composer.value).toBe('');
});

test('canvas and composer wrap wide glyphs without splitting graphemes or terminal columns', async () => {
  const {Canvas} = await import('../../apps/tui/src/ui/canvas');
  const {renderPromptComposerLines} = await import('../../apps/tui/src/features/composer/view');
  const {deriveTokensFromTriplet} = await import('@futryn/tui');
  const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
  const canvas = new Canvas(6, 1, 'white', 'black');
  canvas.spans(0, 0, [{text: '日😀e\u0301x', fg: 'white'}]);
  expect(canvas.cells[0]!.map(cell => cell.ch)).toEqual(['日', '', '😀', '', 'e\u0301', 'x']);
  const small = new Canvas(1, 1, 'white', 'black');
  small.spans(0, 0, [{text: '日', fg: 'white'}]);
  expect(small.cells[0]![0]!.ch).toBe(' ');
  for (const width of [12, 20, 80]) {
    const {chat} = chatFixture();
    chat.composer = updateComposerValue(chat.composer, '日😀e\u0301'.repeat(12));
    const lines = renderPromptComposerLines({
      width,
      state: chat.composer,
      mode: 'chat',
      activeModelLabel: '',
      activeAccountLabel: '',
      isStreaming: false,
      focused: true,
      tokens,
      borderStyle: 'rounded',
    });
    expect(lines.every(line => Bun.stringWidth(line.spans.map(span => span.text).join('')) <= width)).toBe(true);
  }
});

test('request failure restores submitted input', async () => {
  const {FutrynError} = await import('@futryn/contracts');
  let release!: () => void;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  const chat = new ChatController({
    setBanner() {},
    client: {
      status: () => ({}),
      takeQueuedMessage: () => undefined,
      sendMessage: async function* () {
        await ready;
        throw new FutrynError('AUTH');
      },
    },
  } as unknown as TuiHost);
  chat.composer = updateComposerValue(chat.composer, 'preserve me');
  const task = chat.submit(chat.composer.value);
  release();
  await task;
  expect(chat.composer.value).toBe('preserve me');
});

test('tool output events request a frame after mutation even without an SDK reactive event', async () => {
  let observed = '';
  let observedBeforeCompletion = '';
  let chat!: ChatController;
  chat = new ChatController({
    setBanner() {},
    requestRender() {
      observed = chat.transcript.at(-1)?.toolOutput?.call ?? '';
    },
    client: {
      status: () => ({}),
      takeQueuedMessage: () => undefined,
      projectContext: () => null,
      queuedInput: () => [],
      sendMessage: async function* () {
        yield {type: 'toolOutputDelta', callId: 'call', name: 'exec_command', stream: 'stdout', text: 'live output'};
        observedBeforeCompletion = observed;
        yield {type: 'completed', usage: {inputTokens: 1, outputTokens: 1}, finishReason: 'stop'};
      },
    },
  } as unknown as TuiHost);
  await chat.submit('run');
  expect(observedBeforeCompletion).toBe('live output');
  expect(observed).toBe('live output');
});

test('async failures preserve a newer draft and stale events cannot repopulate a cleared transcript', async () => {
  const {FutrynError} = await import('@futryn/contracts');
  for (const clear of [false, true]) {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {
      release = resolve;
    });
    const banners: string[] = [];
    const chat = new ChatController({
      setBanner: (text: string) => {
        banners.push(text);
      },
      client: {
        status: () => ({}),
        takeQueuedMessage: () => undefined,
        sendMessage: async function* () {
          await ready;
          if (clear) yield {type: 'textDelta', text: 'stale'};
          throw new FutrynError('AUTH');
        },
      },
    } as unknown as TuiHost);
    chat.composer = updateComposerValue(chat.composer, 'original');
    const task = chat.submit(chat.composer.value);
    chat.composer = updateComposerValue(chat.composer, 'newer draft');
    if (clear) chat.clear();
    release();
    await task;
    expect(chat.composer.value).toBe('newer draft');
    if (clear) {
      expect(chat.transcript).toEqual([]);
      expect(banners).not.toContain('Error [AUTH]');
    }
  }
});

test('large pasted data stays bounded and terminal sequences remain inert', async () => {
  const decoder = new TerminalInputDecoder();
  expect(decoder.feed('\x1b[200~' + 'x'.repeat(2_000_000))).toEqual([]);
  const keys = decoder.feed('\x1b[201~');
  expect(keys).toHaveLength(1);
  expect(keys[0]!.length).toBe(1_048_576 + 6);
  const other = new TerminalInputDecoder();
  expect(other.feed('\x1b[200~a\x1b[31mred\x1b[0m\x03\x1b]52;c;secret\x07z\x1b[201~')).toEqual(['Paste:aredz']);
});

test('a delayed bracketed paste opening marker cannot expire into executable keyboard input', () => {
  const decoder = new TerminalInputDecoder();
  expect(decoder.feed('\x1b[20')).toEqual([]);
  expect(decoder.flush()).toEqual([]);
  expect(decoder.feed('0~/exit\r\x1b[201~')).toEqual(['Paste:/exit\n']);
});

test('wide glyphs repaint once and selection uses terminal cell coordinates', async () => {
  const {Canvas} = await import('../../apps/tui/src/ui/canvas');
  const {renderAnsiDiff} = await import('../../apps/tui/src/render/ansi-diff');
  const {TextSelection} = await import('../../apps/tui/src/features/selection/logic');
  const canvas = new Canvas(6, 2, 'white', 'black');
  canvas.spans(0, 0, [{text: '日😀e\u0301x', fg: 'white'}]);
  const ansi = renderAnsiDiff(canvas.cells, 2, 'none', null).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  expect(ansi).toBe('日😀e\u0301x      ');
  const plainLines = canvas.cells.map(row => row.map(cell => cell.ch).join(''));
  const selection = new TextSelection();
  selection.begin(
    {cells: canvas.cells, cols: 6, rows: 2, plainLines} as import('../../apps/tui/src/types').FrameSnapshot,
    {row: 0, col: 2},
  );
  selection.release({row: 0, col: 4});
  expect(selection.text()).toBe('😀e\u0301');
});

test('busy shell input keeps its draft and a retained terminal session never reports completion', async () => {
  const banners: string[] = [];
  let executions = 0;
  const chat = new ChatController({
    setBanner: (text: string) => {
      banners.push(text);
    },
    client: {
      toolsEnabled: () => true,
      takeQueuedMessage: () => undefined,
      runShellCommand: async () => {
        executions++;
        return {
          status: 'ok',
          content: 'still running',
          name: 'exec_command',
          callId: 'backend-call',
          sessionId: 'running',
        };
      },
    },
  } as unknown as TuiHost);
  chat.isStreaming = true;
  chat.composer = updateComposerValue(chat.composer, '!long-running');
  await chat.submit(chat.composer.value);
  expect(executions).toBe(0);
  expect(chat.composer.value).toBe('!long-running');
  expect(banners.at(-1)).toContain('draft');
  chat.isStreaming = false;
  await chat.submit(chat.composer.value);
  expect(executions).toBe(1);
  expect(banners.at(-1)).toContain('running');
  expect(banners.at(-1)).not.toContain('finished');
});

test('invalid and unavailable slash commands keep their editable draft', async () => {
  for (const command of ['/unknown-command', '/help invalid-argument']) {
    const {chat} = chatFixture();
    chat.composer = updateComposerValue(chat.composer, command);
    await chat.submit(command);
    expect(chat.composer.value).toBe(command);
  }
});
