import {expect, test} from 'bun:test';
import {wrapRuns, wrapText} from './text-line';

test('wrapping measures a word across style changes and retains styles when the word splits', () => {
  expect(
    wrapRuns(
      [
        {text: 'ab', style: 'bold'},
        {text: 'cd ef', style: 'italic'},
      ],
      3,
    ),
  ).toEqual([
    [
      {text: 'ab', style: 'bold'},
      {text: 'c', style: 'italic'},
    ],
    [{text: 'd', style: 'italic'}],
    [{text: 'ef', style: 'italic'}],
  ]);
  expect(wrapText('  ab   cd', 4)).toEqual(['  ab', 'cd']);
  expect(wrapText('\n\n', 4)).toEqual(['', '']);
});

test('oversized Unicode words preserve graphemes, zero-width text and newline behavior', () => {
  expect(wrapText('👨‍👩‍👧‍👦é 漢', 3)).toEqual(['👨‍👩‍👧‍👦é', '漢']);
  expect(wrapText('ăbc', 2)).toEqual(['ăb', 'c']);
  expect(wrapText('漢漢', 1)).toEqual(['漢', '漢']);
  expect(wrapText('ab\u200bc', 2)).toEqual(['ab\u200b', 'c']);
  expect(wrapText('a\r\nb', 2)).toEqual(['a\r\nb']);
});
