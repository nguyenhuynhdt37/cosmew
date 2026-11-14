import {
  themeManifestSchema,
  type BorderStyle,
  type ThemeCategory,
  type ThemeManifest,
  type ThemeTokens,
} from '@hannes/contracts';

export function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
}

export function formatRgbHex([r, g, b]: [number, number, number]): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
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
    dark: deriveTokensFromTriplet(input.darkTriplet[0], input.darkTriplet[1], input.darkTriplet[2], input.darkOverrides),
    light: deriveTokensFromTriplet(input.lightTriplet[0], input.lightTriplet[1], input.lightTriplet[2], input.lightOverrides),
  });
}

/**
 * 15 Built-in Color Themes:
 * - 5 adapted from 0toshigami/claude-desktop-themes (Sunset Cloud, Sakura, Terminal, Night Sea, Old Paper)
 * - 10 established terminal color schemes (FUTRYN Default, OpenCode, Catppuccin, Tokyo Night, Dracula, Nord, Gruvbox, Rose Pine, Kanagawa, One Dark)
 */
export const BUILTIN_COLOR_THEMES: readonly ThemeManifest[] = [
  // 1. FUTRYN Default — monochrome, follows the terminal light/dark preference.
  makePreset({
    id: 'futryn-default',
    name: 'FUTRYN Default',
    category: 'featured',
    description: 'Black and white. Ink on the terminal background, paper on the terminal foreground',
    author: 'FUTRYN Team',
    license: 'MIT',
    attribution: 'FUTRYN monochrome terminal palette',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    borderStyle: 'soft',
    greeting: 'Quiet desk. Clear answers.',
    darkTriplet: ['#000000', '#f4f4f4', '#f4f4f4'],
    lightTriplet: ['#ffffff', '#111111', '#111111'],
    darkOverrides: {
      background: '#000000',
      backgroundPanel: '#0a0a0a',
      backgroundElevated: '#161616',
      composerBackground: '#0a0a0a',
      sidebarBackground: '#000000',
      overlayBackground: '#0c0c0c',
      foreground: '#f4f4f4',
      foregroundMuted: '#a3a3a3',
      foregroundSubtle: '#8a8a8a',
      accent: '#f4f4f4',
      accentForeground: '#0a0a0a',
      border: '#2e2e2e',
      borderFocused: '#f4f4f4',
      selection: '#2a2a2a',
      selectionForeground: '#f4f4f4',
      cursor: '#f4f4f4',
      error: '#f4f4f4',
      warning: '#d4d4d4',
      success: '#f4f4f4',
      info: '#d4d4d4',
      diffAdded: '#f4f4f4',
      diffRemoved: '#8a8a8a',
      diffContext: '#a3a3a3',
      syntaxKeyword: '#f4f4f4',
      syntaxString: '#d4d4d4',
      syntaxFunction: '#f4f4f4',
      syntaxComment: '#8a8a8a',
      markdownHeading: '#f4f4f4',
      markdownCode: '#d4d4d4',
      scrollbar: '#3a3a3a',
    },
    lightOverrides: {
      background: '#ffffff',
      backgroundPanel: '#fafafa',
      backgroundElevated: '#f0f0f0',
      composerBackground: '#ffffff',
      sidebarBackground: '#ffffff',
      overlayBackground: '#fafafa',
      foreground: '#111111',
      foregroundMuted: '#525252',
      foregroundSubtle: '#737373',
      accent: '#111111',
      accentForeground: '#ffffff',
      border: '#e4e4e4',
      borderFocused: '#111111',
      selection: '#eeeeee',
      selectionForeground: '#111111',
      cursor: '#111111',
      error: '#111111',
      warning: '#3a3a3a',
      success: '#111111',
      info: '#3a3a3a',
      diffAdded: '#111111',
      diffRemoved: '#737373',
      diffContext: '#525252',
      syntaxKeyword: '#111111',
      syntaxString: '#3a3a3a',
      syntaxFunction: '#111111',
      syntaxComment: '#737373',
      markdownHeading: '#111111',
      markdownCode: '#3a3a3a',
      scrollbar: '#d4d4d4',
    },
  }),

  // 2. Sunset Cloud (Claude Desktop Themes #1 - Featured)
  makePreset({
    id: 'sunset-cloud',
    name: 'Sunset Cloud',
    category: 'featured',
    description: 'A violet dusk, slow clouds, a coral glow rising from the horizon',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    borderStyle: 'soft',
    greeting: 'good evening — Dusk settles in',
    darkTriplet: ['#2b2030', '#f7e8e2', '#ff8a6b'],
    lightTriplet: ['#fbf0ed', '#36243d', '#d96243'],
  }),

  // 3. Sakura (Claude Desktop Themes #2 - Featured)
  makePreset({
    id: 'sakura',
    name: 'Sakura',
    category: 'featured',
    description: 'Falling cherry blossom petals, soft blush surfaces, and warm plum ink',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'light',
    borderStyle: 'soft',
    wallpaper: 'sakura-dusk',
    greeting: 'Spring is here — petals in the breeze',
    darkTriplet: ['#261720', '#fce8ee', '#f07199'],
    lightTriplet: ['#fff4f6', '#4b2a35', '#e0567f'],
  }),

  // 4. Terminal (Claude Desktop Themes #3 - Featured)
  makePreset({
    id: 'terminal',
    name: 'Terminal',
    category: 'featured',
    description: 'A green phosphor CRT tube: scanline contrast, glowing text, and sharp square corners',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    borderStyle: 'sharp',
    greeting: '> boot futryn.sys ... ok',
    darkTriplet: ['#0a110c', '#b9f6c6', '#39e87a'],
    lightTriplet: ['#e9f7ed', '#0b2914', '#169c49'],
    darkOverrides: {
      composerBackground: '#050a06',
      backgroundPanel: '#0d1710',
      border: '#1c4d2c',
      borderFocused: '#39e87a',
      syntaxKeyword: '#39e87a',
      syntaxString: '#80ffaa',
      syntaxFunction: '#52ffa8',
    },
  }),

  // 5. Night Sea (Claude Desktop Themes #4 - Featured)
  makePreset({
    id: 'night-sea',
    name: 'Night Sea',
    category: 'featured',
    description: 'Stars over a slow ocean wave, crafted for long nights of deep code',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    borderStyle: 'soft',
    greeting: ' ~  calm seas ahead',
    darkTriplet: ['#0f1a2c', '#dce6fa', '#5aaeff'],
    lightTriplet: ['#eef4fc', '#14243d', '#2678c9'],
  }),

  // 6. Old Paper (Claude Desktop Themes #5 - Featured)
  makePreset({
    id: 'old-paper',
    name: 'Old Paper',
    category: 'featured',
    description: 'Ivory grain, browned edges, and warm terracotta ink like an archival folio',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'light',
    borderStyle: 'double',
    greeting: '— Ex Libris · FUTRYN —',
    darkTriplet: ['#262019', '#ede2ce', '#d47a4e'],
    lightTriplet: ['#f2e9d6', '#3a2f22', '#a5522c'],
  }),

  // 7. OpenCode Neutral Default
  makePreset({
    id: 'opencode',
    name: 'OpenCode Neutral',
    category: 'colors',
    description: 'OpenCode-inspired balanced monochrome step ramp with warm amber and blue highlights',
    author: 'anomalyco/opencode (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from anomalyco/opencode packages/tui/src/theme/assets/opencode.json (MIT)',
    sourceFormat: 'opencode',
    defaultMode: 'dark',
    borderStyle: 'soft',
    darkTriplet: ['#0a0a0a', '#eeeeee', '#fab283'],
    lightTriplet: ['#ffffff', '#1a1a1a', '#3b7dd8'],
    darkOverrides: {
      backgroundPanel: '#141414',
      backgroundElevated: '#1e1e1e',
      foregroundMuted: '#808080',
      border: '#484848',
      borderFocused: '#606060',
      error: '#e06c75',
      warning: '#f5a742',
      success: '#7fd88f',
      info: '#56b6c2',
      diffAdded: '#4fd6be',
      diffRemoved: '#c53b53',
      diffContext: '#828bb8',
      syntaxKeyword: '#9d7cd8',
      syntaxFunction: '#fab283',
      syntaxString: '#7fd88f',
      syntaxComment: '#808080',
    },
    lightOverrides: {
      backgroundPanel: '#fafafa',
      backgroundElevated: '#f5f5f5',
      foregroundMuted: '#8a8a8a',
      border: '#b8b8b8',
      borderFocused: '#a0a0a0',
      error: '#d1383d',
      warning: '#d68c27',
      success: '#3d9a57',
      info: '#318795',
    },
  }),

  // 8. Catppuccin
  makePreset({
    id: 'catppuccin',
    name: 'Catppuccin',
    category: 'colors',
    description: 'Soothing pastel theme with Mocha dark and Latte light variants',
    author: 'Catppuccin Org',
    license: 'MIT',
    attribution: 'Adapted from Catppuccin Mocha / Latte palette (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#1e1e2e', '#cdd6f4', '#cba6f7'],
    lightTriplet: ['#eff1f5', '#4c4f69', '#8839ef'],
  }),

  // 9. Tokyo Night
  makePreset({
    id: 'tokyo-night',
    name: 'Tokyo Night',
    category: 'colors',
    description: 'Clean dark indigo palette celebrating the neon lights of downtown Tokyo',
    author: 'Enkia / Tokyo Night',
    license: 'MIT',
    attribution: 'Adapted from Tokyo Night color scheme (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#1a1b26', '#c0caf5', '#7aa2f7'],
    lightTriplet: ['#e1e2e7', '#3760bf', '#2e7de9'],
  }),

  // 10. Dracula
  makePreset({
    id: 'dracula',
    name: 'Dracula',
    category: 'colors',
    description: 'High-contrast gothic purple and vibrant pink/cyan syntax accents',
    author: 'Zeno Rocha / Dracula Theme',
    license: 'MIT',
    attribution: 'Adapted from Dracula Official Palette (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#282a36', '#f8f8f2', '#ff79c6'],
    lightTriplet: ['#f8f8f2', '#282a36', '#d63384'],
  }),

  // 11. Nord
  makePreset({
    id: 'nord',
    name: 'Nord',
    category: 'colors',
    description: 'Arctic, north-bluish clean palette for distraction-free focus',
    author: 'Arctic Ice Studio',
    license: 'MIT',
    attribution: 'Adapted from Nord Palette (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#2e3440', '#eceff4', '#88c0d0'],
    lightTriplet: ['#eceff4', '#2e3440', '#5e81ac'],
  }),

  // 12. Gruvbox
  makePreset({
    id: 'gruvbox',
    name: 'Gruvbox',
    category: 'colors',
    description: 'Retro groove warm earthy dark and light contrast',
    author: 'Pavel Pertsev / Gruvbox',
    license: 'MIT',
    attribution: 'Adapted from Gruvbox color scheme (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#282828', '#ebdbb2', '#fe8019'],
    lightTriplet: ['#fbf1c7', '#3c3836', '#d65d0e'],
  }),

  // 13. Rose Pine
  makePreset({
    id: 'rose-pine',
    name: 'Rose Pine',
    category: 'colors',
    description: 'All natural pine, faux fur and a bit of soho vibes',
    author: 'Rosé Pine',
    license: 'MIT',
    attribution: 'Adapted from Rosé Pine / Dawn palette (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#191724', '#e0def4', '#ebbcba'],
    lightTriplet: ['#faf4ed', '#575279', '#d7827e'],
  }),

  // 14. Kanagawa
  makePreset({
    id: 'kanagawa',
    name: 'Kanagawa',
    category: 'colors',
    description: 'Inspired by Hokusai’s Great Wave off Kanagawa with sumi ink and wave blue',
    author: 'rebelot / Kanagawa',
    license: 'MIT',
    attribution: 'Adapted from Kanagawa Wave / Lotus palette (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#1f1f28', '#dcd7ba', '#7e9cd8'],
    lightTriplet: ['#f2ecbc', '#545464', '#4d699b'],
  }),

  // 15. One Dark
  makePreset({
    id: 'one-dark',
    name: 'One Dark',
    category: 'colors',
    description: 'Classic balanced slate dark and crisp syntax palette',
    author: 'Atom / One Dark',
    license: 'MIT',
    attribution: 'Adapted from Atom One Dark / One Light (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    darkTriplet: ['#282c34', '#abb2bf', '#61afef'],
    lightTriplet: ['#fafafa', '#383a42', '#4078f2'],
  }),
];

