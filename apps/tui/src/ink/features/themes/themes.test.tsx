/** @jsxImportSource react */
import {expect, spyOn, test} from 'bun:test';
import * as terminalSize from '../../hooks/use-terminal-size';
import type {Message} from '@cosmew/contracts';
import {ThemeEngine} from '../../../theme/theme';
import {dialogFixture, selection} from '../picker/test-fixture';
import {openInk} from '../../testing/ink-session';
import {renderInk} from '../../testing';
import {settle} from '../../testing/wait';
import {ThemesDialog} from '.';

const DOWN = '\x1b[B';
const ESC = '\x1b';

function history(count: number): Message[] {
  return Array.from({length: count / 2}, (_, turn): Message[] => [
    {role: 'user', content: `prompt ${turn}`},
    {
      role: 'assistant',
      content: `## Answer ${turn}\n\n` + Array.from({length: 20}, (_, row) => `- **row ${row}** \`code\``).join('\n'),
    },
  ]).flat();
}

async function frameAfter(view: ReturnType<typeof renderInk>, keys: string) {
  view.stdin.write(keys);
  await settle(0);
  return view.lastFrame() ?? '';
}

test('moving through themes over a long transcript never re-themes the app behind the dialog', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const {client} = dialogFixture({startSession: () => ({id: 'themes', selection, messages: history(200)})});
  client.trustWorkspace();
  client.createSession();
  const ui = await openInk(client, {width: 110, rows: 40, themeEngine: engine});
  try {
    await ui.press('/theme');
    await ui.press('\r');
    await ui.waitFor('Preview ·');
    let notified = 0;
    const stop = engine.subscribe(() => notified++);
    const committed = engine.getCommittedAppearance().theme;
    // TranscriptItem reads the terminal size on every render: counting the calls made from it is a direct
    // count of transcript item renders (other components calling the hook are ignored).
    let itemRenderCount = 0;
    const readSize = terminalSize.useTerminalSize;
    const itemRenders = spyOn(terminalSize, 'useTerminalSize').mockImplementation((() => {
      if (new Error().stack?.includes('TranscriptItem')) itemRenderCount++;
      return readSize();
    }) as typeof readSize);
    const rendersBefore = itemRenderCount;
    const timings: number[] = [];
    for (let n = 0; n < 10; n++) {
      const before = ui.frame();
      timings.push(await ui.pressToFrame(DOWN, frame => frame !== before));
      expect(engine.isPreviewing()).toBe(false);
    }
    stop();
    console.info('theme picker ↓ ms (200 items)', JSON.stringify(timings.map(t => Math.round(t))));
    expect(notified).toBe(0);
    expect(itemRenderCount - rendersBefore).toBe(0);
    expect(engine.getCommittedAppearance().theme).toBe(committed);
    expect(Math.max(...timings)).toBeLessThan(250);
    // Control: a real theme change does re-render the transcript, so the probe above is live.
    await engine.setTheme('github-light');
    await settle(0);
    expect(itemRenderCount - rendersBefore).toBeGreaterThan(0);
    itemRenders.mockRestore();
  } finally {
    await ui.close();
  }
});

test('the preview shows transcript, diff, status, markdown and code samples', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const view = renderInk(<ThemesDialog width={110} />, {themeEngine: engine});
  await settle(0);
  const frame = (view.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  for (const text of [
    '❯ fix the greeting',
    '⏺ Update(src/app.ts)',
    'Hello, World!',
    'Hello, Cosmew!',
    '✓ Done',
    '! Warning',
    '× Error',
    'i Info',
    '# Release notes',
    'echo "$HOME"',
  ])
    expect(frame).toContain(text);
});

test('Esc after browsing leaves the committed theme untouched and never previews globally', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  await engine.setTheme('github-dark');
  const view = renderInk(<ThemesDialog width={110} />, {themeEngine: engine});
  await settle(0);
  for (let n = 0; n < 5; n++) {
    await frameAfter(view, DOWN);
    expect(engine.isPreviewing()).toBe(false);
    expect(engine.getActiveThemeManifest().id).toBe('github-dark');
  }
  await frameAfter(view, ESC);
  expect(engine.getCommittedAppearance().theme).toBe('github-dark');
});

test('Enter commits the highlighted theme exactly once', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  await engine.setTheme('github-dark');
  const calls: string[] = [];
  const setTheme = engine.setTheme.bind(engine);
  engine.setTheme = (id, scope) => {
    calls.push(id);
    return setTheme(id, scope);
  };
  const view = renderInk(<ThemesDialog width={110} />, {themeEngine: engine});
  await settle(0);
  const frame = await frameAfter(view, DOWN);
  expect(frame).toContain('Preview · Dark high contrast');
  await frameAfter(view, '\r');
  await settle(10);
  expect(calls).toEqual(['github-dark-high-contrast']);
  expect(engine.getCommittedAppearance().theme).toBe('github-dark-high-contrast');
});

