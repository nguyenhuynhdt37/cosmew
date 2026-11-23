import {expect, test} from 'bun:test';
import {renderCache} from './render-cache';

test('recent rendering evicts by retained content size as well as entry count', () => {
  const cache = renderCache<string, string>(48, {maxWeight: 8, weight: (key, value) => key.length + value.length});
  let computed = 0;
  const read = (key: string) =>
    cache(key, () => {
      computed++;
      return key;
    });
  read('aa');
  read('bb');
  read('aa'); // aa is now most recent.
  read('cc'); // Three four-unit entries cannot all be retained.
  expect(computed).toBe(3);
  read('aa');
  expect(computed).toBe(3);
  read('bb');
  expect(computed).toBe(4);
  read('oversized');
  read('oversized');
  expect(computed).toBe(6);
  // Oversized streamed snapshots do not evict the useful small entries.
  read('aa');
  read('bb');
  expect(computed).toBe(6);
});
