import {expect, test} from 'bun:test';
import {PassThrough} from 'node:stream';
import {
  createTerminalMouseInput,
  DISABLE_TERMINAL_MOUSE,
  ENABLE_TERMINAL_MOUSE,
  MouseInputFilter,
  type TerminalSelectionEvent,
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

test('mouse enable/disable sequences keep legacy substrings while adding button-event tracking (?1002h)', () => {
  expect(ENABLE_TERMINAL_MOUSE).toBe('\x1b[?1000h\x1b[?1006h\x1b[?1002h');
  expect(DISABLE_TERMINAL_MOUSE).toBe('\x1b[?1002l\x1b[?1006l\x1b[?1000l');
  expect(ENABLE_TERMINAL_MOUSE.includes('\x1b[?1000h\x1b[?1006h')).toBe(true);
  expect(DISABLE_TERMINAL_MOUSE.includes('\x1b[?1006l\x1b[?1000l')).toBe(true);
});

test('SGR drag emits start, move, and end selection events across split chunks without triggering click or wheel', () => {
  const seq = '\x1b[<0;3;4M\x1b[<32;8;4M\x1b[<32;12;6M\x1b[<0;12;6m';
  for (let split = 1; split < seq.length; split++) {
    const parser = new MouseInputFilter();
    const wheels: TerminalWheel[] = [];
    const clicks: unknown[] = [];
    const selections: TerminalSelectionEvent[] = [];
    const text =
      parser.feed(
        'a' + seq.slice(0, split),
        e => wheels.push(e),
        e => clicks.push(e),
        e => selections.push(e),
      ) +
      parser.feed(
        seq.slice(split) + 'b',
        e => wheels.push(e),
        e => clicks.push(e),
        e => selections.push(e),
      );
    expect(text).toBe('ab');
    expect(wheels).toEqual([]);
    expect(clicks).toEqual([{kind: 'click', column: 3, row: 4}]);
    expect(selections).toEqual([
      {phase: 'start', column: 3, row: 4},
      {phase: 'move', column: 8, row: 4},
      {phase: 'move', column: 12, row: 6},
      {phase: 'end', column: 12, row: 6},
    ]);
  }
});

test('SGR selection ignores modified presses, orphan releases and zero coordinates, while ending pressed drag even with modifiers on release', () => {
  const parser = new MouseInputFilter();
  const clicks: unknown[] = [];
  const selections: TerminalSelectionEvent[] = [];
  const onWheel = () => {};
  const onClick = (e: unknown) => clicks.push(e);
  const onSel = (e: TerminalSelectionEvent) => selections.push(e);

  // Orphan release, modifier press/drag, right click, and zero coordinates must not start or end selection.
  parser.feed(
    '\x1b[<0;5;5m\x1b[<4;5;5M\x1b[<4;5;5m\x1b[<36;6;5M\x1b[<2;5;5M\x1b[<0;0;5M\x1b[<0;5;0M',
    onWheel,
    onClick,
    onSel,
  );
  expect(clicks).toEqual([]);
  expect(selections).toEqual([]);

  // Plain left press starts selection; Shift held when releasing (button=4, (4&3)===0) still ends it cleanly.
  parser.feed('\x1b[<0;4;2M\x1b[<4;9;2m\x1b[<0;9;2m', onWheel, onClick, onSel);
  expect(clicks).toEqual([{kind: 'click', column: 4, row: 2}]);
  expect(selections).toEqual([
    {phase: 'start', column: 4, row: 2},
    {phase: 'end', column: 9, row: 2},
  ]);

  // Reset clears leftPressed so a subsequent release does not emit end.
  parser.feed('\x1b[<0;2;2M', onWheel, onClick, onSel);
  parser.reset();
  parser.feed('\x1b[<0;2;2m', onWheel, onClick, onSel);
  expect(selections).toHaveLength(3);
});

test('legacy X10 drag emits start, move, and end selection events across split chunks', () => {
  const x10 = (btn: number, col: number, row: number) => '\x1b[M' + String.fromCharCode(btn + 32, col + 32, row + 32);
  const seq = x10(0, 2, 3) + x10(32, 7, 3) + x10(3, 7, 3) + x10(3, 7, 3);
  for (let split = 1; split < seq.length; split++) {
    const parser = new MouseInputFilter();
    const wheels: TerminalWheel[] = [];
    const clicks: unknown[] = [];
    const selections: TerminalSelectionEvent[] = [];
    parser.feed(
      seq.slice(0, split),
      e => wheels.push(e),
      e => clicks.push(e),
      e => selections.push(e),
    );
    parser.feed(
      seq.slice(split),
      e => wheels.push(e),
      e => clicks.push(e),
      e => selections.push(e),
    );
    expect(wheels).toEqual([]);
    expect(clicks).toEqual([{kind: 'click', column: 2, row: 3}]);
    expect(selections).toEqual([
      {phase: 'start', column: 2, row: 3},
      {phase: 'move', column: 7, row: 3},
      {phase: 'end', column: 7, row: 3},
    ]);
  }
});

test('terminal mouse facade forwards selection, copied notifications, and resets selection state on capture disable/raw disable/dispose', () => {
  const source = new Input();
  const output = new PassThrough();
  const bridge = createTerminalMouseInput(source, output);
  const selections: TerminalSelectionEvent[] = [];
  const copied: string[] = [];
  const unsubSel = bridge.subscribeSelection!(event => selections.push(event));
  const unsubCopy = bridge.subscribeCopied!(text => copied.push(text));

  bridge.stdin.setEncoding('utf8');
  bridge.stdin.setRawMode!(true);

  source.write('\x1b[<0;2;3M\x1b[<32;5;3M');
  bridge.stdin.read();
  expect(selections).toEqual([
    {phase: 'start', column: 2, row: 3},
    {phase: 'move', column: 5, row: 3},
  ]);

  // Disabling capture clears active drag state so re-enabling + releasing does not emit an orphan end.
  bridge.setCaptureEnabled!(false);
  source.write('\x1b[<0;6;3M\x1b[<32;7;3M');
  bridge.stdin.read();
  expect(selections).toHaveLength(2);
  bridge.setCaptureEnabled!(true);
  source.write('\x1b[<0;7;3m');
  bridge.stdin.read();
  expect(selections).toHaveLength(2);

  // setRawMode(false) also resets selection state cleanly.
  source.write('\x1b[<0;1;1M');
  bridge.stdin.read();
  expect(selections).toHaveLength(3);
  bridge.stdin.setRawMode!(false);
  bridge.stdin.setRawMode!(true);
  source.write('\x1b[<0;1;1m');
  bridge.stdin.read();
  expect(selections).toHaveLength(3);

  // notifyCopied notifies listeners for non-empty strings until disposed.
  bridge.notifyCopied!('');
  bridge.notifyCopied!('selected text');
  expect(copied).toEqual(['selected text']);

  unsubSel();
  unsubCopy();
  source.write('\x1b[<0;2;2M\x1b[<0;2;2m');
  bridge.stdin.read();
  bridge.notifyCopied!('ignored after unsub');
  expect(selections).toHaveLength(3);
  expect(copied).toEqual(['selected text']);

  const lateCopied: string[] = [];
  bridge.subscribeCopied!(text => lateCopied.push(text));
  bridge.dispose();
  bridge.notifyCopied!('after dispose');
  expect(lateCopied).toEqual([]);

  source.destroy();
  output.destroy();
});
