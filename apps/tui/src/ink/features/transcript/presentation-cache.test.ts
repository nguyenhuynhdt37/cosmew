import {expect, test} from 'bun:test';
import {createPresentationCache} from './presentation-cache';
import type {TranscriptItem} from './logic';

test('oversized tool-only snapshots bypass the presentation cache without flushing small items', () => {
  const cache = createPresentationCache<number>();
  let computed = 0;
  const read = (item: TranscriptItem) => cache(item, () => ++computed);
  const small: TranscriptItem = {id: 'small', role: 'assistant', content: 'keep this'};
  const huge: TranscriptItem = {
    id: 'tool-only',
    role: 'assistant',
    content: '',
    toolCalls: [{id: 'patch', name: 'apply_patch', input: {patch: 'x'.repeat(3 * 1024 * 1024)}}],
  };
  expect(read(small)).toBe(1);
  expect(read(huge)).toBe(2);
  expect(read(huge)).toBe(3);
  expect(read(small)).toBe(1);
});

test('independent part and hook text count toward the retained presentation payload', () => {
  const cache = createPresentationCache<number>();
  let computed = 0;
  for (const parts of [
    [{kind: 'text' as const, text: 'x'.repeat(3 * 1024 * 1024)}],
    [
      {
        kind: 'hook' as const,
        event: {
          type: 'hook.ran' as const,
          event: 'PostToolUse' as const,
          name: 'check',
          summary: 'x'.repeat(3 * 1024 * 1024),
        },
      },
    ],
  ]) {
    const item: TranscriptItem = {id: 'parts', role: 'assistant', content: '', parts};
    const first = cache(item, () => ++computed);
    expect(cache(item, () => ++computed)).toBe(first + 1);
  }
});

test('deep or cyclic tool arguments bypass presentation reuse without recursive overflow', () => {
  const cache = createPresentationCache<number>();
  let computed = 0;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let deep: Record<string, unknown> = {leaf: 'x'};
  for (let n = 0; n < 1000; n++) deep = {child: deep};
  for (const input of [deep, cyclic]) {
    const item: TranscriptItem = {
      id: 'bounded-input',
      role: 'assistant',
      content: '',
      toolCalls: [{id: 'call', name: 'fixture', input}],
    };
    const first = cache(item, () => ++computed);
    expect(cache(item, () => ++computed)).toBe(first + 1);
  }
});
