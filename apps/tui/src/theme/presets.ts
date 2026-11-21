import {
  themeManifestSchema,
  type BorderStyle,
  type ThemeCategory,
  type ThemeManifest,
  type ThemeTokens,
} from '@cosmew/contracts';

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
    accent: '#d77757',
    accentForeground: '#000000',
    border: '#81a2be',
    borderFocused: '#81a2be',
    selection: '#2a2a2a',
    selectionForeground: '#ffffff',
    cursor: '#d77757',
    error: '#ff6b80',
    warning: '#ffc107',
    success: '#4eba65',
    info: '#b1b9f9',
    diffAdded: '#50c850',
    diffRemoved: '#ff6b80',
    diffContext: '#a9abae',
    syntaxKeyword: '#c5a5ff',
    syntaxString: '#9ed49c',
    syntaxFunction: '#82c7f7',
    syntaxComment: '#999999',
    markdownHeading: '#d77757',
    markdownCode: '#9ed49c',
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
    accent: '#d77757',
    accentForeground: '#ffffff',
    border: '#3465a4',
    borderFocused: '#3465a4',
    selection: '#eeeeee',
    selectionForeground: '#2e3434',
    cursor: '#d77757',
    error: '#b42318',
    warning: '#8e7700',
    success: '#176334',
    info: '#5769f7',
    diffAdded: '#248a3d',
    diffRemoved: '#cf222e',
    diffContext: '#6e7171',
    syntaxKeyword: '#7145a0',
    syntaxString: '#286b3c',
    syntaxFunction: '#135d95',
    syntaxComment: '#666666',
    markdownHeading: '#d77757',
    markdownCode: '#286b3c',
    scrollbar: '#d4d4d4',
  },
});

/** Intent-based accessible / ANSI approximations; measured Claude colours: Needs verification. */
const EXTRA_THEMES = ['dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'].map(id => {
  const mode = id.startsWith('light') ? 'light' : 'dark';
  const ansi = id.endsWith('ansi');
  const tokens = {...SYSTEM_THEME[mode]};
  Object.assign(
    tokens,
    mode === 'dark'
      ? {success: '#56b4e9', diffAdded: '#56b4e9', error: '#e69f00', diffRemoved: '#e69f00'}
      : {success: '#0072b2', diffAdded: '#0072b2', error: '#a65f00', diffRemoved: '#a65f00'},
  );
  if (ansi) {
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
  }
  return {
    ...SYSTEM_THEME,
    id,
    name: `${mode === 'light' ? 'Light' : 'Dark'} (${ansi ? 'ANSI' : 'colorblind-friendly'})`,
    description: ansi
      ? 'Standard 16-color ANSI palette approximation'
      : 'Blue/orange differences for red-green color blindness',
    defaultMode: mode,
    dark: tokens,
    light: tokens,
  } as ThemeManifest;
});

export const BUILTIN_COLOR_THEMES: readonly ThemeManifest[] = [
  {...SYSTEM_THEME, name: 'Auto', description: 'Follow the terminal background (dark fallback)'},
  {...SYSTEM_THEME, id: 'dark', name: 'Dark', description: 'Dark background, light text'},
  {...SYSTEM_THEME, id: 'light', name: 'Light', description: 'Light background, dark text', defaultMode: 'light'},
  ...EXTRA_THEMES,
];
export const BUILTIN_LIVE_THEMES: readonly ThemeManifest[] = [];
export const ALL_BUILTIN_THEMES: readonly ThemeManifest[] = BUILTIN_COLOR_THEMES;
