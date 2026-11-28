import {
  themeManifestSchema,
  type BorderStyle,
  type ThemeCategory,
  type ThemeManifest,
  type ThemeTokens,
} from '@cosmew/contracts';
import {GITHUB_PALETTES, GITHUB_THEME_IDS, PRIMER_SOURCE} from './github-palettes';

export function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
}

export function formatRgbHex([r, g, b]: [number, number, number]): string {
  const clamp = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

export function mixHex(a: string, b: string, weight: number): string {
  const k = Math.max(0, Math.min(1, weight));
  const [r1, g1, b1] = parseHexRgb(a);
  const [r2, g2, b2] = parseHexRgb(b);
  return formatRgbHex([r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k]);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const bright = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (bright + 0.05) / (dark + 0.05);
}

export function deriveTokensFromTriplet(
  bg: string,
  text: string,
  accent: string,
  overrides: Partial<ThemeTokens> = {},
): ThemeTokens {
  const isLight = relativeLuminance(bg) > 0.45;
  const accentFg = relativeLuminance(accent) > 0.42 ? '#111111' : '#ffffff';
  const error = isLight ? '#c9353b' : '#f25f5c';
  const warning = isLight ? '#b87514' : '#f4a261';
  const success = isLight ? '#2b8a44' : '#43c567';
  const info = isLight ? '#256fb8' : '#56b4e9';
  const syntaxKeyword = accent;
  const syntaxString = isLight ? mixHex('#1f7a4c', accent, 0.2) : mixHex('#7ae582', accent, 0.2);
  const syntaxFunction = isLight ? mixHex('#235789', accent, 0.35) : mixHex('#72b5f8', accent, 0.35);
  const syntaxComment = mixHex(text, bg, 0.52);

  return {
    background: bg.toLowerCase(),
    backgroundPanel: mixHex(bg, text, isLight ? 0.045 : 0.055),
    backgroundElevated: mixHex(bg, text, isLight ? 0.085 : 0.1),
    foreground: text.toLowerCase(),
    foregroundMuted: mixHex(text, bg, 0.38),
    foregroundSubtle: mixHex(text, bg, 0.56),
    accent: accent.toLowerCase(),
    accentForeground: accentFg,
    border: mixHex(bg, text, isLight ? 0.18 : 0.16),
    borderFocused: accent.toLowerCase(),
    selection: mixHex(bg, accent, isLight ? 0.24 : 0.32),
    selectionForeground: text.toLowerCase(),
    cursor: accent.toLowerCase(),
    error,
    warning,
    success,
    info,
    diffAdded: isLight ? '#1f7a4c' : '#4fd6be',
    diffRemoved: isLight ? '#c53b53' : '#f26d78',
    diffContext: mixHex(text, bg, 0.44),
    syntaxKeyword: syntaxKeyword.toLowerCase(),
    syntaxString,
    syntaxComment,
    syntaxFunction,
    markdownHeading: accent.toLowerCase(),
    markdownCode: isLight ? '#1f6f50' : '#73daca',
    scrollbar: mixHex(bg, text, 0.26),
    composerBackground: mixHex(bg, text, isLight ? 0.06 : 0.075),
    sidebarBackground: mixHex(bg, text, isLight ? 0.035 : 0.04),
    overlayBackground: mixHex(bg, text, isLight ? 0.07 : 0.09),
    ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, v?.toLowerCase()])),
  };
}

function makePreset(input: {
  id: string;
  name: string;
  category: ThemeCategory;
  description: string;
  author: string;
  license: string;
  attribution: string;
  sourceFormat: 'futryn' | 'opencode' | 'claude-desktop';
  defaultMode: 'dark' | 'light';
  borderStyle?: BorderStyle;
  wallpaper?: string | null;
  greeting?: string;
  darkTriplet: [string, string, string];
  lightTriplet: [string, string, string];
  darkOverrides?: Partial<ThemeTokens>;
  lightOverrides?: Partial<ThemeTokens>;
}): ThemeManifest {
  return themeManifestSchema.parse({
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    category: input.category,
    description: input.description,
    author: input.author,
    license: input.license,
    attribution: input.attribution,
    sourceFormat: input.sourceFormat,
    builtIn: true,
    defaultMode: input.defaultMode,
    borderStyle: input.borderStyle ?? 'soft',
    wallpaper: input.wallpaper ?? null,
    greeting: input.greeting,
    dark: deriveTokensFromTriplet(
      input.darkTriplet[0],
      input.darkTriplet[1],
      input.darkTriplet[2],
      input.darkOverrides,
    ),
    light: deriveTokensFromTriplet(
      input.lightTriplet[0],
      input.lightTriplet[1],
      input.lightTriplet[2],
      input.lightOverrides,
    ),
  });
}

