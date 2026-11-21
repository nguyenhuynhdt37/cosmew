import {
  FutrynError,
  THEME_TOKEN_KEYS,
  appearanceSchema,
  defaultAnimationConfig,
  defaultAppearance,
  themeIdSchema,
  themeManifestSchema,
  type AnimationConfig,
  type AppearanceConfig,
  type BorderStyle,
  type CompatibilityReport,
  type PartialAppearanceConfig,
  type ThemeManifest,
  type ThemeMode,
  type ThemeTokenKey,
  type ThemeTokens,
} from '@cosmew/contracts';
import type {FutrynClient} from '@cosmew/sdk';
import {
  ALL_BUILTIN_THEMES,
  BUILTIN_COLOR_THEMES,
  BUILTIN_LIVE_THEMES,
  contrastRatio,
  deriveTokensFromTriplet,
  formatRgbHex,
  mixHex,
  parseHexRgb,
  relativeLuminance,
} from './presets';
import {importThemeManifest, validateHexColor, type ThemeImportResult} from './compat';
import {WALLPAPER_SCENES, WallpaperEngine} from './wallpaper';
import {isDarkBackground, type Rgb} from './terminal-background';

export type TerminalColorCapability = 'truecolor' | '256' | '16' | 'none';
export type ThemePickerTab = 'featured' | 'colors' | 'live' | 'my-themes' | 'all';

const FEATURED_THEME_IDS = new Set(['auto', 'dark', 'light']);
const MODE_THEME_IDS: Record<ThemeMode, string> = {system: 'auto', dark: 'dark', light: 'light'};
const THEME_MODES: Record<string, ThemeMode> = {
  auto: 'system',
  dark: 'dark',
  light: 'light',
  'dark-daltonized': 'dark',
  'light-daltonized': 'light',
  'dark-ansi': 'dark',
  'light-ansi': 'light',
};

/** Shared selection path for the picker and /config. */
export function themeSelection(id: string): PartialAppearanceConfig {
  const clean = id.trim().toLowerCase();
  const theme =
    (
      {system: 'auto', 'futryn-default': 'auto', 'monochrome-dark': 'dark', 'monochrome-light': 'light'} as Record<
        string,
        string
      >
    )[clean] ?? clean;
  if (!ALL_BUILTIN_THEMES.some(item => item.id === theme)) throw new FutrynError('NOT_FOUND');
  return {theme, mode: THEME_MODES[theme] ?? 'system'};
}

export function detectTerminalColorCapability(
  env: Record<string, string | undefined> = process.env,
): TerminalColorCapability {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return 'none';
  }
  const forceColor = env.FORCE_COLOR;
  if (forceColor === '0') return 'none';
  if (forceColor === '1') return '16';
  if (forceColor === '2') return '256';
  if (forceColor === '3') return 'truecolor';

  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) {
    return 'truecolor';
  }
  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'dumb') return 'none';
  if (
    term.includes('256color') ||
    term.includes('xterm-kitty') ||
    term.includes('alacritty') ||
    term.includes('wezterm')
  ) {
    return colorterm ? 'truecolor' : '256';
  }
  if (
    env.WT_SESSION ||
    env.TERM_PROGRAM === 'iTerm.app' ||
    env.TERM_PROGRAM === 'WezTerm' ||
    env.TERM_PROGRAM === 'vscode'
  ) {
    return 'truecolor';
  }
  if (
    term.includes('color') ||
    term.includes('xterm') ||
    term.includes('screen') ||
    term.includes('tmux') ||
    term.includes('vt100')
  ) {
    return '16';
  }
  return 'truecolor';
}

export function hexToAnsi256(hex: string): number {
  const [r, g, b] = parseHexRgb(hex);
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const r6 = Math.round((r / 255) * 5);
  const g6 = Math.round((g / 255) * 5);
  const b6 = Math.round((b / 255) * 5);
  return 16 + 36 * r6 + 6 * g6 + b6;
}

