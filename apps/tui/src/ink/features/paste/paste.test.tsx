/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {Paste, createPasteState, expandPastes, insertPaste, replaceRange} from './index';

afterEach(cleanup);
const long = 'one\ntwo\nthree\nfour\nfive';
test('folded paste expands exactly, while a literal marker stays literal', () => {
  const state = insertPaste(createPasteState('[Pasted text #1 +4 lines] '), long);
  expect(state.value).toBe('[Pasted text #1 +4 lines] [Pasted text #1 +4 lines]');
  expect(expandPastes(state)).toBe('[Pasted text #1 +4 lines] ' + long);
  const edited = replaceRange(state, 0, 0, 'prefix ');
  expect(expandPastes(edited)).toBe('prefix [Pasted text #1 +4 lines] ' + long);
});
test('edits delete a paste atomically and preserve later paste offsets', () => {
  let state = insertPaste(createPasteState(), long);
  state = replaceRange(state, state.cursor, state.cursor, ' middle ');
  state = insertPaste(state, long.toUpperCase());
  state = replaceRange(state, 1, 3, '');
  expect(expandPastes(state)).toBe(' middle ' + long.toUpperCase());
  expect(state.pastes).toHaveLength(1);
});
test('paste sanitizes terminal commands and normalizes CRLF without executing shortcuts', () => {
  const state = insertPaste(createPasteState(), '\u001b]52;c;evil\u0007hello\r\nworld\u0003');
  expect(expandPastes(state)).toBe('hello\nworld');
});
test('Paste component renders the compact label with no terminal controls', async () => {
  const view = renderInk(<Paste id={2} content={long} width={36} />);
  await settle();
  expect(view.lastFrame()).toContain('[Pasted text #2 +4 lines]');
  expect(view.lastFrame()).not.toContain('\u001b');
});
