import {expect, test} from 'bun:test';
import {themeLayout} from './logic';

test('theme dialog layout follows terminal size', () => {
  expect(themeLayout(120, 40)).toBe('side');
  expect(themeLayout(70, 19)).toBe('side');
  expect(themeLayout(60, 30)).toBe('stacked');
  expect(themeLayout(120, undefined)).toBe('side');
  expect(themeLayout(40, 15)).toBe('compact');
  expect(themeLayout(45, 30)).toBe('compact');
  expect(themeLayout(100, 18)).toBe('compact');
});

test('theme tabs cycle single → day → night and open on the showing slot', async () => {
  const {stepTab, initialTab, slotMode} = await import('./logic');
  expect(stepTab('single', 1)).toBe('day');
  expect(stepTab('night', 1)).toBe('single');
  expect(stepTab('single', -1)).toBe('night');
  expect(initialTab(false, true)).toBe('single');
  expect(initialTab(true, true)).toBe('night');
  expect(initialTab(true, false)).toBe('day');
  expect(slotMode('day')).toBe('light');
  expect(slotMode('night')).toBe('dark');
});

test('key labels show the first chord, capitalised, and nothing when unbound', async () => {
  const {firstChordLabel} = await import('./logic');
  expect(firstChordLabel('tab/→')).toBe('Tab');
  expect(firstChordLabel('ctrl+t')).toBe('Ctrl+t');
  expect(firstChordLabel('unbound')).toBe('');
  expect(firstChordLabel('')).toBe('');
});
