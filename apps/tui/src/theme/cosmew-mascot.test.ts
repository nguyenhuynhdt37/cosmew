import {expect, test} from 'bun:test';
import {COSMEW_MASCOT_FRAMES, cosmewMascotWidth, renderCosmewMascot} from './cosmew-mascot';

test('cat uses block pixels in a fixed-size silhouette', () => {
  expect(COSMEW_MASCOT_FRAMES.length).toBe(3);
  for (const rows of COSMEW_MASCOT_FRAMES) {
    expect(rows.length).toBe(4);
    expect(rows.join('')).toMatch(/^[ ▀▄█]+$/);
    expect(rows.every(row => Bun.stringWidth(row) === 9)).toBe(true);
  }
});

test('mascot rendering is deterministic, freezes under reduced motion, and falls back on narrow terminals', () => {
  expect(renderCosmewMascot({frame: 1})).toEqual(renderCosmewMascot({frame: 1}));
  expect(renderCosmewMascot({frame: 2, reducedMotion: true})).toEqual(renderCosmewMascot({frame: 0}));
  expect(renderCosmewMascot({frame: 2, width: 7})).toEqual(['▀█▀']);
  expect(renderCosmewMascot({frame: 2, width: 9}).every(row => !/[\u001b\u0000-\u001f]/.test(row))).toBe(true);
});

test('terminal width selects the compact mark without cropping the four-row cat', () => {
  expect(renderCosmewMascot({width: cosmewMascotWidth(24)})).toEqual(['▀█▀']);
  expect(renderCosmewMascot({width: cosmewMascotWidth(80)})).toEqual([...COSMEW_MASCOT_FRAMES[0]]);
});
