import {describe, expect, test} from 'bun:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  THEME_TOKEN_KEYS,
  defaultAppearance,
  emptySettings,
  themeManifestSchema,
  type Settings,
  type SettingsStore,
  type ThemeManifest,
} from '@cosmew/contracts';
import {FileCustomThemeStore} from '@cosmew/persistence';
import {FutrynClient} from '@cosmew/sdk';
import {
  ALL_BUILTIN_THEMES,
  BUILTIN_COLOR_THEMES,
  BUILTIN_LIVE_THEMES,
  ThemeEngine,
  bgHex,
  contrastRatio,
  detectTerminalColorCapability,
  fgHex,
  getThemeMiniSwatches,
} from '@cosmew/tui';

class MemorySettingsStore implements SettingsStore {
  private state: Settings = emptySettings();
  constructor(initial?: Settings) {
    if (initial) this.state = initial;
  }
  read(): Settings {
    return JSON.parse(JSON.stringify(this.state)) as Settings;
  }
  update(change: (settings: Settings) => void): void {
    const next = this.read();
    change(next);
    this.state = next;
  }
}

function createTestClient(
  settingsStore: SettingsStore,
  customThemeStore: FileCustomThemeStore,
  workspace = '/workspace/proj-a',
): FutrynClient {
  return new FutrynClient({
    workspace,
    settings: settingsStore,
    listProviders: () => [],
    listProviderPresets: () => [],
    addProvider: p => p,
    removeProvider: () => {},
    listAccounts: () => [],
    getAccount: () => {
      throw new Error('unused');
    },
    addAccount: async () => {
      throw new Error('unused');
    },
    reauthenticateAccount: async () => {
      throw new Error('unused');
    },
    useAccount: () => {
      throw new Error('unused');
    },
    renameAccount: () => {
      throw new Error('unused');
    },
    logoutAccount: async () => {},
    validateAccount: async () => ({models: 0, validation: 'ok'}),
    discoverModels: async () => ({models: [], stale: false}),
    cachedModels: () => [],
    addManualModel: () => {
      throw new Error('unused');
    },
    selectModel: () => {
      throw new Error('unused');
    },
    resolveSelection: () => null,
    listSessions: () => [],
    getSession: () => undefined,
    deleteSession: () => false,
    startSession: () => {
      throw new Error('unused');
    },
    resumeSession: () => {
      throw new Error('unused');
    },
    sendTurn: async function* () {},
    loadCustomThemes: () => customThemeStore.loadAll(),
    saveCustomTheme: (manifest: ThemeManifest) => customThemeStore.save(manifest),
    removeCustomTheme: (id: string) => customThemeStore.remove(id),
    listWorkspaceFiles: () => [],
    getWorkspaceDiff: () => ({workspace, gitAvailable: true, files: [], totalAdditions: 0, totalDeletions: 0}),
    sanitizeText: (t: string) => t,
  });
}