/** COSMEW dark/light surfaces with semantic color, exposed as Auto, Dark and Light. */
const SYSTEM_THEME: ThemeManifest = makePreset({
  id: 'auto',
  name: 'COSMEW Default',
  category: 'featured',
  description: 'Dark or light surfaces with accessible semantic colors',
  author: 'COSMEW Team',
  license: 'MIT',
  attribution: 'COSMEW terminal palette',
  sourceFormat: 'futryn',
  defaultMode: 'dark',
  borderStyle: 'soft',
  greeting: 'Quiet desk. Clear answers.',
  darkTriplet: ['#000000', '#f4f4f4', '#f4f4f4'],
  lightTriplet: ['#ffffff', '#111111', '#111111'],
  darkOverrides: {
    background: '#000000',
    backgroundPanel: '#262626',
    backgroundElevated: '#161616',
    composerBackground: '#353940',
    sidebarBackground: '#000000',
    overlayBackground: '#0c0c0c',
    foreground: '#ffffff',
    foregroundMuted: '#a9abae',
    foregroundSubtle: '#a9abae',
    accent: '#d7a38d',
    accentForeground: '#000000',
    border: '#81a2be',
    borderFocused: '#81a2be',
    selection: '#2a2a2a',
    selectionForeground: '#ffffff',
    cursor: '#d7a38d',
    error: '#d8a7af',
    warning: '#dfc290',
    success: '#a7c9ab',
    info: '#afb8d4',
    diffAdded: '#a3c7aa',
    diffRemoved: '#d8a7af',
    diffContext: '#a9abae',
    syntaxKeyword: '#c0afd1',
    syntaxString: '#acc6a7',
    syntaxFunction: '#98c3cf',
    syntaxComment: '#999999',
    markdownHeading: '#d7a38d',
    markdownCode: '#acc6a7',
    scrollbar: '#3a3a3a',
  },
  lightOverrides: {
    background: '#ffffff',
    backgroundPanel: '#f5f5f5',
    backgroundElevated: '#f0f0f0',
    composerBackground: '#f2f3f3',
    sidebarBackground: '#ffffff',
    overlayBackground: '#fafafa',
    foreground: '#2e3434',
    foregroundMuted: '#6e7171',
    foregroundSubtle: '#6e7171',
    accent: '#995b49',
    accentForeground: '#ffffff',
    border: '#3465a4',
    borderFocused: '#3465a4',
    selection: '#eeeeee',
    selectionForeground: '#2e3434',
    cursor: '#995b49',
    error: '#89515a',
    warning: '#795e37',
    success: '#42694e',
    info: '#526486',
    diffAdded: '#42694e',
    diffRemoved: '#89515a',
    diffContext: '#6e7171',
    syntaxKeyword: '#6c557a',
    syntaxString: '#49684d',
    syntaxFunction: '#3d6875',
    syntaxComment: '#666666',
    markdownHeading: '#995b49',
    markdownCode: '#49684d',
    scrollbar: '#d4d4d4',
  },
});

/** Intent-based accessible / ANSI approximations; measured Claude colours: Needs verification. */
/** 16-colour themes keep the blue/orange change markers of the former colorblind-friendly variants. */
const EXTRA_THEMES = ['dark-ansi', 'light-ansi'].map(id => {
  const mode = id.startsWith('light') ? 'light' : 'dark';
  const tokens = {...SYSTEM_THEME[mode]};
  Object.assign(
    tokens,
    mode === 'dark'
      ? {success: '#56b4e9', diffAdded: '#56b4e9', error: '#e69f00', diffRemoved: '#e69f00'}
      : {success: '#0072b2', diffAdded: '#0072b2', error: '#a65f00', diffRemoved: '#a65f00'},
  );
  {
    const colors = [
      '#000000',
      '#800000',
      '#008000',
      '#808000',
      '#000080',
      '#800080',
      '#008080',
      '#c0c0c0',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#0000ff',
      '#ff00ff',
      '#00ffff',
      '#ffffff',
    ];
    for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
      const rgb = parseHexRgb(tokens[key]);
      tokens[key] = colors.reduce((best, color) => {
        const distance = (hex: string) =>
          parseHexRgb(hex).reduce((sum, channel, at) => sum + (channel - rgb[at]!) ** 2, 0);
        return distance(color) < distance(best) ? color : best;
      });
    }
    // Nearest RGB alone collapses several distinct text roles to the same gray.
    Object.assign(
      tokens,
      mode === 'dark'
        ? {
            info: '#00ffff',
            markdownHeading: '#ffff00',
            markdownCode: '#00ff00',
            syntaxKeyword: '#ff00ff',
            syntaxString: '#00ff00',
            syntaxFunction: '#00ffff',
          }
        : {
            info: '#000080',
            markdownHeading: '#800000',
            markdownCode: '#008000',
            syntaxKeyword: '#800080',
            syntaxString: '#008000',
            syntaxComment: '#000080',
            syntaxFunction: '#008080',
          },
    );
  }
  return {
    ...SYSTEM_THEME,
    id,
    name: `${mode === 'light' ? 'Light' : 'Dark'} (ANSI)`,
    description: 'Standard 16-color ANSI palette approximation',
    defaultMode: mode,
    dark: tokens,
    light: tokens,
  } as ThemeManifest;
});

const GITHUB_THEMES: readonly ThemeManifest[] = GITHUB_THEME_IDS.map(id => {
  const palette = GITHUB_PALETTES[id];
  return themeManifestSchema.parse({
    schemaVersion: 1,
    id,
    name: palette.name,
    category: 'featured',
    description: `GitHub ${palette.name.toLowerCase()} palette`,
    author: 'GitHub Primer',
    license: 'MIT',
    attribution: `${PRIMER_SOURCE.package} ${PRIMER_SOURCE.version} (accessed ${PRIMER_SOURCE.accessed})`,
    sourceFormat: 'futryn',
    builtIn: true,
    defaultMode: palette.mode,
    borderStyle: 'soft',
    wallpaper: null,
    dark: palette.tokens,
    light: palette.tokens,
  });
});

export const BUILTIN_COLOR_THEMES: readonly ThemeManifest[] = [
  {...SYSTEM_THEME, name: 'Auto', description: 'Follow the terminal background (dark fallback)'},
  {...SYSTEM_THEME, id: 'dark', name: 'Dark', description: 'Dark background, light text'},
  {...SYSTEM_THEME, id: 'light', name: 'Light', description: 'Light background, dark text', defaultMode: 'light'},
  ...EXTRA_THEMES,
  ...GITHUB_THEMES,
];
export const BUILTIN_LIVE_THEMES: readonly ThemeManifest[] = [];
export const ALL_BUILTIN_THEMES: readonly ThemeManifest[] = BUILTIN_COLOR_THEMES;
