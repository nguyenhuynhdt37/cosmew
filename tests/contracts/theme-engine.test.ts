import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  THEME_TOKEN_KEYS,
  defaultAppearance,
  emptySettings,
  themeManifestSchema,
  type Settings,
  type SettingsStore,
  type ThemeManifest,
} from '@hannes/contracts';
import { FileCustomThemeStore } from '@hannes/persistence';
import { FutrynClient } from '@hannes/sdk';
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
} from '@hannes/tui';

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
    validateAccount: async () => ({ models: 0, validation: 'ok' }),
    discoverModels: async () => ({ models: [], stale: false }),
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
    getWorkspaceDiff: () => ({ workspace, gitAvailable: true, files: [], totalAdditions: 0, totalDeletions: 0 }),
    sanitizeText: (t: string) => t,
  });
}

describe('FUTRYN Theme Engine & Built-in Theme Catalog', () => {
  test('provides all 15 built-in color themes and 12 live wallpaper themes with 30 valid semantic tokens', () => {
    expect(BUILTIN_COLOR_THEMES.length).toBe(15);
    expect(BUILTIN_LIVE_THEMES.length).toBe(12);
    expect(ALL_BUILTIN_THEMES.length).toBe(27);

    const requiredColorIds = [
      'sunset-cloud',
      'sakura',
      'terminal',
      'night-sea',
      'old-paper',
      'futryn-default',
      'opencode',
      'catppuccin',
      'tokyo-night',
      'dracula',
      'nord',
      'gruvbox',
      'rose-pine',
      'kanagawa',
      'one-dark',
    ];
    for (const id of requiredColorIds) {
      const found = BUILTIN_COLOR_THEMES.find(t => t.id === id);
      expect(found).toBeDefined();
    }

    const requiredLiveIds = [
      'moonlit',
      'futryn-spark',
      'cloud-drift',
      'honu-lagoon',
      'koi-pond',
      'jellyfish',
      'lantern-night',
      'fireflies',
      'neon-rain',
      'sakura-dusk',
      'snow-cabin',
      'star-voyage',
    ];
    for (const id of requiredLiveIds) {
      const found = BUILTIN_LIVE_THEMES.find(t => t.id === id);
      expect(found).toBeDefined();
      expect(found?.wallpaper).toBe(id);
    }

    for (const manifest of ALL_BUILTIN_THEMES) {
      const parsed = themeManifestSchema.safeParse(manifest);
      expect(parsed.success).toBe(true);
      for (const key of THEME_TOKEN_KEYS) {
        expect(manifest.dark[key]).toMatch(/^#[0-9a-f]{6}$/);
        expect(manifest.light[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(contrastRatio(manifest.dark.background, manifest.dark.foreground)).toBeGreaterThan(4.5);
      expect(contrastRatio(manifest.light.background, manifest.light.foreground)).toBeGreaterThan(4.5);

      const swatches = getThemeMiniSwatches(manifest, 'dark');
      expect(swatches.background).toBe(manifest.dark.background);
      expect(swatches.accent).toBe(manifest.dark.accent);
    }
  });

  test('supports live switching, preview/cancel restoration, and global & project persistence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-theme-test-'));
    try {
      const settingsStore = new MemorySettingsStore();
      const customStore = new FileCustomThemeStore(dir);

      const clientA = createTestClient(settingsStore, customStore, '/workspace/proj-a');
      const engine = new ThemeEngine({ client: clientA });
      await engine.initialize();

      expect(engine.getActiveAppearance().theme).toBe('futryn-default');

      // Switch to Sakura globally
      await engine.setTheme('sakura');
      expect(engine.getActiveAppearance().theme).toBe('sakura');
      expect(engine.getActiveTokens().accent).toBe('#f07199');

      // Preview Terminal theme without committing
      engine.previewTheme('terminal');
      expect(engine.isPreviewing()).toBe(true);
      expect(engine.getActiveAppearance().theme).toBe('terminal');
      expect(engine.getActiveTokens().accent).toBe('#39e87a');

      // Cancel preview restores Sakura
      engine.cancelPreview();
      expect(engine.isPreviewing()).toBe(false);
      expect(engine.getActiveAppearance().theme).toBe('sakura');
      expect(engine.getActiveTokens().accent).toBe('#f07199');

      // Preview Night Sea and commit
      engine.previewTheme('night-sea');
      await engine.commitPreview();
      expect(engine.isPreviewing()).toBe(false);
      expect(engine.getActiveAppearance().theme).toBe('night-sea');

      // Verify restart persistence with a new ThemeEngine instance
      const restarted = new ThemeEngine({ client: clientA });
      await restarted.initialize();
      expect(restarted.getActiveAppearance().theme).toBe('night-sea');

      // Project-scoped override
      await restarted.setTheme('old-paper', 'project');
      expect(restarted.getActiveAppearance().theme).toBe('old-paper');

      // Global project still uses night-sea
      const clientB = createTestClient(settingsStore, customStore, '/workspace/proj-b');
      const otherProjectEngine = new ThemeEngine({ client: clientB });
      await otherProjectEngine.initialize();
      expect(otherProjectEngine.getActiveAppearance().theme).toBe('night-sea');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('supports dark, light, and system modes dynamically', async () => {
    const engine = new ThemeEngine({ systemDarkPreference: true });
    await engine.initialize();
    await engine.setTheme('sunset-cloud');

    await engine.setMode('system');
    expect(engine.getEffectiveMode()).toBe('dark');
    const darkBg = engine.getActiveTokens().background;

    engine.setSystemDarkPreference(false);
    expect(engine.getEffectiveMode()).toBe('light');
    const lightBg = engine.getActiveTokens().background;
    expect(lightBg).not.toBe(darkBg);

    await engine.setMode('dark');
    expect(engine.getEffectiveMode()).toBe('dark');
  });

  test('supports Theme Editor operations while keeping built-in themes immutable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-editor-test-'));
    try {
      const settingsStore = new MemorySettingsStore();
      const customStore = new FileCustomThemeStore(dir);
      const client = createTestClient(settingsStore, customStore);
      const engine = new ThemeEngine({ client });
      await engine.initialize();

      // Cannot overwrite or delete built-in theme
      await expect(engine.removeCustomTheme('sakura')).rejects.toThrow();
      await expect(
        engine.updateCustomThemeToken('sakura', 'dark', 'accent', '#ff00ff'),
      ).rejects.toThrow();

      // Duplicate built-in theme into custom theme
      const custom = await engine.duplicateTheme('sakura', 'my-sakura', 'My Sakura Custom');
      expect(custom.id).toBe('my-sakura');
      expect(custom.builtIn).toBe(false);
      expect(custom.category).toBe('custom');

      // Update token on custom theme
      const edited = await engine.updateCustomThemeToken('my-sakura', 'dark', 'accent', '#ff3399');
      expect(edited.dark.accent).toBe('#ff3399');

      // Reset single token back to Sakura base
      const resetToken = await engine.resetCustomThemeToken('my-sakura', 'dark', 'accent', 'sakura');
      expect(resetToken.dark.accent).toBe('#f07199');

      // Rename custom theme
      const renamed = await engine.renameCustomTheme('my-sakura', 'Sakura Pro');
      expect(renamed.name).toBe('Sakura Pro');

      // Export & remove
      const exported = engine.exportTheme('my-sakura');
      expect(exported.name).toBe('Sakura Pro');

      await engine.setTheme('my-sakura');
      expect(engine.getActiveAppearance().theme).toBe('my-sakura');

      // Removing active custom theme falls back to futryn-default safely
      await engine.removeCustomTheme('my-sakura');
      expect(engine.getActiveAppearance().theme).toBe('futryn-default');
      expect(engine.listThemes('my-themes').length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
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
        background: { dark: 'bg', light: '#fafafa' },
        text: { dark: 'fg', light: '#111111' },
        primary: { dark: 'amber', light: '#b85c00' },
        syntaxKeyword: { dark: 'peppermint', light: '#007a5e' },
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
    const badRes = await engine.importTheme({ random: 123 });
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
      const engine = new ThemeEngine({ client });
      await engine.initialize();

      // Must not crash; falls back to futryn-default and keeps valid-custom
      expect(engine.getActiveAppearance().theme).toBe('futryn-default');
      expect(engine.getTheme('valid-custom')).toBeDefined();
      expect(engine.getWarnings().length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('detects terminal color capabilities and degrades ANSI sequences gracefully', () => {
    expect(detectTerminalColorCapability({ NO_COLOR: '1' })).toBe('none');
    expect(detectTerminalColorCapability({ COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(detectTerminalColorCapability({ TERM: 'xterm-256color' })).toBe('256');
    expect(detectTerminalColorCapability({ TERM: 'xterm' })).toBe('16');

    expect(fgHex('#ff5500', 'none')).toBe('');
    expect(fgHex('#ff5500', 'truecolor')).toBe('\x1b[38;2;255;85;0m');
    expect(fgHex('#ff5500', '256')).toMatch(/^\x1b\[38;5;\d+m$/);
    expect(fgHex('#ff5500', '16')).toMatch(/^\x1b\[\d+m$/);
    expect(bgHex('#14121b', 'truecolor')).toBe('\x1b[48;2;20;18;27m');
  });
});
