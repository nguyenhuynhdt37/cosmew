import {expect, test} from 'bun:test';
import {PassThrough} from 'node:stream';
import {createTerminalMouseInput} from './mouse-input';
import {createScreenSelectionBridge} from './screen-selection';

class ScreenStream extends PassThrough {
  isTTY = true;
  columns: number;
  rows: number;
  chunks: string[] = [];

  constructor(columns = 20, rows = 6, isTTY = true) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = isTTY;
  }

  override write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void),
    callback?: (error: Error | null | undefined) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.chunks.push(text);
    if (typeof encodingOrCallback === 'function') {
      return super.write(chunk, encodingOrCallback);
    }
    if (encodingOrCallback !== undefined) {
      return super.write(chunk, encodingOrCallback, callback);
    }
    return super.write(chunk, callback);
  }
}

class RawInput extends PassThrough {
  isTTY = true;
  setRawMode() {
    return this;
  }
}

function createHarness(
  options: {columns?: number; rows?: number; isTTY?: boolean; copyResult?: boolean | Promise<boolean>} = {},
) {
  const stdin = new RawInput();
  const rawStdout = new ScreenStream(options.columns ?? 20, options.rows ?? 6, options.isTTY ?? true);
  const mouse = createTerminalMouseInput(stdin, rawStdout);
  const copied: string[] = [];
  const notified: string[] = [];
  mouse.subscribeCopied?.(text => notified.push(text));
  const bridge = createScreenSelectionBridge({
    stdout: rawStdout,
    mouse,
    copyText: async text => {
      copied.push(text);
      return options.copyResult ?? true;
    },
  });
  stdin.setEncoding('utf8');
  mouse.stdin.setRawMode!(true);
  rawStdout.chunks.length = 0; // Ignore initial ENABLE_TERMINAL_MOUSE write.
  return {
    stdin,
    rawStdout,
    mouse,
    bridge,
    copied,
    notified,
    cleanup() {
      bridge.dispose();
      mouse.dispose();
      stdin.destroy();
      rawStdout.destroy();
    },
  };
}

test('stdout proxy preserves stream metadata, write callbacks, and decodes control chars and scrolling', async () => {
  const h = createHarness({columns: 10, rows: 3});
  try {
    expect(h.bridge.stdout.isTTY).toBe(true);
    expect(h.bridge.stdout.columns).toBe(10);
    expect(h.bridge.stdout.rows).toBe(3);

    let flushed = false;
    const ok = await new Promise<boolean>(resolve => {
      const wrote = h.bridge.stdout.write('ab\tcd', () => {
        flushed = true;
        resolve(wrote);
      });
    });
    expect(ok).toBe(true);
    expect(flushed).toBe(true);
    // 'ab' -> col 2, '\t' -> col 8, 'cd' -> cols 8..9 (columns=10)
    expect(h.bridge.lines()).toEqual(['ab      cd', '', '']);

    h.bridge.stdout.write('\r\n123\b4\r\nline3\r\nline4');
    expect(h.bridge.lines()).toEqual(['124', 'line3', 'line4']);
  } finally {
    h.cleanup();
  }
});