export function hexToAnsi16Fg(hex: string): number {
  const [r, g, b] = parseHexRgb(hex);
  const lum = relativeLuminance(hex);
  const bright = lum > 0.35 ? 60 : 0;
  const rBit = r >= 128 ? 1 : 0;
  const gBit = g >= 128 ? 2 : 0;
  const bBit = b >= 128 ? 4 : 0;
  return 30 + bright + (rBit | gBit | bBit);
}

export function hexToAnsi16Bg(hex: string): number {
  return hexToAnsi16Fg(hex) + 10;
}

export function fgHex(hex: string, capability: TerminalColorCapability = 'truecolor'): string {
  if (capability === 'none') return '';
  if (capability === '16') return `\x1b[${hexToAnsi16Fg(hex)}m`;
  if (capability === '256') return `\x1b[38;5;${hexToAnsi256(hex)}m`;
  const [r, g, b] = parseHexRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function bgHex(hex: string, capability: TerminalColorCapability = 'truecolor'): string {
  if (capability === 'none') return '';
  if (capability === '16') return `\x1b[${hexToAnsi16Bg(hex)}m`;
  if (capability === '256') return `\x1b[48;5;${hexToAnsi256(hex)}m`;
  const [r, g, b] = parseHexRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export interface BorderGlyphSet {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

export function getBorderGlyphs(style: BorderStyle = 'rounded'): BorderGlyphSet {
  switch (style) {
    case 'double':
      return {
        topLeft: '╔',
        topRight: '╗',
        bottomLeft: '╚',
        bottomRight: '╝',
        horizontal: '═',
        vertical: '║',
      };
    case 'heavy':
      return {
        topLeft: '┏',
        topRight: '┓',
        bottomLeft: '┗',
        bottomRight: '┛',
        horizontal: '━',
        vertical: '┃',
      };
    case 'sharp':
      return {
        topLeft: '┌',
        topRight: '┐',
        bottomLeft: '└',
        bottomRight: '┘',
        horizontal: '─',
        vertical: '│',
      };
    case 'soft':
    case 'rounded':
    default:
      return {
        topLeft: '╭',
        topRight: '╮',
        bottomLeft: '╰',
        bottomRight: '╯',
        horizontal: '─',
        vertical: '│',
      };
  }
}

export interface MiniColorSwatches {
  background: string;
  panel: string;
  accent: string;
  foreground: string;
  success: string;
}

export function getThemeMiniSwatches(manifest: ThemeManifest, mode: 'dark' | 'light' = 'dark'): MiniColorSwatches {
  const tokens = mode === 'light' ? manifest.light : manifest.dark;
  return {
    background: tokens.background,
    panel: tokens.backgroundElevated,
    accent: tokens.accent,
    foreground: tokens.foreground,
    success: tokens.success,
  };
}

export interface ThemeEngineOptions {
  client?: FutrynClient;
  env?: Record<string, string | undefined>;
  systemDarkPreference?: boolean;
}

export type ThemeChangeListener = (engine: ThemeEngine) => void;

export class ThemeEngine {
  private readonly client?: FutrynClient;
  private readonly env: Record<string, string | undefined>;
  private systemDarkPreference: boolean;
  private readonly fixedSystemPreference: boolean;
  private readonly builtInMap = new Map<string, ThemeManifest>();
  private readonly customMap = new Map<string, ThemeManifest>();
  private committedAppearance: AppearanceConfig = defaultAppearance();
  private previewThemeId: string | null = null;
  private previewDraft: ThemeManifest | null = null;
  private previewMode: ThemeMode | null = null;
  private previewWallpaper: string | null | undefined = undefined;
  private previewAnimations: AnimationConfig | null = null;
  private readonly warnings: string[] = [];
  private readonly listeners = new Set<ThemeChangeListener>();
  public readonly wallpaperEngine = new WallpaperEngine();
  public readonly colorCapability: TerminalColorCapability;

  public constructor(options: ThemeEngineOptions = {}) {
    this.client = options.client;
    this.env = options.env ?? process.env;
    this.fixedSystemPreference = options.systemDarkPreference !== undefined;
    this.systemDarkPreference = options.systemDarkPreference ?? this.detectSystemDark();
    this.colorCapability = detectTerminalColorCapability(this.env);

    for (const theme of ALL_BUILTIN_THEMES) {
      this.builtInMap.set(theme.id, theme);
    }
  }

  private detectSystemDark(): boolean {
    const colorfgbg = this.env.COLORFGBG;
    if (colorfgbg && colorfgbg.includes(';')) {
      const parts = colorfgbg.split(';');
      const bgCode = Number(parts[parts.length - 1]);
      if (Number.isFinite(bgCode)) {
        return bgCode < 7 || bgCode === 8;
      }
    }
    const modeEnv = (
      this.env.COSMEW_THEME_MODE ??
      this.env.FUTRYN_THEME_MODE ??
      this.env.HANNES_THEME_MODE ??
      ''
    ).toLowerCase();
    if (modeEnv === 'light') return false;
    if (modeEnv === 'dark') return true;
    return true;
  }

  public async initialize(): Promise<void> {
    this.warnings.length = 0;
    if (this.client) {
      try {
        const loaded = this.client.loadCustomThemes();
        this.customMap.clear();
        for (const err of loaded.errors) {
          this.warnings.push(`Theme file "${err.file}": ${err.message}`);
        }
        for (const item of loaded.themes) {
          if (this.builtInMap.has(item.id)) {
            this.warnings.push(`Ignored custom theme "${item.id}" because it conflicts with a built-in theme ID.`);
            continue;
          }
          const parsed = themeManifestSchema.safeParse({
            ...item,
            category: 'custom',
            builtIn: false,
          });
          if (parsed.success) {
            this.customMap.set(parsed.data.id, parsed.data);
          } else {
            this.warnings.push(`Skipped invalid custom theme "${item.id}".`);
          }
        }
      } catch (err) {
        this.warnings.push(
          `Failed to load custom themes: ${err instanceof Error ? err.message : 'unknown error'}. Continuing with built-in themes.`,
        );
      }

      try {
        const app = this.client.getAppearance(true);
        this.committedAppearance = appearanceSchema.parse(app);
      } catch {
        this.committedAppearance = defaultAppearance();
        this.warnings.push('Appearance configuration was invalid; recovered with default COSMEW appearance.');
      }
    }

    // Preserve user-owned theme files, but migrate every active selection to the
    // dark/light palette. Correct global and project overrides independently.
    const migrate = (appearance: AppearanceConfig): PartialAppearanceConfig | null => {
      const id = this.normalizeThemeId(appearance.theme);
      const desired =
        this.builtInMap.has(id) && THEME_MODES[id] === appearance.mode ? id : MODE_THEME_IDS[appearance.mode];
      return appearance.theme !== desired || appearance.wallpaper !== null ? {theme: desired, wallpaper: null} : null;
    };
    if (this.client) {
      try {
        const global = this.client.getAppearance(false);
        const globalPatch = migrate(global);
        if (globalPatch) this.client.updateAppearance(globalPatch, 'global');
        const current = this.client.getAppearance(true);
        const projectPatch = migrate(current);
        if (projectPatch) this.client.updateAppearance(projectPatch, 'project');
        this.committedAppearance = appearanceSchema.parse(this.client.getAppearance(true));
      } catch {
        this.warnings.push('Could not save appearance; using it for this session.');
        this.committedAppearance = {
          ...this.committedAppearance,
          theme: MODE_THEME_IDS[this.committedAppearance.mode],
          wallpaper: null,
        };
      }
    } else {
      this.committedAppearance = {
        ...this.committedAppearance,
        theme: MODE_THEME_IDS[this.committedAppearance.mode],
        wallpaper: null,
      };
    }

    this.notify();
  }

  public getWarnings(): readonly string[] {
    return this.warnings;
  }

  public subscribe(listener: ThemeChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this);
    }
  }

  public normalizeThemeId(id: string): string {
    const clean = id.trim().toLowerCase();
    if (clean === 'system' || clean === 'futryn-default') return 'auto';
    if (clean === 'monochrome-dark') return 'dark';
    if (clean === 'monochrome-light') return 'light';
    return clean;
  }

  public hasTheme(id: string): boolean {
    const norm = this.normalizeThemeId(id);
    return this.builtInMap.has(norm);
  }

  public getTheme(id: string): ThemeManifest | undefined {
    const norm = this.normalizeThemeId(id);
    if (this.previewDraft && this.previewDraft.id === norm) {
      return this.previewDraft;
    }
    return this.builtInMap.get(norm) ?? this.customMap.get(norm);
  }

  public listThemes(tab: ThemePickerTab = 'all', query = ''): ThemeManifest[] {
    const all: ThemeManifest[] = [...BUILTIN_COLOR_THEMES, ...BUILTIN_LIVE_THEMES];

    let filtered = all;
    if (tab === 'featured') {
      filtered = all.filter(t => FEATURED_THEME_IDS.has(t.id));
    } else if (tab === 'colors') {
      filtered = all;
    } else if (tab === 'live') {
      filtered = all.filter(t => t.category === 'live');
    } else if (tab === 'my-themes') {
      filtered = all.filter(t => !t.builtIn || t.category === 'custom');
    }

    const q = query.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter(
      t =>
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q),
    );
  }

  public getCommittedAppearance(): AppearanceConfig {
    return this.committedAppearance;
  }

  public getActiveAppearance(): AppearanceConfig {
    return {
      theme: this.previewDraft?.id ?? this.previewThemeId ?? this.committedAppearance.theme,
      mode: this.previewMode ?? this.committedAppearance.mode,
      wallpaper: this.previewWallpaper !== undefined ? this.previewWallpaper : this.committedAppearance.wallpaper,
      animations: this.previewAnimations ?? this.committedAppearance.animations,
      syntaxHighlighting: this.committedAppearance.syntaxHighlighting,
      sidebar: this.committedAppearance.sidebar,
    };
  }

  public getEffectiveMode(): 'dark' | 'light' {
    const app = this.getActiveAppearance();
    if (app.mode === 'dark' || app.mode === 'light') {
      return app.mode;
    }
    return this.systemDarkPreference ? 'dark' : 'light';
  }

  public refreshSystemPreference(): void {
    if (this.fixedSystemPreference) return;
    const next = this.detectSystemDark();
    if (next !== this.systemDarkPreference) this.setSystemDarkPreference(next);
  }

  /** An answer from the terminal (OSC 11) wins over COLORFGBG and COSMEW_THEME_MODE for `auto`. */
  public applyTerminalBackground(rgb: Rgb | undefined): void {
    if (!rgb || this.fixedSystemPreference) return;
    this.setSystemDarkPreference(isDarkBackground(rgb));
  }

  public setSystemDarkPreference(isDark: boolean): void {
    this.systemDarkPreference = isDark;
    this.notify();
  }

  public getActiveThemeManifest(): ThemeManifest {
    if (this.previewDraft) {
      return this.previewDraft;
    }
    const activeId = this.previewThemeId ?? this.committedAppearance.theme;
    return this.getTheme(activeId) ?? this.builtInMap.get('auto') ?? ALL_BUILTIN_THEMES[0]!;
  }

  public getActiveTokens(): ThemeTokens {
    const manifest = this.getActiveThemeManifest();
    const mode = this.getEffectiveMode();
    return mode === 'light' ? manifest.light : manifest.dark;
  }

  public getActiveWallpaperPresetId(): string | null {
    return null;
  }

  public isPreviewing(): boolean {
    return (
      this.previewThemeId !== null ||
      this.previewDraft !== null ||
      this.previewMode !== null ||
      this.previewWallpaper !== undefined ||
      this.previewAnimations !== null
    );
  }

  public previewTheme(id: string): ThemeManifest {
    const norm = this.normalizeThemeId(id);
    const manifest = this.getTheme(norm);
    if (!manifest) {
      throw new FutrynError('NOT_FOUND');
    }
    if (!manifest.builtIn) throw new FutrynError('UNSUPPORTED');
    this.previewThemeId = manifest.id;
    this.previewMode = THEME_MODES[manifest.id] ?? 'system';
    this.previewDraft = null;
    if (manifest.wallpaper) {
      this.previewWallpaper = manifest.wallpaper;
      this.previewAnimations = {
        ...(this.previewAnimations ?? this.committedAppearance.animations),
        enabled: true,
      };
    }
    this.notify();
    return manifest;
  }

  public previewDraftManifest(_manifest: ThemeManifest): void {
    throw new FutrynError('UNSUPPORTED');
  }

  public cancelPreview(): AppearanceConfig {
    this.previewThemeId = null;
    this.previewDraft = null;
    this.previewMode = null;
    this.previewWallpaper = undefined;
    this.previewAnimations = null;
    this.notify();
    return this.committedAppearance;
  }

  public async commitPreview(scope?: 'global' | 'project'): Promise<AppearanceConfig> {
    if (!this.isPreviewing()) {
      return this.committedAppearance;
    }
    if (this.previewDraft && !this.previewDraft.builtIn) {
      await this.saveCustomTheme(this.previewDraft);
    }
    const next: PartialAppearanceConfig = {};
    if (this.previewThemeId !== null) next.theme = this.previewThemeId;
    if (this.previewMode !== null) next.mode = this.previewMode;
    if (this.previewWallpaper !== undefined) next.wallpaper = this.previewWallpaper;
    if (this.previewAnimations !== null) next.animations = this.previewAnimations;

    this.previewThemeId = null;
    this.previewDraft = null;
    this.previewMode = null;
    this.previewWallpaper = undefined;
    this.previewAnimations = null;

    return this.updateAppearance(next, scope);
  }

  public async updateAppearance(
    patch: PartialAppearanceConfig,
    scope: 'global' | 'project' = 'global',
  ): Promise<AppearanceConfig> {
    const normalizedPatch: PartialAppearanceConfig = {...patch};
    if (normalizedPatch.wallpaper != null) throw new FutrynError('UNSUPPORTED');
    if (normalizedPatch.mode && normalizedPatch.theme === undefined)
      normalizedPatch.theme = MODE_THEME_IDS[normalizedPatch.mode];
    if (normalizedPatch.theme !== undefined) {
      const normId = this.normalizeThemeId(normalizedPatch.theme);
      const manifest = this.getTheme(normId);
      if (!manifest) {
        throw new FutrynError('NOT_FOUND');
      }
      if (!manifest.builtIn) throw new FutrynError('UNSUPPORTED');
      Object.assign(normalizedPatch, themeSelection(manifest.id));
      if (manifest.wallpaper && normalizedPatch.wallpaper === undefined) {
        normalizedPatch.wallpaper = manifest.wallpaper;
        normalizedPatch.animations = {
          ...this.committedAppearance.animations,
          ...(normalizedPatch.animations ?? {}),
          enabled: true,
        };
      }
    }

    if (this.client) {
      this.committedAppearance = this.client.updateAppearance(normalizedPatch, scope);
    } else {
      this.committedAppearance = appearanceSchema.parse({
        ...this.committedAppearance,
        ...normalizedPatch,
        animations: {
          ...this.committedAppearance.animations,
          ...(normalizedPatch.animations ?? {}),
        },
      });
    }
    this.notify();
    return this.committedAppearance;
  }

  public async setTheme(id: string, scope: 'global' | 'project' = 'global'): Promise<AppearanceConfig> {
    this.cancelPreview();
    const norm = this.normalizeThemeId(id);
    const manifest = this.getTheme(norm);
    if (!manifest) {
      throw new FutrynError('NOT_FOUND');
    }
    if (!manifest.builtIn) throw new FutrynError('UNSUPPORTED');
    const patch: PartialAppearanceConfig = {
      theme: manifest.id,
    };
    if (manifest.wallpaper) {
      patch.wallpaper = manifest.wallpaper;
      patch.animations = {
        ...this.committedAppearance.animations,
        enabled: true,
      };
    } else if (this.committedAppearance.wallpaper && this.builtInMap.get(this.committedAppearance.theme)?.wallpaper) {
      patch.wallpaper = null;
    }
    return this.updateAppearance(patch, scope);
  }

  public async setMode(mode: ThemeMode, scope: 'global' | 'project' = 'global'): Promise<AppearanceConfig> {
    return this.updateAppearance({mode}, scope);
  }

  public async setWallpaper(
    wallpaper: string | null,
    enabled = wallpaper !== null,
    scope: 'global' | 'project' = 'global',
  ): Promise<AppearanceConfig> {
    if (wallpaper !== null) throw new FutrynError('UNSUPPORTED');
    return this.updateAppearance(
      {
        wallpaper: wallpaper === 'clawd' ? 'futryn-spark' : wallpaper,
        animations: {
          ...this.committedAppearance.animations,
          enabled,
        },
      },
      scope,
    );
  }

  public async updateAnimation(
    patch: Partial<AnimationConfig>,
    scope: 'global' | 'project' = 'global',
  ): Promise<AppearanceConfig> {
    return this.updateAppearance(
      {
        animations: {
          ...this.committedAppearance.animations,
          ...patch,
        },
      },
      scope,
    );
  }

  public async resetAppearance(scope: 'global' | 'project' = 'global'): Promise<AppearanceConfig> {
    this.cancelPreview();
    const fresh = defaultAppearance();
    return this.updateAppearance(fresh, scope);
  }

  // ============================================================================
  // THEME EDITOR & CUSTOMIZATION OPERATIONS
  // ============================================================================

  public async saveCustomTheme(manifest: ThemeManifest): Promise<ThemeManifest> {
    const id = themeIdSchema.parse(manifest.id);
    if (this.builtInMap.has(id)) {
      throw new FutrynError('UNSUPPORTED');
    }
    const validated = themeManifestSchema.parse({
      ...manifest,
      id,
      category: 'custom',
      builtIn: false,
    });
    if (this.client) {
      this.client.saveCustomTheme(validated);
    }
    this.customMap.set(validated.id, validated);
    this.notify();
    return validated;
  }

  public async duplicateTheme(sourceId: string, newId: string, newName?: string): Promise<ThemeManifest> {
    const source = this.getTheme(sourceId);
    if (!source) {
      throw new FutrynError('NOT_FOUND');
    }
    const cleanId = themeIdSchema.parse(newId);
    if (this.builtInMap.has(cleanId)) {
      throw new FutrynError('UNSUPPORTED');
    }
    const copy: ThemeManifest = themeManifestSchema.parse({
      ...source,
      id: cleanId,
      name: newName?.trim() ? newName.trim().slice(0, 80) : `${source.name} (Custom)`,
      category: 'custom',
      builtIn: false,
      sourceFormat: 'futryn',
      dark: {...source.dark},
      light: {...source.light},
    });
    return this.saveCustomTheme(copy);
  }

  public async renameCustomTheme(id: string, newName: string): Promise<ThemeManifest> {
    const norm = this.normalizeThemeId(id);
    if (this.builtInMap.has(norm)) {
      throw new FutrynError('UNSUPPORTED');
    }
    const existing = this.customMap.get(norm);
    if (!existing) {
      throw new FutrynError('NOT_FOUND');
    }
    const trimmed = newName.trim().slice(0, 80);
    if (!trimmed) {
      throw new FutrynError('INVALID_INPUT');
    }
    return this.saveCustomTheme({
      ...existing,
      name: trimmed,
    });
  }

  public async updateCustomThemeToken(
    id: string,
    mode: 'dark' | 'light',
    tokenKey: ThemeTokenKey,
    hexValue: string,
  ): Promise<ThemeManifest> {
    const norm = this.normalizeThemeId(id);
    if (this.builtInMap.has(norm)) {
      throw new FutrynError('UNSUPPORTED');
    }
    const existing = this.customMap.get(norm);
    if (!existing) {
      throw new FutrynError('NOT_FOUND');
    }
    const validHex = validateHexColor(hexValue).toLowerCase();
    const updated: ThemeManifest = {
      ...existing,
      [mode]: {
        ...existing[mode],
        [tokenKey]: validHex,
      },
    };
    return this.saveCustomTheme(updated);
  }

  public async resetCustomThemeToken(
    id: string,
    mode: 'dark' | 'light',
    tokenKey: ThemeTokenKey,
    baseThemeId = 'auto',
  ): Promise<ThemeManifest> {
    const norm = this.normalizeThemeId(id);
    if (this.builtInMap.has(norm)) {
      throw new FutrynError('UNSUPPORTED');
    }
    const existing = this.customMap.get(norm);
    if (!existing) {
      throw new FutrynError('NOT_FOUND');
    }
    const base = this.getTheme(baseThemeId) ?? this.builtInMap.get('auto')!;
    const updated: ThemeManifest = {
      ...existing,
      [mode]: {
        ...existing[mode],
        [tokenKey]: base[mode][tokenKey],
      },
    };
    return this.saveCustomTheme(updated);
  }

  public async resetCustomTheme(id: string, baseThemeId = 'auto'): Promise<ThemeManifest> {
    const norm = this.normalizeThemeId(id);
    if (this.builtInMap.has(norm)) {
      throw new FutrynError('UNSUPPORTED');
    }
    const existing = this.customMap.get(norm);
    if (!existing) {
      throw new FutrynError('NOT_FOUND');
    }
    const base = this.getTheme(baseThemeId) ?? this.builtInMap.get('auto')!;
    const updated: ThemeManifest = {
      ...existing,
      dark: {...base.dark},
      light: {...base.light},
      borderStyle: base.borderStyle,
      wallpaper: base.wallpaper,
    };
    return this.saveCustomTheme(updated);
  }

  public async removeCustomTheme(id: string): Promise<void> {
    const norm = this.normalizeThemeId(id);
    if (this.builtInMap.has(norm)) {
      throw new FutrynError('UNSUPPORTED');
    }
    if (!this.customMap.has(norm)) {
      throw new FutrynError('NOT_FOUND');
    }
    if (this.client) {
      this.client.removeCustomTheme(norm);
    }
    this.customMap.delete(norm);
    if (this.committedAppearance.theme === norm) {
      await this.setTheme('auto');
    } else {
      this.notify();
    }
  }

  public async importTheme(
    raw: unknown,
    options?: {
      externalCss?: string;
      hasExternalSceneJs?: boolean;
      suggestedId?: string;
      save?: boolean;
    },
  ): Promise<ThemeImportResult> {
    const result = importThemeManifest(raw, options);
    if (result.manifest && options?.save !== false) {
      const saved = await this.saveCustomTheme(result.manifest);
      return {
        manifest: saved,
        report: result.report,
      };
    }
    return result;
  }

  public exportTheme(id?: string): ThemeManifest {
    const targetId = id ? this.normalizeThemeId(id) : this.getActiveThemeManifest().id;
    const manifest = this.getTheme(targetId);
    if (!manifest) {
      throw new FutrynError('NOT_FOUND');
    }
    return JSON.parse(JSON.stringify(manifest)) as ThemeManifest;
  }
}

export {
  ALL_BUILTIN_THEMES,
  BUILTIN_COLOR_THEMES,
  BUILTIN_LIVE_THEMES,
  THEME_TOKEN_KEYS,
  WALLPAPER_SCENES,
  WallpaperEngine,
  contrastRatio,
  defaultAnimationConfig,
  deriveTokensFromTriplet,
  formatRgbHex,
  importThemeManifest,
  mixHex,
  parseHexRgb,
  relativeLuminance,
  validateHexColor,
  type CompatibilityReport,
  type ThemeImportResult,
};
