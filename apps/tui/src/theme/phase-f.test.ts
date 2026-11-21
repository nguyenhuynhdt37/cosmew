import {expect, spyOn, test} from 'bun:test';
import {ThemeEngine} from './theme';
import {createClientFixture} from '../ink/testing/client-fixture';

test('default theme is auto and a saved light/dark choice still wins over the terminal background', async () => {
  const {client} = createClientFixture();
  const engine = new ThemeEngine({client, env: {COLORFGBG: '0;15'}});
  await engine.initialize();
  expect(engine.getActiveAppearance().theme).toBe('auto');
  expect(engine.getActiveAppearance().mode).toBe('system');
  expect(engine.getEffectiveMode()).toBe('light');
  for (const theme of ['dark', 'light'] as const) {
    await engine.setTheme(theme);
    const restarted = new ThemeEngine({client, env: {COLORFGBG: '0;15'}});
    await restarted.initialize();
    expect(restarted.getActiveAppearance().theme).toBe(theme);
    expect(restarted.getEffectiveMode()).toBe(theme);
  }
});

test('auto never queries AppleInterfaceStyle; OSC 11 beats COLORFGBG, then Cosmew theme env, then dark', async () => {
  const spawn = spyOn(Bun, 'spawnSync');
  try {
    for (const [env, mode] of [
      [{}, 'dark'],
      [{COLORFGBG: '15;0'}, 'dark'],
      [{COLORFGBG: '0;15'}, 'light'],
      [{FUTRYN_THEME_MODE: 'light'}, 'light'],
      [{COSMEW_THEME_MODE: 'light'}, 'light'],
      [{COSMEW_THEME_MODE: 'dark', FUTRYN_THEME_MODE: 'light'}, 'dark'],
      [{COLORFGBG: '15;0', FUTRYN_THEME_MODE: 'light'}, 'dark'],
    ] as const) {
      const engine = new ThemeEngine({env});
      await engine.setTheme('auto');
      expect(engine.getEffectiveMode()).toBe(mode);
    }
    const engine = new ThemeEngine({env: {COLORFGBG: '15;0'}});
    await engine.setTheme('auto');
    engine.applyTerminalBackground([250, 250, 250]);
    expect(engine.getEffectiveMode()).toBe('light');
    engine.applyTerminalBackground([10, 10, 10]);
    expect(engine.getEffectiveMode()).toBe('dark');
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test('light and dark presets carry exactly the measured reference colours (spec 9)', () => {
  const tokens = (mode: 'dark' | 'light') =>
    new ThemeEngine({env: {}, systemDarkPreference: mode === 'dark'}).getActiveTokens();
  const dark = tokens('dark'),
    light = tokens('light');
  expect([light.accent, dark.accent]).toEqual(['#d77757', '#d77757']);
  expect([light.foregroundMuted, dark.foregroundMuted]).toEqual(['#6e7171', '#a9abae']);
  expect([light.border, dark.border]).toEqual(['#3465a4', '#81a2be']);
  expect([light.info, dark.info]).toEqual(['#5769f7', '#b1b9f9']);
  expect([light.composerBackground, dark.composerBackground]).toEqual(['#f2f3f3', '#353940']);
  expect([light.backgroundPanel, dark.backgroundPanel]).toEqual(['#f5f5f5', '#262626']);
  expect(light.foreground).toBe('#2e3434');
  expect(dark.foreground).toBe('#ffffff');
  expect(light.warning).toBe('#8e7700');
});

test('changing another appearance option keeps the auto default', async () => {
  const {client} = createClientFixture();
  const engine = new ThemeEngine({client, env: {}});
  await engine.initialize();
  await engine.updateAppearance({syntaxHighlighting: false});
  expect(engine.getActiveAppearance().theme).toBe('auto');
});
