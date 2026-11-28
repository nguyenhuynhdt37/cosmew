import {expect, test} from 'bun:test';
import {THEME_TOKEN_KEYS} from '@cosmew/contracts';
import {GITHUB_PALETTES, GITHUB_THEME_IDS, PRIMER_SOURCE} from './github-palettes';
import {contrastRatio} from './presets';

const STATUS = ['error', 'warning', 'success', 'info', 'diffAdded', 'diffRemoved'] as const;

test('every GitHub palette defines every token as a 6-digit hex colour', () => {
  expect([...GITHUB_THEME_IDS]).toEqual([
    'github-light',
    'github-light-high-contrast',
    'github-light-colorblind',
    'github-light-tritanopia',
    'github-dark',
    'github-dark-high-contrast',
    'github-dark-colorblind',
    'github-dark-tritanopia',
    'github-dark-dimmed',
  ]);
  for (const id of GITHUB_THEME_IDS) {
    const tokens = GITHUB_PALETTES[id].tokens as Record<string, string>;
    for (const key of THEME_TOKEN_KEYS) expect(tokens[key]).toMatch(/^#[0-9a-f]{6}$/);
  }
});

test('GitHub palettes keep readable text and status colours', () => {
  for (const id of GITHUB_THEME_IDS) {
    const {tokens} = GITHUB_PALETTES[id];
    const floor = id.includes('high-contrast') ? 7 : 4.5;
    expect(contrastRatio(tokens.foreground, tokens.background)).toBeGreaterThanOrEqual(floor);
    for (const key of STATUS) expect(contrastRatio(tokens[key], tokens.background)).toBeGreaterThanOrEqual(3);
  }
});

test('GitHub palettes match Primer anchors and record their source', () => {
  expect(GITHUB_PALETTES['github-dark'].tokens.background).toBe('#0d1117');
  expect(GITHUB_PALETTES['github-light'].tokens.background).toBe('#ffffff');
  expect(GITHUB_PALETTES['github-dark'].mode).toBe('dark');
  expect(GITHUB_PALETTES['github-light-tritanopia'].mode).toBe('light');
  expect(GITHUB_PALETTES['github-dark-dimmed'].name).toBe('Dark dimmed');
  expect(PRIMER_SOURCE).toEqual({package: '@primer/primitives', version: '11.10.0', accessed: '2026-11-28'});
});

test('GitHub themes paint their own canvas except on 16-colour and colourless terminals', async () => {
  const {paintsCanvas} = await import('./theme');
  expect(paintsCanvas('github-dark', 'truecolor')).toBe(true);
  expect(paintsCanvas('github-light', '256')).toBe(true);
  expect(paintsCanvas('github-dark', '16')).toBe(false);
  expect(paintsCanvas('github-dark', 'none')).toBe(false);
  expect(paintsCanvas('auto', 'truecolor')).toBe(false);
});