/**
 * 12 Live Wallpaper Themes matching the 12 animated ASCII scenes,
 * selectable from the "Live" tab in `/themes` or paired with any color theme.
 */
export const BUILTIN_LIVE_THEMES: readonly ThemeManifest[] = [
  makePreset({
    id: 'moonlit',
    name: 'Moonlit',
    category: 'live',
    description: 'A crescent moon, drifting clouds, shooting meteors, and twinkling stars',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'moonlit',
    greeting: 'a quiet night to build ☾',
    darkTriplet: ['#0d1530', '#dbe2f5', '#d9c98f'],
    lightTriplet: ['#e8eefc', '#182447', '#9c8333'],
  }),
  makePreset({
    id: 'futryn-spark',
    name: 'FUTRYN Spark',
    category: 'live',
    description: 'A turning amber-orange spark, drifting embers, and the FUTRYN sentinel on patrol',
    author: 'FUTRYN Team (inspired by 0toshigami)',
    license: 'MIT',
    attribution: 'Inspired by 0toshigami/claude-desktop-themes with FUTRYN original art (MIT)',
    sourceFormat: 'futryn',
    defaultMode: 'dark',
    wallpaper: 'futryn-spark',
    greeting: 'what shall we spark today?',
    darkTriplet: ['#1f1714', '#f2e6df', '#d97757'],
    lightTriplet: ['#faeee8', '#33211b', '#c45b39'],
  }),
  makePreset({
    id: 'cloud-drift',
    name: 'Cloud Drift',
    category: 'live',
    description: 'White cumulus clouds drifting across a bright sky with gliding birds',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'light',
    wallpaper: 'cloud-drift',
    greeting: 'blue skies ahead',
    darkTriplet: ['#122638', '#d8ecfa', '#55a6f0'],
    lightTriplet: ['#d8ecfa', '#1d3447', '#2f78bd'],
  }),
  makePreset({
    id: 'honu-lagoon',
    name: 'Honu Lagoon',
    category: 'live',
    description: 'A sea turtle swimming across a coral lagoon with reef fish, swaying kelp, and bubbles',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'honu-lagoon',
    greeting: 'swim along, slow and steady',
    darkTriplet: ['#0f3a44', '#e3f6f2', '#5fd0b8'],
    lightTriplet: ['#e3f7f4', '#0f3a44', '#1a8f78'],
  }),
  makePreset({
    id: 'koi-pond',
    name: 'Koi Pond',
    category: 'live',
    description: 'Koi carp circling a pond between lily pads, lotus blossoms, and expanding water rings',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'koi-pond',
    greeting: 'still water, clear mind',
    darkTriplet: ['#11332d', '#e4f2ea', '#ef8a4a'],
    lightTriplet: ['#e6f5ef', '#12362f', '#cf6727'],
  }),
  makePreset({
    id: 'jellyfish',
    name: 'Jellyfish',
    category: 'live',
    description: 'Bioluminescent jellyfish rising through deep water with pulsing bells',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'jellyfish',
    greeting: 'drifting into deep work',
    darkTriplet: ['#0a1830', '#dfe7fb', '#a58cf0'],
    lightTriplet: ['#edf1fc', '#122447', '#6f52c9'],
  }),
  makePreset({
    id: 'lantern-night',
    name: 'Lantern Night',
    category: 'live',
    description: 'Warm paper lanterns drifting down a river at night with shimmering water reflections',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'lantern-night',
    greeting: 'let your ideas drift',
    darkTriplet: ['#0b1424', '#efe6d2', '#f2a541'],
    lightTriplet: ['#f7f0e1', '#1a2436', '#c47816'],
  }),
  makePreset({
    id: 'fireflies',
    name: 'Fireflies',
    category: 'live',
    description: 'Fireflies wandering and blinking warmly over swaying tall meadow grass',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'fireflies',
    greeting: 'a warm glow for late work',
    darkTriplet: ['#0b130e', '#e3eedc', '#d8e86a'],
    lightTriplet: ['#eef5e9', '#16261b', '#6c8715'],
  }),
  makePreset({
    id: 'neon-rain',
    name: 'Neon Rain',
    category: 'live',
    description: 'Rain over a city skyline at night, buzzing neon signs, umbrellas passing by, and distant lightning',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'neon-rain',
    greeting: 'rain outside, code inside',
    darkTriplet: ['#0c1020', '#e3e8f6', '#ff5fa2'],
    lightTriplet: ['#eef0fa', '#171d36', '#d6337c'],
  }),
  makePreset({
    id: 'sakura-dusk',
    name: 'Sakura Dusk',
    category: 'live',
    description: 'Cherry branches at the corners, petals tumbling through a violet evening over a low sun',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'sakura-dusk',
    greeting: 'petals at dusk',
    darkTriplet: ['#231a2e', '#f6e9f0', '#f29bb8'],
    lightTriplet: ['#fcf0f5', '#322242', '#c95980'],
  }),
  makePreset({
    id: 'snow-cabin',
    name: 'Snow Cabin',
    category: 'live',
    description: 'A log cabin under snowy mountain peaks, warm lit windows, chimney smoke, and swaying pines',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'snow-cabin',
    greeting: 'warm inside, snow outside',
    darkTriplet: ['#0e1628', '#e6edf8', '#ffb85c'],
    lightTriplet: ['#edf2fa', '#16233d', '#c97b18'],
  }),
  makePreset({
    id: 'star-voyage',
    name: 'Star Voyage',
    category: 'live',
    description: 'A little rocket with a flickering flame passing a ringed planet, orbiting moon, and shooting stars',
    author: '0toshigami (adapted for FUTRYN)',
    license: 'MIT',
    attribution: 'Adapted from 0toshigami/claude-desktop-themes (MIT)',
    sourceFormat: 'claude-desktop',
    defaultMode: 'dark',
    wallpaper: 'star-voyage',
    greeting: 'ready for liftoff?',
    darkTriplet: ['#0d0a1f', '#e6ecff', '#ff6fb5'],
    lightTriplet: ['#f0eeff', '#1b143b', '#d13d87'],
  }),
];

export const ALL_BUILTIN_THEMES: readonly ThemeManifest[] = [
  ...BUILTIN_COLOR_THEMES,
  ...BUILTIN_LIVE_THEMES,
];
