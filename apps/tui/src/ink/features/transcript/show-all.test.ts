import {expect, test} from 'bun:test';
import {DETAILED_RECENT_LIMIT, visibleWindow} from './show-all';

test('short and exact-limit histories hide nothing and retain the input', () => {
  for (const length of [0, 4, 30]) {
    const items = Array.from({length}, (_, n) => n);
    expect(visibleWindow(items, false)).toEqual({items, hidden: 0});
    expect(visibleWindow(items, false).items).toBe(items);
  }
  expect(DETAILED_RECENT_LIMIT).toBe(30);
});

test('the recent window hides the oldest items without mutating history', () => {
  const items = Object.freeze(Array.from({length: 35}, (_, n) => n));
  const result = visibleWindow(items, false);
  expect(result.hidden).toBe(5);
  expect(result.items).toHaveLength(30);
  expect(result.items[0]).toBe(5);
  expect(result.items.at(-1)).toBe(34);
  expect(items).toHaveLength(35);
  expect(visibleWindow(items, true)).toEqual({items, hidden: 0});
  expect(visibleWindow(items, false, 2)).toEqual({items: [33, 34], hidden: 33});
});

test('5,000 items compute a recent window in under 200 ms', () => {
  const items = Array.from({length: 5000}, (_, n) => n);
  const start = performance.now();
  const result = visibleWindow(items, false);
  expect(performance.now() - start).toBeLessThan(200);
  expect(result.hidden).toBe(4970);
  expect(result.items).toHaveLength(30);
  expect(result.items[0]).toBe(4970);
});
