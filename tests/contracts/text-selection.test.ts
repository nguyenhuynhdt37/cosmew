import { expect, test } from 'bun:test';
import { parseRawTerminalKey, TerminalInputDecoder, deriveTokensFromTriplet, type FrameSnapshot, TextSelection } from '@hannes/tui';
const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
function frame(): FrameSnapshot {
  const plainLines = ['  Hello world       ', '  giữ thụt dòng     ', '  third line        ', '                    ', '                    ', '                    ', '                    ', 'status footer       '].map(line => line.padEnd(20).slice(0,20));
  return { cols:20, rows:8, cells:plainLines.map(line => [...line].map(ch => ({ch, fg:tokens.foreground, bg:tokens.background, bold:false}))), plainLines, plainText:plainLines.join('\n'), activeOverlay:'none', activeThemeId:'auto', effectiveMode:'dark', activeWallpaperId:null, isPreviewing:false, isStreaming:false };
}
test('drag selection supports reverse ranges, line indentation, theme highlighting and bounded clipboard writes', () => {
  const selection = new TextSelection(); const base = frame();
  selection.begin(base,{row:1,col:14}); selection.move({row:0,col:2}); selection.release({row:0,col:2});
  expect(selection.text()).toBe('Hello world\n  giữ thụt dòng');
  expect(selection.view(tokens).cells[0]![2]!.selected).toBe(true);
  expect(selection.view(tokens).cells[0]![2]!.bg).toBe(tokens.selection);
  expect(base.cells[0]![2]!.selected).toBeUndefined();
  const sequence = selection.copySequence()!;
  expect(sequence.startsWith('\x1b]52;c;')).toBe(true);
  expect(Buffer.from(sequence.slice(7,-1),'base64').toString()).toBe(selection.text());
  selection.clear(); expect(selection.text()).toBe(''); expect(selection.copySequence()).toBeNull();
  selection.begin(base,{row:0,col:2}); selection.release({row:0,col:2}); expect(selection.frame).toBeNull();
  const large = {...base, cols:1000, rows:100, plainLines:Array(100).fill('x'.repeat(1000))};
  selection.begin(large,{row:0,col:0}); selection.release({row:98,col:999}); expect(selection.copySequence()).toBeNull();
});
test('terminal mouse input survives split PTY chunks; malformed and expired sequences never enter the draft', () => {
  expect(parseRawTerminalKey('\x1b[<0;3;2M\x1b[<32;9;2M\x1b[<0;9;2m')).toEqual(['MouseDown:1:2','MouseDrag:1:8','MouseUp:1:8']);
  expect(parseRawTerminalKey('\x1b[<4;3;2M')).toEqual([]); // Shift remains available to the terminal.
  expect(parseRawTerminalKey('\x1b[<garbageM')).toEqual([]);
  expect(parseRawTerminalKey('\x1b[<0;')).toEqual([]);
  const decoder = new TerminalInputDecoder();
  expect(decoder.feed('\x1b')).toEqual([]); expect(decoder.feed('[<0;')).toEqual([]);
  expect(decoder.feed('3;2M')).toEqual(['MouseDown:1:2']);
  expect(decoder.feed('\x1b[<32;9;')).toEqual([]); expect(decoder.feed('2M')).toEqual(['MouseDrag:1:8']);
  decoder.feed('\x1b[<32;'); expect(decoder.flush()).toEqual([]);
  expect(decoder.feed('9;2Mtext')).toEqual(['t','e','x','t']);
  decoder.feed('\x1b'); expect(decoder.flush()).toEqual(['Escape']);
  const bytes = new TextEncoder().encode('ữ');
  expect(decoder.feed(bytes.slice(0,1))).toEqual([]); expect(decoder.feed(bytes.slice(1))).toEqual(['ữ']);
});

test('clipboard delivery prefers native UTF-8 and falls back on host failure without leaking controls', async () => {
  const { deliverClipboard } = await import('../../apps/tui/src/clipboard');
  const text = '  giữ thụt dòng\n日本語';
  const sequence = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
  const terminal: string[] = []; const native: string[] = [];
  await deliverClipboard(sequence, value => terminal.push(value), async value => { native.push(value); return true; });
  expect(native).toEqual([text]); expect(terminal).toEqual([]);
  await deliverClipboard(sequence, value => terminal.push(value), async () => false);
  await deliverClipboard(sequence, value => terminal.push(value), async () => { throw new Error('unavailable'); });
  await deliverClipboard(sequence, value => terminal.push(value));
  expect(terminal).toEqual([sequence, sequence, sequence]);
  await deliverClipboard('malformed', value => terminal.push(value));
  await deliverClipboard(`\x1b]52;c;${Buffer.alloc(65537).toString('base64')}\x07`, value => terminal.push(value));
  expect(terminal).toHaveLength(3);
});

test('native clipboard bridge uses stdin, handles failure and bounds a stuck write', async () => {
  const { writeMacClipboard } = await import('../../apps/tui/src/clipboard');
  let input = '', ended = false, killed = false;
  const process = (code: number) => ({stdin: {write: (value: string) => { input = value; }, end: () => { ended = true; }}, exited: Promise.resolve(code), kill: () => { killed = true; }});
  expect(await writeMacClipboard('giữ\nindent', () => process(0))).toBe(true);
  expect(input).toBe('giữ\nindent'); expect(ended).toBe(true);
  expect(await writeMacClipboard('text', () => process(1))).toBe(false);
  expect(await writeMacClipboard('text', () => { throw new Error('unavailable'); })).toBe(false);
  expect(await writeMacClipboard('text', () => ({...process(0), stdin: {write: () => new Promise(() => {}), end: () => {} }}), 10)).toBe(false);
  expect(killed).toBe(true);
  expect(await writeMacClipboard('x'.repeat(65537), () => { throw new Error('must not launch'); })).toBe(false);
});

test('selection scrolls a frozen transcript across screens, excludes chrome, and autoscrolls at its edges', () => {
  const base = frame();
  const lines = Array.from({length: 100}, (_, row) => ({spans:[{text:`line ${row} ${row === 40 ? '\x1bsecret' : ''}`,fg:tokens.foreground}]}));
  base.transcriptViewport = {top:1,left:2,width:16,height:4,offset:0,lines,disclosures:[]};
  const selection = new TextSelection();
  selection.begin(base,{row:1,col:2});
  selection.move({row:4,col:8});
  expect(selection.scroll(40)).toBe(true);
  expect(selection.view(tokens).plainLines[1]).toContain('line 40');
  selection.release({row:4,col:8});
  const copied = selection.text();
  expect(copied).toContain('line 0\nline 1');
  expect(copied).toContain('line 40  secret');
  expect(copied).toContain('line 43');
  expect(copied).not.toContain('Hello world');
  expect(copied).not.toContain('status footer');
  expect(copied).not.toContain('\x1b');
  expect(base.transcriptViewport.offset).toBe(0);
  expect(selection.copySequence()).not.toBeNull();
  expect(selection.view(tokens).cells[1]![2]!.selected).toBe(true);
  selection.clear();
  selection.begin(base,{row:1,col:2});
  selection.move({row:5,col:8});
  const before = selection.text();
  selection.step(0.08);
  expect(selection.text().length).toBeGreaterThan(before.length);
  selection.scroll(1000); selection.release({row:4,col:8});
  expect(selection.text()).toContain('line 99');
  expect(selection.text()).not.toContain('undefined');
});
