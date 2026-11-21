import {expect, test} from 'bun:test';
import {buildSearchIndex, buildSearchIndexAsync, findMatches, searchStatus} from './search';

test('search offsets refer to visible ANSI/OSC/wide text, including tool output', () => {
  const index = buildSearchIndex([
    {id: 'a', role: 'user', content: '\x1b[31m界Red\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x07'},
  ]);
  expect(index[0]).toBe('界Red link');
  expect(findMatches(index, 'RED')).toEqual([{itemIndex: 0, start: 1, end: 4}]);
  expect(findMatches(index, 'link')).toEqual([{itemIndex: 0, start: 5, end: 9}]);
  expect(findMatches(index, '')).toEqual([]);
  const tool = buildSearchIndex([
    {
      id: 'b',
      role: 'assistant',
      content: '',
      toolCalls: [{id: 't', name: 'exec_command', input: {cmd: 'echo hi'}}],
      toolResults: [{callId: 't', name: 'exec_command', status: 'ok', content: '\x1b[32m界needle\x1b[0m'}],
    },
  ]);
  expect(findMatches(tool, 'needle')).toHaveLength(1);
});

test('search status uses B3 priority and exact strings', () => {
  const state = {building: false, query: 'x', count: 7, current: 2};
  expect(searchStatus({...state, building: true, ms: 21})).toBe('indexing…');
  expect(searchStatus({...state, ms: 21})).toBe('indexed in 21ms');
  expect(searchStatus({...state, count: 0})).toBe('no matches');
  expect(searchStatus(state)).toBe('2 of 7');
  expect(searchStatus({...state, count: 0, query: ''})).toBeNull();
});

test('5000 item indexing yields to input within a frame and can be cancelled', async () => {
  const items = Array.from({length: 5000}, (_, n) => ({
    id: String(n),
    role: 'user' as const,
    content: '界needle '.repeat(100),
  }));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const start = performance.now();
  const pending = buildSearchIndexAsync(items);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(performance.now() - start).toBeLessThan(16.7);
  const index = await pending;
  clearInterval(timer);
  expect(ticks).toBeGreaterThan(0);
  expect(index).toHaveLength(5000);
  const abort = new AbortController();
  const cancelled = buildSearchIndexAsync(items, abort.signal);
  abort.abort();
  expect(await cancelled).toBeNull();
});

test('query scanning 5000 items yields before searching and discards cancelled queries', async () => {
  const {findMatchesAsync} = await import('./search');
  const index = Array.from({length: 5000}, () => '界needle '.repeat(100));
  const abort = new AbortController();
  const start = performance.now();
  const pending = findMatchesAsync(index, 'needle', abort.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(performance.now() - start).toBeLessThan(16.7);
  abort.abort();
  expect(await pending).toBeNull();
});
