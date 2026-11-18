import {expect, test} from 'bun:test';
import {createPasteState, expandPastes, insertPaste} from '../paste';
import {edit, insertText, moveCursor, verticalMove, visualRows} from './logic';

test('grapheme edits never split combining accents or emoji families and selections replace cleanly', () => {
  let state = createPasteState('A👩‍👩‍👧‍👦éB');
  state = moveCursor(state, -1);
  state = edit(state, 'backspace');
  expect(state.value).toBe('A👩‍👩‍👧‍👦B');
  state = moveCursor(state, -1, true);
  state = insertText(state, 'x');
  expect(state.value).toBe('AxB');
  expect(state.selectionAnchor).toBeUndefined();
});
test('line and word shortcuts preserve suffixes and newline boundaries', () => {
  let state = {...createPasteState('first\nhello world\nlast'), cursor: 11};
  expect(edit(state, 'start').cursor).toBe(6);
  expect(edit(state, 'end').cursor).toBe(17);
  expect(edit(state, 'killEnd').value).toBe('first\nhello\nlast');
  expect(edit(state, 'killStart').value).toBe('first\n world\nlast');
  expect(edit(state, 'killWord').value).toBe('first\n world\nlast');
  state = {...state, cursor: 17};
  expect(edit(state, 'killEnd').value).toBe('first\nhello worldlast');
});
test('cursor skips folded paste and deletion removes its content instead of leaking marker fragments', () => {
  const state = insertPaste(createPasteState(), 'a\nb\nc\nd\ne');
  expect(moveCursor(state, -1).cursor).toBe(0);
  expect(expandPastes(edit(state, 'backspace'))).toBe('');
});
test('wrapping measures CJK cells and resizes while vertical navigation follows visible columns', () => {
  expect(visualRows('你好ab', 4).map(row => row.text)).toEqual(['你好', 'ab']);
  expect(visualRows('你好ab', 8).map(row => row.text)).toEqual(['你好ab']);
  const state = {...createPasteState('你好ab\nxyz'), cursor: 2};
  expect(verticalMove(state, 1, 8)?.cursor).toBe(8);
  expect(verticalMove({...state, cursor: 0}, -1, 8)).toBeNull();
});
