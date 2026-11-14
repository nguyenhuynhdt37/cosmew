import { expect, test } from 'bun:test';
import { parseRawTerminalKey, TerminalInputDecoder, deriveTokensFromTriplet, type FrameSnapshot } from '@hannes/tui';
import { TextSelection } from '../../apps/tui/src/components/text-selection';
const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
function frame(): FrameSnapshot {
  const plainLines = ['  Hello world       ', '  giữ thụt dòng     ', '  third line        ', '                    ', '                    ', '                    ', '                    ', 'status footer       '].map(line => line.padEnd(20).slice(0,20));
  return { cols:20, rows:8, cells:plainLines.map(line => [...line].map(ch => ({ch, fg:tokens.foreground, bg:tokens.background, bold:false}))), plainLines, plainText:plainLines.join('\n'), activeOverlay:'none', activeThemeId:'futryn-default', effectiveMode:'dark', activeWallpaperId:null, isPreviewing:false, isStreaming:false };
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
