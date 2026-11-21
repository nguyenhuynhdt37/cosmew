/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {History, filterHistory, recordHistory, searchHistory} from './index';
afterEach(cleanup);
test('history is bounded and deduplicated, reverse search does not wrap to an unrelated match', () => {
  let entries: string[] = [];
  for (let i = 0; i < 120; i++) entries = recordHistory(entries, `prompt ${i}`);
  entries = recordHistory(entries, ' prompt 25 ');
  expect(entries).toHaveLength(100);
  expect(entries.at(-1)).toBe('prompt 25');
  expect(searchHistory(entries, 'PROMPT 25')).toBe(99);
  expect(searchHistory(entries, 'PROMPT 25', 99)).toBe(-1);
});
test('filterHistory lists matches newest first and matches case-insensitively', () => {
  expect(filterHistory(['alpha one', 'beta', 'Alpha two'], 'ALPHA')).toEqual([2, 0]);
  expect(filterHistory(['a'], 'zzz')).toEqual([]);
  expect(filterHistory(['a', 'b'], '')).toEqual([1, 0]);
});
test('History panel shows empty results and strips controls from query and preview', async () => {
  const view = renderInk(<History query="missing" matches={[]} width={80} />);
  await settle();
  expect(view.lastFrame()).toContain('No match');
  view.rerender(<History query="q" matches={['\u001b]52;c;secret\u0007hello']} width={80} />);
  await settle();
  expect(view.lastFrame()).toContain('hello');
  expect(view.lastFrame()).not.toContain('secret');
});
test('History panel layout: title, list with pointer, rounded preview, rounded filter box, key help', async () => {
  const view = renderInk(
    <History
      query=""
      matches={['newest prompt', 'older line one\nolder line two', 'oldest']}
      selected={1}
      width={80}
    />,
  );
  await settle();
  const lines = view.lastFrame()!.split('\n');
  expect(lines[0]).toBe('▔'.repeat(80));
  expect(lines[1]).toBe(' Search prompts · everywhere');
  expect(lines[2]).toContain('  newest prompt');
  expect(lines[3]).toContain('❯ older line one');
  expect(lines[2]).toContain('╭');
  expect(lines.join('\n')).toContain('older line two');
  expect(lines.join('\n')).toContain('⌕ Filter history…');
  expect(lines.at(-1)).toBe('  ↑/↓ to navigate · ctrl+s to change scope · Enter to use · Esc to cancel');
  expect(lines.every(line => Bun.stringWidth(line) <= 80)).toBe(true);
});