test('VT decoder handles CSI cursor/erase, DECSC/DECRC, RIS, alt-screen, and split UTF-8/OSC/DCS chunks', () => {
  const h = createHarness({columns: 16, rows: 5});
  try {
    // Write styled text + OSC 8 hyperlink + DCS split across multiple writes + split UTF-8 bytes for 'Việt'.
    const vietBytes = Buffer.from('Việt', 'utf8');
    h.bridge.stdout.write('\x1b[38;5;45m');
    h.bridge.stdout.write(vietBytes.subarray(0, 3));
    h.bridge.stdout.write(vietBytes.subarray(3));
    h.bridge.stdout.write(' \x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\');
    h.bridge.stdout.write('\x1bPignored');
    h.bridge.stdout.write(' dcs\x1b\\!');
    expect(h.bridge.lines()[0]).toBe('Việt link!');

    // Cursor positioning: H, f, A, B, C, D, E, F, G, `, d, s, u
    h.bridge.stdout.write('\x1b[2;3Hrow2');
    h.bridge.stdout.write('\x1b[3;1fA\x1b[2C>'); // col 1='A', forward 2 -> col 4='>'
    h.bridge.stdout.write('\x1b[1B\x1b[2D<'); // down to row 4, back 2 -> col 3='<'
    h.bridge.stdout.write('\x1b[1Erow5'); // next line col 1 -> row 5
    h.bridge.stdout.write('\x1b[1Ftop'); // prev line col 1 -> row 4
    h.bridge.stdout.write('\x1b[6G!'); // row 4 col 6
    h.bridge.stdout.write('\x1b[8`?'); // row 4 col 8
    h.bridge.stdout.write('\x1b[2d\x1b[10G'); // row 2 col 10
    h.bridge.stdout.write('\x1b[sXX\x1b[uYY'); // save/restore CSI s/u -> YY overwrites XX
    expect(h.bridge.lines()).toEqual(['Việt link!', '  row2   YY', 'A  >', 'top  ! ?', 'row5']);

    // Erase X, K (0/1/2), J (0/1/2)
    h.bridge.stdout.write('\x1b[1;6H\x1b[4X'); // erase 4 chars from col 6 on row 1 ('link' -> spaces)
    expect(h.bridge.lines()[0]).toBe('Việt     !');
    h.bridge.stdout.write('\x1b[1;6H\x1b[0K'); // erase to end of line 1
    expect(h.bridge.lines()[0]).toBe('Việt');
    h.bridge.stdout.write('\x1b[2;5H\x1b[1K'); // erase from start of line 2 through col 5
    expect(h.bridge.lines()[1]).toBe('     2   YY');
    h.bridge.stdout.write('\x1b[4;1H\x1b[2K'); // erase whole line 4
    expect(h.bridge.lines()[3]).toBe('');
    h.bridge.stdout.write('\x1b[3;2H\x1b[0J'); // erase from (3,2) to end of screen
    expect(h.bridge.lines()).toEqual(['Việt', '     2   YY', 'A', '', '']);

    // DECSC/DECRC (\x1b7 / \x1b8) & CSI split across chunks
    h.bridge.stdout.write('\x1b[4;1H\x1b7abc\x1b8XY');
    expect(h.bridge.lines()[3]).toBe('XYc');
    h.bridge.stdout.write('\x1b[');
    h.bridge.stdout.write('5;');
    h.bridge.stdout.write('2Hok');
    expect(h.bridge.lines()[4]).toBe(' ok');

    // ?1049h clears screen and homes cursor; RIS (\x1bc) also resets.
    h.bridge.stdout.write('\x1b[?1049hfresh');
    expect(h.bridge.lines()).toEqual(['fresh', '', '', '', '']);
    h.bridge.stdout.write('\x1bcreset');
    expect(h.bridge.lines()).toEqual(['reset', '', '', '', '']);
  } finally {
    h.cleanup();
  }
});

test('Unicode width handles NFD combining marks (even at line end) and CJK/emoji continuation cells', () => {
  const h = createHarness({columns: 6, rows: 4});
  try {
    // 6-col row: '12345e' + NFD combining acute at col 6 -> stays on row 1; next char wraps to row 2.
    h.bridge.stdout.write('12345e\u0301Z');
    expect(h.bridge.lines()).toEqual(['12345e\u0301', 'Z', '', '']);

    // CJK width=2 at col 6 (only 1 cell left) wraps cleanly to row 3.
    h.bridge.stdout.write('\x1b[2;1H12345中');
    expect(h.bridge.lines()).toEqual(['12345e\u0301', '12345', '中', '']);

    // Split UTF-16 surrogate pair for 🚀 across two string writes.
    const rocket = '🚀';
    h.bridge.stdout.write('\x1b[4;1H' + rocket[0]!);
    h.bridge.stdout.write(rocket[1]! + 'ok');
    expect(h.bridge.lines()[3]).toBe('🚀ok');

    // Extracting starting on continuation cell of '中' (col 2) backs up to col 1 so '中' is preserved.
    expect(h.bridge.extract({column: 2, row: 3}, {column: 4, row: 3})).toBe('中');
    expect(h.bridge.extract({column: 2, row: 4}, {column: 4, row: 4})).toBe('🚀ok');

    // Overwriting the continuation cell clears the orphaned wide glyph cleanly.
    h.bridge.stdout.write('\x1b[3;2Hx');
    expect(h.bridge.lines()[2]).toBe(' x');
  } finally {
    h.cleanup();
  }
});

test('extract normalizes forward/reverse ranges, clamps out-of-bounds points, trims edges, and keeps middle blank lines', () => {
  const h = createHarness({columns: 16, rows: 5});
  try {
    h.bridge.stdout.write('  alpha  \r\n\r\nbeta gamma\r\n   \r\nomega');
    // Reverse drag from (4, 3) up-left to (3, 1)
    expect(h.bridge.extract({column: 4, row: 3}, {column: 3, row: 1})).toBe('alpha\n\nbeta');
    // Same-line reverse drag
    expect(h.bridge.extract({column: 10, row: 3}, {column: 6, row: 3})).toBe('gamma');
    // Leading/trailing blank lines inside selection are stripped, out-of-bounds clamped
    expect(h.bridge.extract({column: 0, row: 0}, {column: 99, row: 99})).toBe('  alpha\n\nbeta gamma\n\nomega');
    // Whitespace-only region returns empty string
    expect(h.bridge.extract({column: 1, row: 4}, {column: 10, row: 4})).toBe('');
  } finally {
    h.cleanup();
  }
});

test('single click without drag does not highlight or copy; drag highlights, shrinks on move, restores on end, and copies', async () => {
  const h = createHarness({columns: 20, rows: 4});
  try {
    h.bridge.stdout.write('hello world\r\nsecond line');
    h.rawStdout.chunks.length = 0;

    // Plain click (plus same-cell jitter) must not highlight or copy.
    h.stdin.write('\x1b[<0;2;1M\x1b[<32;2;1M\x1b[<0;2;1m');
    h.mouse.stdin.read();
    await Bun.sleep(0);
    expect(h.rawStdout.chunks.join('')).toBe('');
    expect(h.copied).toEqual([]);
    expect(h.notified).toEqual([]);

    // Drag across rows: start (7,1) -> move (15,1) -> move (5,2) -> shrink back to (9,1) -> end (9,1).
    h.stdin.write('\x1b[<0;7;1M\x1b[<32;15;1M');
    h.mouse.stdin.read();
    const drag1 = h.rawStdout.chunks.join('');
    expect(drag1).toContain('\x1b7');
    expect(drag1).toContain('\x1b[1;7H\x1b[7mworld    \x1b[0m');
    expect(drag1).toContain('\x1b8');

    h.rawStdout.chunks.length = 0;
    h.stdin.write('\x1b[<32;5;2M');
    h.mouse.stdin.read();
    const drag2 = h.rawStdout.chunks.join('');
    expect(drag2).toContain('\x1b[1;7H\x1b[7mworld         \x1b[0m');
    expect(drag2).toContain('\x1b[2;1H\x1b[7msecon\x1b[0m');

    // Shrink selection back to line 1 cols 7..9 -> line 2 must be unhighlighted and line 1 cols 10..20 restored.
    h.rawStdout.chunks.length = 0;
    h.stdin.write('\x1b[<32;9;1M');
    h.mouse.stdin.read();
    const shrunk = h.rawStdout.chunks.join('');
    expect(shrunk).toContain('\x1b[2;1H\x1b[0msecon');
    expect(shrunk).toContain('\x1b[1;10H\x1b[0mld         ');
    expect(shrunk).toContain('\x1b[1;7H\x1b[7mwor\x1b[0m');

    // End drag -> restores remaining highlight and triggers copyText + notifyCopied.
    h.rawStdout.chunks.length = 0;
    h.stdin.write('\x1b[<0;9;1m');
    h.mouse.stdin.read();
    const released = h.rawStdout.chunks.join('');
    expect(released).toContain('\x1b[1;7H\x1b[0mwor');
    expect(released).not.toContain('\x1b[7m');
    await Bun.sleep(0);
    expect(h.copied).toEqual(['wor']);
    expect(h.notified).toEqual(['wor']);
  } finally {
    h.cleanup();
  }
});

test('non-TTY skips overlay escape writes while still copying; failed copyText never notifies or throws', async () => {
  const h = createHarness({columns: 20, rows: 3, isTTY: false, copyResult: false});
  try {
    h.bridge.stdout.write('copy me');
    h.rawStdout.chunks.length = 0;
    h.stdin.write('\x1b[<0;1;1M\x1b[<32;4;1M\x1b[<0;4;1m');
    h.mouse.stdin.read();
    await Bun.sleep(0);
    expect(h.rawStdout.chunks.join('')).toBe('');
    expect(h.copied).toEqual(['copy']);
    expect(h.notified).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test('Ink writes during an active drag update VirtualScreen cleanly and repaint the highlight overlay', () => {
  const h = createHarness({columns: 20, rows: 3});
  try {
    h.bridge.stdout.write('initial text');
    h.stdin.write('\x1b[<0;1;1M\x1b[<32;7;1M');
    h.mouse.stdin.read();

    h.rawStdout.chunks.length = 0;
    h.bridge.stdout.write('\x1b[1;1Hupdated text');
    const painted = h.rawStdout.chunks.join('');
    expect(painted).toContain('\x1b[1;1H\x1b[7mupdated\x1b[0m');
    // VirtualScreen lines never get polluted by overlay escape sequences.
    expect(h.bridge.lines()[0]).toBe('updated text');

    // Split CSI across two writes mid-drag must not inject highlight escapes inside the partial CSI.
    h.rawStdout.chunks.length = 0;
    h.bridge.stdout.write('\x1b[1;1');
    expect(h.rawStdout.chunks).toEqual(['\x1b[1;1']);
    h.bridge.stdout.write('Hrewritten');
    expect(h.rawStdout.chunks[1]).toBe('Hrewritten');
    expect(h.rawStdout.chunks[2]).toContain('\x1b[1;1H\x1b[7mrewritt\x1b[0m');

    // Disposing mid-drag clears the active highlight cleanly.
    h.rawStdout.chunks.length = 0;
    h.bridge.dispose();
    const disposedOut = h.rawStdout.chunks.join('');
    expect(disposedOut).toContain('\x1b[1;1H\x1b[0mrewritt');
    expect(disposedOut).not.toContain('\x1b[7m');
  } finally {
    h.cleanup();
  }
});

test('rejected copyText promise is swallowed safely without notifying', async () => {
  const stdin = new RawInput();
  const rawStdout = new ScreenStream(20, 3, true);
  const mouse = createTerminalMouseInput(stdin, rawStdout);
  const notified: string[] = [];
  mouse.subscribeCopied?.(text => notified.push(text));
  const bridge = createScreenSelectionBridge({
    stdout: rawStdout,
    mouse,
    copyText: async () => {
      throw new Error('clipboard unavailable');
    },
  });
  stdin.setEncoding('utf8');
  mouse.stdin.setRawMode!(true);
  try {
    bridge.stdout.write('hello');
    stdin.write('\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m');
    mouse.stdin.read();
    await Bun.sleep(10);
    expect(notified).toEqual([]);
  } finally {
    bridge.dispose();
    mouse.dispose();
    stdin.destroy();
    rawStdout.destroy();
  }
});

test('stdout resize updates virtual screen dimensions for lines and extract', () => {
  const h = createHarness({columns: 10, rows: 3});
  try {
    h.bridge.stdout.write('1234567890\r\nsecond\r\nthird');
    h.rawStdout.columns = 5;
    h.rawStdout.rows = 2;
    h.rawStdout.emit('resize');
    expect(h.bridge.lines()).toEqual(['12345', 'secon']);
    expect(h.bridge.extract({column: 1, row: 1}, {column: 10, row: 3})).toBe('12345\nsecon');
  } finally {
    h.cleanup();
  }
});
