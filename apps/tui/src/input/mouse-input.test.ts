import {expect, test} from 'bun:test';
import {PassThrough} from 'node:stream';
import {
  createTerminalMouseInput,
  DISABLE_TERMINAL_MOUSE,
  ENABLE_TERMINAL_MOUSE,
  MouseInputFilter,
  type TerminalWheel,
} from './mouse-input';

test('split and coalesced SGR wheel reports are consumed without changing surrounding Unicode or keys', () => {
  const report = '\x1b[<64;20;10M';
  for (let split = 1; split < report.length; split++) {
    const parser = new MouseInputFilter();
    const events: TerminalWheel[] = [];
    const emit = (event: TerminalWheel) => events.push(event);
    const text =
      parser.feed('Việt ' + report.slice(0, split), emit) +
      parser.feed(report.slice(split) + '\x1b[<65;9;4M\x1b[A\r日本語', emit);
    expect(text).toBe('Việt \x1b[A\r日本語');
    expect(events).toEqual([
      {direction: -1, column: 20, row: 10},
      {direction: 1, column: 9, row: 4},
    ]);
  }
});

test('mouse clicks, releases and motion cannot type text or trigger wheel navigation', () => {
  const parser = new MouseInputFilter();
  const events: TerminalWheel[] = [];
  expect(parser.feed('\x1b[<0;5;6M\x1b[<0;5;6m\x1b[<32;5;6M\x1b[<64;5;6m', e => events.push(e))).toBe('');
  expect(events).toEqual([]);
  expect(parser.feed('\x1b[<80;5;6M', e => events.push(e))).toBe('');
  expect(events).toEqual([{direction: -1, column: 5, row: 6}]);
});

test('bracketed paste and terminal strings containing mouse-like text never scroll', () => {
  const report = '\x1b[<64;2;3M';
  const paste = `\x1b[200~literal ${report}\x1b[201~`;
  for (let split = 0; split <= paste.length; split++) {
    const parser = new MouseInputFilter();
    const events: TerminalWheel[] = [];
    const emit = (event: TerminalWheel) => events.push(event);
    expect(parser.feed(paste.slice(0, split), emit) + parser.feed(paste.slice(split), emit)).toBe(paste);
    expect(events).toEqual([]);
    expect(parser.feed(report, emit)).toBe('');
    expect(events).toHaveLength(1);
  }
  const parser = new MouseInputFilter();
  const events: TerminalWheel[] = [];
  for (const text of [`\x1b]title:${report}\x07`, `\x1bP${report}\x1b\\`])
    expect(parser.feed(text, e => events.push(e))).toBe(text);
  expect(events).toEqual([]);
});

test('legacy wheel reports are consumed while ordinary Escape and non-mouse CSI stay intact', () => {
  const parser = new MouseInputFilter();
  const events: TerminalWheel[] = [];
  expect(parser.feed('\x1b[M' + String.fromCharCode(96, 42, 37), e => events.push(e))).toBe('');
  expect(events).toEqual([{direction: -1, column: 10, row: 5}]);
  expect(parser.feed('\x1b[1;5A', () => {})).toBe('\x1b[1;5A');
  expect(parser.feed('\x1b', () => {})).toBe('');
  expect(parser.flush()).toBe('\x1b');
  parser.feed('\x1b[<' + '1'.repeat(10000), () => {});
  expect(parser.hasPending).toBe(false);
});

class Input extends PassThrough {
  isTTY = true;
  modes: boolean[] = [];
  setRawMode(mode: boolean) {
    this.modes.push(mode);
    return this;
  }
}