const TAB = '\t';
const plain = (frame: string) => frame.replace(/\x1b\[[0-9;]*m/g, '');

test('Tab switches to Sync with system without touching the engine', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  await engine.setTheme('github-dark');
  let notified = 0;
  engine.subscribe(() => notified++);
  const view = renderInk(<ThemesDialog width={110} />, {themeEngine: engine});
  await settle(0);
  expect(plain(view.lastFrame() ?? '')).toContain('◉ Single theme  ○ Sync with system');
  const frame = plain(await frameAfter(view, TAB));
  expect(frame).toContain('○ Single theme  ◉ Sync with system');
  expect(frame).toContain('❯ Day theme: Light default');
  expect(frame).toContain('Night theme: Dark default (active)');
  expect(notified).toBe(0);
  expect(engine.getCommittedAppearance()).toMatchObject({theme: 'github-dark', syncWithSystem: false});
});

test('each sync slot lists only themes of its own mode', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const view = renderInk(<ThemesDialog width={110} />, {themeEngine: engine});
  await settle(0);
  const day = plain(await frameAfter(view, TAB));
  expect(day).toContain('Light high contrast');
  expect(day).not.toContain('Dark dimmed');
  expect(day).not.toContain('Code colors');
  const night = plain(await frameAfter(view, TAB));
  expect(night).toContain('❯ Night theme: Dark default');
  expect(night).toContain('Dark high contrast');
  expect(night).not.toContain('Light tritanopia');
  expect(plain(await frameAfter(view, TAB))).toContain('◉ Single theme');
});

test('Enter in the night slot assigns the dark theme and turns sync on once', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const calls: unknown[] = [];
  const setSync = engine.setSync.bind(engine);
  engine.setSync = (input, scope) => {
    calls.push(input);
    return setSync(input, scope);
  };
  const view = renderInk(<ThemesDialog width={110} />, {themeEngine: engine});
  await settle(0);
  await frameAfter(view, TAB);
  await frameAfter(view, TAB);
  expect(plain(await frameAfter(view, DOWN))).toContain('Preview · Dark high contrast');
  await frameAfter(view, '\r');
  await settle(10);
  expect(calls).toEqual([{enabled: true, darkTheme: 'github-dark-high-contrast'}]);
  expect(engine.getCommittedAppearance()).toMatchObject({syncWithSystem: true, darkTheme: 'github-dark-high-contrast'});
  expect(engine.getActiveThemeManifest().id).toBe('github-dark-high-contrast');
});

test('a 40-column dialog in sync mode keeps the list, both slots and a compact preview within the width', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  await engine.setSync({enabled: true});
  const view = renderInk(<ThemesDialog width={40} />, {themeEngine: engine});
  await settle(0);
  const frame = plain(view.lastFrame() ?? '');
  expect(frame).toContain('Sync with system');
  expect(frame).toContain('Day theme');
  expect(frame).toContain('Night theme');
  expect(frame).toContain('Preview ·');
  expect(frame).toContain('✓ Done');
  for (const line of frame.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
});

test('onboarding hides the Single / Sync switch', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const view = renderInk(<ThemesDialog width={110} onOnboardingSelect={() => {}} />, {themeEngine: engine});
  await settle(0);
  expect(plain(view.lastFrame() ?? '')).not.toContain('Sync with system');
});

test('a 40×15 terminal in sync mode keeps the switch, both slots and the list on screen', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  await engine.setSync({enabled: true});
  const {client} = dialogFixture({startSession: () => ({id: 'small', selection, messages: []})});
  client.trustWorkspace();
  client.createSession();
  const ui = await openInk(client, {width: 40, rows: 15, themeEngine: engine});
  try {
    await ui.press('/theme');
    await ui.press('\r');
    await ui.waitFor('Night theme');
    const frame = ui.frame();
    expect(frame).toContain('Theme');
    expect(frame).toContain('Sync with system');
    expect(frame).toContain('Day theme');
    expect(frame).toContain('❯ Night theme: Dark default');
    expect(frame).toMatch(/❯ ✔ Dark default/);
    expect(frame).toContain('Preview · Dark default');
    for (const line of frame.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
  } finally {
    await ui.close();
  }
});

test('the footer names the tab key once and the three choices it cycles', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const view = renderInk(<ThemesDialog width={110} />, {themeEngine: engine});
  await settle(0);
  const frame = plain(view.lastFrame() ?? '');
  expect(frame).toContain('Tab Single / Day / Night · ↑/↓ preview · Enter select · Esc cancel');
  expect(frame).not.toContain('tab/→');
});

for (const [name, width, sync] of [
  ['wide single', 110, false],
  ['stacked single', 60, false],
  ['narrow sync', 40, true],
] as const)
  test(`theme picker frame: ${name}`, async () => {
    const engine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
    if (sync) await engine.setSync({enabled: true});
    const view = renderInk(<ThemesDialog width={width} />, {themeEngine: engine});
    await settle(0);
    expect(view.lastFrame()).toMatchSnapshot();
  });
