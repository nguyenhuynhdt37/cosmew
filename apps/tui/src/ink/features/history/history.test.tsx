/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {History, recordHistory, searchHistory} from './index';
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
test('History component shows empty results and strips controls from query and preview', async () => {
  const view = renderInk(<History query="missing" width={80} />);
  await settle();
  expect(view.lastFrame()).toContain('No match');
  view.rerender(<History query="q" match={'\u001b]52;c;secret\u0007hello'} width={80} />);
  await settle();
  expect(view.lastFrame()).toContain('hello');
  expect(view.lastFrame()).not.toContain('secret');
});