test('stream facade owns no input listener and resets mouse modes across editor suspension and exit', async () => {
  const source = new Input();
  const output = new PassThrough();
  let modes = '';
  output.on('data', chunk => {
    modes += String(chunk);
  });
  const bridge = createTerminalMouseInput(source, output);
  const events: TerminalWheel[] = [];
  bridge.subscribe(event => events.push(event));
  bridge.stdin.setEncoding('utf8');
  expect(source.listenerCount('data')).toBe(0);
  bridge.stdin.setRawMode!(true);
  expect(modes).toBe(ENABLE_TERMINAL_MOUSE);
  source.write('draft\x1b[<64;20;');
  expect(bridge.stdin.read()).toBe('draft');
  await Bun.sleep(30); // A split mouse report is never flushed into the composer as text.
  expect(bridge.stdin.read()).toBeNull();
  source.write('10M');
  expect(bridge.stdin.read()).toBeNull();
  expect(events).toEqual([{direction: -1, column: 20, row: 10}]);
  bridge.stdin.setRawMode!(false);
  expect(modes).toBe(ENABLE_TERMINAL_MOUSE + DISABLE_TERMINAL_MOUSE);
  bridge.stdin.setRawMode!(true);
  source.write('\x1b[<65;20;10M');
  expect(bridge.stdin.read()).toBeNull();
  expect(events.at(-1)?.direction).toBe(1);
  bridge.dispose();
  expect(source.modes).toEqual([true, false, true]);
  expect(modes).toBe((ENABLE_TERMINAL_MOUSE + DISABLE_TERMINAL_MOUSE).repeat(2));
  expect(source.listenerCount('data')).toBe(0);
  source.destroy();
  output.destroy();
});

test('left presses are separate control events; releases, motion, modifiers and paste cannot activate controls', () => {
  const report = '\x1b[<0;100;4M';
  for (let split = 1; split < report.length; split++) {
    const parser = new MouseInputFilter();
    const clicks: unknown[] = [];
    const wheels: TerminalWheel[] = [];
    const wheel = (event: TerminalWheel) => wheels.push(event);
    const click = (event: unknown) => clicks.push(event);
    expect(
      parser.feed(report.slice(0, split), wheel, click) + parser.feed(report.slice(split) + '\t', wheel, click),
    ).toBe('\t');
    expect(clicks).toEqual([{kind: 'click', column: 100, row: 4}]);
    parser.feed('\x1b[<0;100;4m\x1b[<32;100;4M\x1b[<4;100;4M\x1b[200~' + report + '\x1b[201~', wheel, click);
    expect(clicks).toHaveLength(1);
    expect(wheels).toEqual([]);
  }
});

test('native text selection releases mouse capture without ending raw input or leaking mouse reports', () => {
  const source = new Input();
  const output = new PassThrough();
  let modes = '';
  output.on('data', chunk => {
    modes += String(chunk);
  });
  const bridge = createTerminalMouseInput(source, output);
  const events: unknown[] = [];
  bridge.subscribeMouse!(event => events.push(event));
  bridge.stdin.setEncoding('utf8');
  bridge.stdin.setRawMode!(true);
  bridge.setCaptureEnabled!(false);
  expect(modes).toBe(ENABLE_TERMINAL_MOUSE + DISABLE_TERMINAL_MOUSE);
  expect(source.modes).toEqual([true]);
  source.write('Việt\x1b[<64;2;3M\x1b[<0;2;3M\x1b[A');
  expect(bridge.stdin.read()).toBe('Việt\x1b[A');
  expect(events).toEqual([]);
  bridge.stdin.setRawMode!(false);
  bridge.stdin.setRawMode!(true);
  expect(modes).toBe(ENABLE_TERMINAL_MOUSE + DISABLE_TERMINAL_MOUSE);
  bridge.setCaptureEnabled!(true);
  expect(modes).toBe(ENABLE_TERMINAL_MOUSE + DISABLE_TERMINAL_MOUSE + ENABLE_TERMINAL_MOUSE);
  source.write('\x1b[<65;2;3M');
  bridge.stdin.read();
  expect(events).toEqual([{direction: 1, column: 2, row: 3}]);
  bridge.dispose();
  source.destroy();
  output.destroy();
});
