import {expect, test} from 'bun:test';
import type {ThemeTokens} from '@cosmew/contracts';
import {contrastRatio} from '../../theme/presets';

interface Frames {
  tokens: ThemeTokens;
  canvas: string;
  settings: string;
  theme: string;
  slashDraft: string;
  bashDraft: string;
  user: string;
  assistant: string;
  prose: string;
  code: string;
  thinking: string;
}

function frames(mode: 'dark' | 'light', option = ''): Frames {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/semantic-colors-fixture.tsx`, mode, option],
    env: {...process.env, FORCE_COLOR: '3', NO_COLOR: ''},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as Frames;
}

const paint = (hex: string, text: string) =>
  `\x1b[38;2;${[1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).join(';')}m${text}`;
const ansiColor = /\x1b\[(?:[349][0-9]|10[0-7]|[34]8;[25](?:;\d+)+)m/;
const ansiBackground = /\x1b\[48;2;(?:\d+;){2}\d+m/;

for (const mode of ['dark', 'light'] as const) {
  test(`${mode} differentiates config values, commands, shell output and thinking`, () => {
    const frame = frames(mode);
    const {tokens} = frame;
    expect(frame.settings).toContain(paint(tokens.syntaxFunction, '/fixture'));
    expect(frame.slashDraft).toContain(`❯ ${paint(tokens.syntaxFunction, '/mo')}`);
    const bashTint = mode === 'dark' ? '#cb9faf' : '#80586b';
    expect(frame.bashDraft).toContain(paint(bashTint, '! ') + paint(tokens.foreground, 'echo hi'));
    expect(frame.user).toContain(paint(tokens.syntaxFunction, '/config'));
    expect(frame.assistant).toContain(paint(tokens.syntaxKeyword, '✻ Thinking'));
    expect(frame.assistant).toContain(paint(tokens.foregroundMuted, 'Reasoning detail'));
    expect(frame.assistant).toContain(paint(tokens.syntaxFunction, 'echo'));
    expect(frame.assistant).toContain(paint(tokens.foregroundMuted, 'Command output'));
    expect(frame.assistant).not.toMatch(ansiBackground);
    expect(frame.bashDraft).not.toMatch(ansiBackground);
    expect(frame.canvas).not.toContain(paint(tokens.background, '').replace('[38;', '[48;'));
    expect(frame.thinking).toContain(paint(tokens.syntaxKeyword, '✻ Thinking'));
    expect(frame.thinking).toContain(paint(tokens.syntaxKeyword, 'thinking with medium effort'));
    expect(frame.prose).toContain(paint(tokens.markdownHeading, 'Heading'));
    expect(frame.prose).toContain(paint(tokens.markdownCode, 'inlineCode'));
    expect(frame.prose).toContain(paint(tokens.info, 'Link'));
    expect(frame.code).toContain(paint(tokens.syntaxFunction, 'echo'));
    expect(frame.code).toContain(paint(tokens.syntaxKeyword, '$HOME'));
    expect(frame.code).toContain(paint(tokens.syntaxComment, '# note'));
    expect(frame.code).toContain(paint(tokens.syntaxComment, 'second */'));
    expect(frame.code).toContain(paint(tokens.syntaxFunction, 'key'));
    expect(frame.code).toContain(paint(tokens.syntaxKeyword, 'true'));
    expect(frame.code).toContain(paint(tokens.info, '42'));
    expect(frame.theme).toContain(paint(tokens.syntaxFunction, '/config'));
    expect(frame.theme).toContain(paint(tokens.syntaxKeyword, '✻ Thinking'));
    expect(frame.theme).toContain(paint(tokens.warning, '! Warning'));
    expect(frame.theme).toContain(paint(tokens.syntaxFunction, 'echo'));
  });

  test(`${mode} ANSI theme renders distinct readable semantic roles`, () => {
    const frame = frames(mode, 'ansi');
    const {tokens} = frame;
    const active = [tokens.markdownHeading, tokens.markdownCode, tokens.syntaxKeyword, tokens.syntaxFunction];
    expect(new Set(active).size).toBe(active.length);
    for (const color of active) expect(contrastRatio(color, tokens.background)).toBeGreaterThanOrEqual(4.5);
    expect(frame.user).toContain(paint(tokens.syntaxFunction, '/config'));
    expect(frame.thinking).toContain(paint(tokens.syntaxKeyword, '✻ Thinking'));
    expect(frame.prose).toContain(paint(tokens.markdownHeading, 'Heading'));
  });

  test(`${mode} palette paints a single canvas behind content and blank rows`, () => {
    const frame = frames(mode, 'custom-palette');
    const background = paint(frame.tokens.background, '').replace('[38;', '[48;');
    expect(frame.theme).toContain(mode === 'light' ? 'Preview · Parchment' : 'Preview · Midnight');
    expect(frame.theme).toContain(background);
    expect(frame.canvas).toContain(background + ' '.repeat(100));
    expect(frame.slashDraft).not.toMatch(ansiBackground);
    expect(frame.assistant).not.toMatch(ansiBackground);
  });
}

test('NO_COLOR removes foreground and background color while retaining text and markers', () => {
  const {tokens, ...frame} = frames('dark', 'no-color');
  expect(frame.assistant).toContain('✻ Thinking');
  expect(frame.settings).toContain('Workspace');
  expect(frame.user).toContain('/config');
  expect(frame.code).toContain('# note');
  for (const value of Object.values(frame)) expect(value).not.toMatch(ansiColor);
});

test('syntax highlight preference disables token coloring in fenced code only', () => {
  const frame = frames('dark', 'plain-code');
  expect(frame.code).toContain(paint(frame.tokens.foreground, 'echo "$HOME" # note'));
  const paintCodes = frame.code.match(/\x1b\[38;2;(?:\d+;){2}\d+m/g);
  expect([...new Set(paintCodes)]).toEqual([paint(frame.tokens.foreground, '')]);
  expect(frame.settings).toContain(paint(frame.tokens.syntaxFunction, '/fixture'));
  expect(frame.prose).toContain(paint(frame.tokens.markdownCode, 'inlineCode'));
});
