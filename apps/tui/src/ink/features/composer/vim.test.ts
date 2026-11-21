import {expect, test} from 'bun:test';
import {graphemes} from '../../../input/text';
import {createPasteState, expandPastes, insertPaste} from '../paste';
import * as vim from './vim';

function run(value: string, cursor: number, ...keys: string[]) {
  let state = {...vim.createVimState(), mode: 'NORMAL' as vim.VimState['mode']};
  let draft = {...createPasteState(value), cursor};
  for (const key of keys) ({state, draft} = vim.stepVim(state, draft, key));
  return {state, draft};
}

test.each([
  ['one two three four', 0, ['3', 'w'], 'one two three four', 14],
  ['one two three four', 14, ['2', 'b'], 'one two three four', 4],
  ['one two', 0, ['e'], 'one two', 2],
  ['a\n', 2, ['d', 'd'], 'a', 0],
  ['aa bb cc dd ee ff', 0, ['2', 'd', '2', 'w'], 'ee ff', 0],
  ['head\nold\ntail', 5, ['c', 'c', 'new', 'escape'], 'head\nnew\ntail', 7],
  ['a b c d', 0, ['x', 'w', 'y', 'w', 'w', '.'], ' b  d', 3],
  ['a\nb\nc\nd', 0, ['2', 'd', 'd'], 'c\nd', 0],
  ['a\nb\nc\nd', 0, ['d', '2', 'd'], 'c\nd', 0],
  ['  a\nb\nc', 1, ['^', 'j', 'G', 'g', 'g', '$'], '  a\nb\nc', 2],
  ['界👩🏽‍💻z\nx\n界👩🏽‍💻z', 9, ['j', 'j'], '界👩🏽‍💻z\nx\n界👩🏽‍💻z', 20],
  ['one two three', 4, ['d', 'a', 'w'], 'one three', 4],
  ['(x(y)z)', 3, ['d', 'a', '('], '(xz)', 2],
  ['a "👩🏽‍💻" b', 3, ['c', 'i', '"', 'é', 'escape'], 'a "é" b', 3],
  ['a\nb', 0, ['y', 'y', 'p'], 'a\na\nb', 2],
  ['a\nb', 2, ['y', 'y', 'P'], 'a\nb\nb', 2],
  ['abc', 1, ['X'], 'bc', 0],
  ['abc', 0, ['x', '.'], 'c', 0],
  ['abc', 0, ['2', 'r', '🌈'], '🌈🌈c', 2],
  ['ab\n  Cd', 0, ['J', 'l', '~'], 'ab cd', 4],
  ['abc', 0, ['v', 'l', 'd'], 'c', 0],
  ['a\nb\nc', 0, ['V', 'j', 'd'], 'c', 0],
  ['foo bar', 0, ['c', 'w', '💙', 'escape', 'w', '.'], '💙 💙', 3],
  ['a,a,a', 0, ['f', ',', ';'], 'a,a,a', 3],
  ['(a(b)c)', 0, ['%'], '(a(b)c)', 6],
  ['a\nb', 0, ['>', '>'], '  a\nb', 2],
] as const)('%j at %i with %j yields %j at %i', (value, cursor, keys, expected, at) => {
  const result = run(value, cursor, ...keys);
  expect([result.draft.value, result.draft.cursor]).toEqual([expected, at]);
});

test.each([
  ['i', 'aZbc'],
  ['a', 'abZc'],
  ['I', 'Zabc'],
  ['A', 'abcZ'],
  ['o', 'abc\nZ'],
  ['O', 'Z\nabc'],
] as const)('%s enters Insert and keeps the intended insertion point', (command, expected) => {
  const {state, draft} = run('abc', 1, command, 'Z', 'escape');
  expect(state.mode).toBe('NORMAL');
  expect(draft.value).toBe(expected);
});

test('Escape clears a pending operator and leaves Visual, while Enter describes submission', () => {
  const {draft, state} = run('abc', 0, '2', 'd', 'escape', 'v', 'l', 'escape');
  expect(state.mode).toBe('NORMAL');
  expect(draft.value).toBe('abc');
  expect(draft.selectionAnchor).toBeUndefined();
  expect(vim.stepVim(state, draft, 'enter').effect).toBe('submit');
  expect(vim.stepVim(state, draft, 'u').effect).toBe('undo');
  expect(vim.stepVim(state, draft, 'ctrl+r').effect).toBe('redo');
});

test('large paste markers move and yank atomically', () => {
  const input = '界👩🏽‍💻é\n'.repeat(1200);
  const draft = insertPaste(createPasteState(), input);
  const state = vim.createVimState();
  let result = vim.stepVim(state, draft, 'escape');
  expect(result.draft.cursor).toBe(0);
  for (const key of ['x', 'P']) result = vim.stepVim(result.state, result.draft, key);
  expect(expandPastes(result.draft)).toBe(input);
});

test('generated Unicode edits, selections and motions keep the cursor on grapheme boundaries', () => {
  let seed = 1957;
  const choose = <T>(items: readonly T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return items[(seed >>> 8) % items.length]!;
  };
  const tokens = ['é', '👩🏽‍💻', '界', '🇻🇳', ' ', '\n', 'x', '(', ')'];
  const commands = [
    'h',
    'j',
    'k',
    'l',
    'w',
    'e',
    'b',
    'G',
    'g',
    '0',
    '$',
    'd',
    'c',
    'y',
    'a',
    '0',
    '3',
    'r',
    'x',
    'X',
    'i',
    'p',
    '.',
    '~',
    'v',
    'escape',
    ...tokens,
  ];
  for (let sample = 0; sample < 60; sample++) {
    let draft = {...createPasteState(Array.from({length: 20}, () => choose(tokens)).join('')), cursor: 0};
    let state = {...vim.createVimState(), mode: 'NORMAL' as vim.VimState['mode']};
    for (let step = 0; step < 80; step++) {
      ({state, draft} = vim.stepVim(state, draft, choose(commands)));
      const offsets = new Set([...graphemes(draft.value).map(({index}) => index), draft.value.length]);
      expect(draft.value.isWellFormed()).toBe(true);
      expect(offsets.has(draft.cursor)).toBe(true);
      if (draft.selectionAnchor !== undefined) expect(offsets.has(draft.selectionAnchor)).toBe(true);
    }
  }
});