describe('FUTRYN Theme Engine & Built-in Theme Catalog', () => {
  test('offers Auto, Dark and Light with readable semantic colors and black/white surfaces', () => {
    expect(BUILTIN_COLOR_THEMES.map(theme => theme.id)).toEqual([
      'auto',
      'dark',
      'light',
      'dark-daltonized',
      'light-daltonized',
      'dark-ansi',
      'light-ansi',
      'midnight',
      'parchment',
    ]);
    expect(BUILTIN_LIVE_THEMES).toHaveLength(0);
    expect(ALL_BUILTIN_THEMES).toHaveLength(9);
    for (const manifest of ALL_BUILTIN_THEMES.slice(0, 3)) {
      expect(themeManifestSchema.safeParse(manifest).success).toBe(true);
      for (const tokens of [manifest.dark, manifest.light]) {
        for (const key of THEME_TOKEN_KEYS) expect(tokens[key]).toMatch(/^#[0-9a-f]{6}$/);
        for (const key of [
          'foreground',
          'error',
          'success',
          'syntaxKeyword',
          'syntaxString',
          'syntaxFunction',
          'info',
          'markdownCode',
          'markdownHeading',
        ] as const)
          expect(contrastRatio(tokens.background, tokens[key])).toBeGreaterThan(4.5);
        expect(contrastRatio(tokens.background, tokens.warning)).toBeGreaterThan(4.5);
        expect(contrastRatio(tokens.background, tokens.accent)).toBeGreaterThan(4.5);
        expect(new Set([tokens.error, tokens.warning, tokens.success, tokens.info]).size).toBe(4);
        expect(tokens.background === '#000000' || tokens.background === '#ffffff').toBe(true);
      }
      expect(getThemeMiniSwatches(manifest, 'dark').background).toBe(manifest.dark.background);
    }
  });

  test('Midnight and Parchment provide distinct readable colors on base, panel and prompt surfaces', () => {
    for (const id of ['midnight', 'parchment']) {
      const theme = BUILTIN_COLOR_THEMES.find(item => item.id === id)!;
      const palette = theme[theme.defaultMode];
      const roles = [
        palette.foreground,
        palette.foregroundMuted,
        palette.syntaxFunction,
        palette.syntaxKeyword,
        palette.syntaxString,
        palette.syntaxComment,
        palette.markdownHeading,
        palette.warning,
        palette.error,
      ];
      expect(new Set(roles).size).toBe(roles.length);
      for (const color of roles) {
        for (const surface of [palette.background, palette.backgroundPanel, palette.composerBackground]) {
          expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test('preview, cancel and project/global persistence follow dark, light and system', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-theme-test-'));
    try {
      const settings = new MemorySettingsStore();
      const custom = new FileCustomThemeStore(dir);
      const client = createTestClient(settings, custom);
      const engine = new ThemeEngine({client, systemDarkPreference: true});
      await engine.initialize();
      expect(engine.getActiveAppearance().theme).toBe('auto');
      engine.previewTheme('light');
      expect(engine.getActiveTokens().background).toBe('#ffffff');
      engine.cancelPreview();
      expect(engine.getActiveTokens().background).toBe('#000000');
      await engine.setTheme('dark');
      expect(engine.getActiveAppearance().mode).toBe('dark');
      await engine.setTheme('light', 'project');
      expect(engine.getActiveTokens().background).toBe('#ffffff');
      const restarted = new ThemeEngine({client, systemDarkPreference: true});
      await restarted.initialize();
      expect(restarted.getActiveAppearance().theme).toBe('light');
      const other = new ThemeEngine({
        client: createTestClient(settings, custom, '/workspace/proj-b'),
        systemDarkPreference: true,
      });
      await other.initialize();
      expect(other.getActiveAppearance().theme).toBe('dark');
      await other.setMode('system');
      expect(other.getActiveTokens().background).toBe('#000000');
      other.setSystemDarkPreference(false);
      expect(other.getActiveTokens().background).toBe('#ffffff');
      expect(other.getActiveAppearance().theme).toBe('auto');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('system mode reacts to a changed terminal/system preference', async () => {
    const env: Record<string, string> = {FUTRYN_THEME_MODE: 'dark'};
    const engine = new ThemeEngine({env});
    await engine.initialize();
    expect(engine.getEffectiveMode()).toBe('dark');
    env.FUTRYN_THEME_MODE = 'light';
    engine.refreshSystemPreference();
    expect(engine.getEffectiveMode()).toBe('light');
    await engine.setMode('dark');
    env.FUTRYN_THEME_MODE = 'light';
    engine.refreshSystemPreference();
    expect(engine.getEffectiveMode()).toBe('dark');
  });

  test('migrates previous profile IDs while preserving global and project preferences', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-theme-profile2-'));
    try {
      const settings = new MemorySettingsStore({
        ...emptySettings(),
        appearance: {...defaultAppearance(), theme: 'monochrome-dark', mode: 'dark'},
        projectAppearances: {'/workspace/proj-a': {theme: 'monochrome-light', mode: 'light'}},
      });
      const custom = new FileCustomThemeStore(dir);
      const engine = new ThemeEngine({client: createTestClient(settings, custom), systemDarkPreference: true});
      await engine.initialize();
      expect(settings.read().appearance?.theme).toBe('dark');
      expect(settings.read().projectAppearances?.['/workspace/proj-a']?.theme).toBe('light');
      expect(engine.getActiveTokens().background).toBe('#ffffff');
      await engine.setTheme('futryn-default');
      expect(settings.read().appearance?.theme).toBe('auto');
      expect(engine.getActiveAppearance().theme).toBe('light'); // explicit workspace override
      await engine.setTheme('monochrome-dark');
      expect(settings.read().appearance?.theme).toBe('dark');
      expect(engine.getActiveAppearance().theme).toBe('light');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('migrates old global and project appearances while retaining user theme files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-theme-migration-'));
    try {
      const settings = new MemorySettingsStore({
        ...emptySettings(),
        appearance: {...defaultAppearance(), theme: 'sakura', mode: 'dark', wallpaper: 'sakura-dusk'},
        projectAppearances: {'/workspace/proj-a': {theme: 'old-custom', mode: 'light', wallpaper: 'neon-rain'}},
      });
      const custom = new FileCustomThemeStore(dir);
      custom.save(
        themeManifestSchema.parse({
          ...BUILTIN_COLOR_THEMES[0]!,
          id: 'old-custom',
          builtIn: false,
          category: 'custom',
          dark: {...BUILTIN_COLOR_THEMES[0]!.dark, accent: '#ff0000'},
        }),
      );
      const engine = new ThemeEngine({client: createTestClient(settings, custom), systemDarkPreference: true});
      await engine.initialize();
      expect(engine.getActiveAppearance().theme).toBe('light');
      expect(engine.getActiveWallpaperPresetId()).toBeNull();
      expect(settings.read().appearance?.theme).toBe('dark');
      expect(settings.read().projectAppearances?.['/workspace/proj-a']?.theme).toBe('light');
      expect(custom.loadAll().themes.some(theme => theme.id === 'old-custom')).toBe(true);
      expect(engine.listThemes('all').map(theme => theme.id)).toEqual([
        'auto',
        'dark',
        'light',
        'dark-daltonized',
        'light-daltonized',
        'dark-ansi',
        'light-ansi',
        'midnight',
        'parchment',
      ]);
      await expect(engine.setTheme('old-custom')).rejects.toThrow();
      await expect(engine.setWallpaper('neon-rain')).rejects.toThrow();
      expect(engine.getActiveTokens().accent).toBe(BUILTIN_COLOR_THEMES[0]!.light.accent);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('imports FUTRYN, OpenCode, and Claude Desktop Themes formats with CompatibilityReport and rejects executable content', async () => {
    const engine = new ThemeEngine();
    await engine.initialize();

    // 1. OpenCode theme JSON import
    const openCodeJson = {
      id: 'oc-vesper',
      name: 'Vesper OpenCode',
      defs: {
        bg: '#101010',
        fg: '#ffffff',
        peppermint: '#99ffe4',
        amber: '#ffc799',
      },
      theme: {
        background: {dark: 'bg', light: '#fafafa'},
        text: {dark: 'fg', light: '#111111'},
        primary: {dark: 'amber', light: '#b85c00'},
        syntaxKeyword: {dark: 'peppermint', light: '#007a5e'},
        unknownWidgetGlow: 'unsupported-ref',
      },
    };
    const ocRes = await engine.importTheme(openCodeJson);
    expect(ocRes.report.sourceFormat).toBe('opencode');
    expect(ocRes.report.compatible).toBe(true);
    expect(ocRes.manifest?.id).toBe('oc-vesper');
    expect(ocRes.manifest?.dark.accent).toBe('#ffc799');
    expect(ocRes.manifest?.dark.syntaxKeyword).toBe('#99ffe4');
    expect(ocRes.report.unsupportedProperties).toContain('theme.unknownWidgetGlow');

    // 2. Claude Desktop Themes JSON + CSS + refused JS scene
    const claudeJson = {
      id: 'cd-aurora',
      name: 'Aurora Desktop',
      bg: '#111622',
      text: '#e5ecf6',
      accent: '#6be5b8',
      tagline: 'northern lights',
      wallpaper: 'star-voyage',
      vars: {
        'cds-radius': '0px',
        'wall-greet': '"hello north"',
        '--border-color': '#25314a',
      },
    };
    const cdRes = await engine.importTheme(claudeJson, {
      externalCss: '.card { border-radius: 0px; backdrop-filter: blur(12px); --accent: #6be5b8; }',
      hasExternalSceneJs: true,
    });
    expect(cdRes.report.sourceFormat).toBe('claude-desktop');
    expect(cdRes.report.compatible).toBe(true);
    expect(cdRes.report.refusedExecutableContent).toBe(true);
    expect(cdRes.manifest?.borderStyle).toBe('sharp');
    expect(cdRes.manifest?.greeting).toBe('hello north');
    expect(cdRes.manifest?.wallpaper).toBe('star-voyage');
    expect(cdRes.report.unsupportedProperties.some(p => p.includes('css'))).toBe(true);

    // 3. Malformed / unrecognized JSON is rejected safely without throwing
    const badRes = await engine.importTheme({random: 123});
    expect(badRes.report.compatible).toBe(false);
    expect(badRes.manifest).toBeNull();
  });

  test('recovers safely when custom theme file or configured theme is corrupted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-corrupt-test-'));
    try {
      const settingsStore = new MemorySettingsStore({
        ...emptySettings(),
        appearance: {
          ...defaultAppearance(),
          theme: 'missing-broken-theme',
        },
      });
      const customStore = new FileCustomThemeStore(dir);

      // Write a valid custom theme and a corrupted JSON file in themesDir
      customStore.save(
        themeManifestSchema.parse({
          ...BUILTIN_COLOR_THEMES[0]!,
          id: 'valid-custom',
          category: 'custom',
          builtIn: false,
        }),
      );
      await writeFile(join(dir, 'themes', 'broken-file.json'), '{ invalid json !!!', 'utf8');

      const client = createTestClient(settingsStore, customStore);
      const engine = new ThemeEngine({client});
      await engine.initialize();

      // Must not crash; falls back to futryn-default and keeps valid-custom
      expect(engine.getActiveAppearance().theme).toBe('auto');
      expect(engine.getTheme('valid-custom')).toBeDefined();
      expect(engine.getWarnings().length).toBeGreaterThan(0);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('detects terminal color capabilities and degrades ANSI sequences gracefully', () => {
    expect(detectTerminalColorCapability({NO_COLOR: '1'})).toBe('none');
    expect(detectTerminalColorCapability({COLORTERM: 'truecolor'})).toBe('truecolor');
    expect(detectTerminalColorCapability({TERM: 'xterm-256color'})).toBe('256');
    expect(detectTerminalColorCapability({TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app'})).toBe('truecolor');
    expect(detectTerminalColorCapability({TERM: 'xterm'})).toBe('16');

    expect(fgHex('#ff5500', 'none')).toBe('');
    expect(fgHex('#ff5500', 'truecolor')).toBe('\x1b[38;2;255;85;0m');
    expect(fgHex('#ff5500', '256')).toMatch(/^\x1b\[38;5;\d+m$/);
    expect(fgHex('#ff5500', '16')).toMatch(/^\x1b\[\d+m$/);
    expect(bgHex('#14121b', 'truecolor')).toBe('\x1b[48;2;20;18;27m');
  });
});
