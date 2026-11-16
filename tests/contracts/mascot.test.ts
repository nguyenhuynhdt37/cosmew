import {expect, test} from 'bun:test';
import {FynCompanion, renderFyn, type FynState, deriveTokensFromTriplet} from '@futryn/tui';

test('Fyn never sleeps during a request, holds errors and approvals, settles terminal outcomes', () => {
  const pet = new FynCompanion();
  const view = (pending = false) => pet.view(pending, true, false).state;
  for (const state of ['thinking', 'streaming', 'error'] as const) {
    pet.transition(state);
    pet.tick(120, true);
    expect(view()).toBe(state);
  }
  expect(view(true)).toBe('waiting');
  expect(view(true)).toBe('waiting');
  expect(view()).toBe('error');
  for (const state of ['done', 'cancelled'] as const) {
    pet.transition(state);
    pet.tick(1, false);
    expect(view()).toBe(state);
    pet.tick(0.81, false);
    expect(view()).toBe('idle');
  }
  pet.tick(60, true);
  expect(view()).toBe('sleep');
  pet.activity();
  expect(view()).toBe('idle');
});

test('Fyn freezes motion without freezing state updates; invalid deltas cannot poison the clock', () => {
  const pet = new FynCompanion();
  pet.transition('streaming');
  pet.tick(0.4, true, 2);
  const before = pet.view(false, true, false);
  pet.tick(10, false);
  for (const delta of [NaN, Infinity, -1]) pet.tick(delta, true);
  expect(pet.view(false, true, false)).toEqual(before);
  expect(pet.view(false, true, true).time).toBe(0);
  expect(pet.view(true, false, false).state).toBe('idle');
  expect(before.time).toBe(0.8);
});

test('Fyn uses only theme colors and bounded single-cell glyphs, with compact terminal fallback', () => {
  const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
  const palette = new Set(Object.values(tokens));
  for (const state of [
    'idle',
    'thinking',
    'streaming',
    'waiting',
    'done',
    'error',
    'cancelled',
    'sleep',
  ] as FynState[]) {
    for (const time of [0, 0.3, 0.9, 4.5]) {
      for (const width of [19, 20, 27, 28, 60]) {
        const lines = renderFyn({state, time, tokens, width});
        if (width < 20) {
          expect(lines).toEqual([]);
          continue;
        }
        expect(lines.length).toBe(width < 28 ? 3 : 13);
        for (const line of lines) {
          expect(line.spans.reduce((n, span) => n + span.text.length, 0)).toBeLessThanOrEqual(width);
          for (const span of line.spans) {
            expect(palette.has(span.fg)).toBe(true);
            expect(palette.has(span.bg!)).toBe(true);
            expect(span.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
          }
        }
      }
    }
  }
});
