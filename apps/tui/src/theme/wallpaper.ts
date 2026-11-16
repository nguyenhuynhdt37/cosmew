import {WALLPAPER_PRESET_IDS, type AnimationConfig, type WallpaperPresetId} from '@futryn/contracts';
import {formatRgbHex, mixHex, parseHexRgb} from './presets';

export interface SceneCell {
  ch: string;
  fg: string;
  bg?: string;
  alpha: number;
  floor?: number;
}

export interface PaletteTile {
  bg?: string;
  fg: string;
  a: number;
  ch?: string;
}

export interface SceneSprite {
  x: number;
  y: number;
  key: number;
  art?: string[];
  pal?: Record<string, PaletteTile>;
  w?: number;
  h?: number;
  field?: (gx: number, gy: number) => {c: PaletteTile; sx?: number; sy?: number} | undefined;
  a?: number;
  shadow?: string | boolean;
  halo?: string;
  glow?: {r: number; color: string; a: number};
}

export interface WallpaperSceneDefinition {
  id: WallpaperPresetId;
  name: string;
  tagline: string;
  defaultBg: string;
  defaultFg: string;
  defaultAccent: string;
  cell?: (
    x: number,
    y: number,
    cols: number,
    rows: number,
    t: number,
    eventKind?: string,
  ) => (Omit<SceneCell, 'ch'> & {ch?: string}) | undefined;
  sprites?: (cols: number, rows: number, t: number, eventKind?: string) => SceneSprite[];
}

const GLYPHS = 'St%;:X';
const LOOSE = ".:',o";
const SMOOTH_SHADES = [' ', '░', '▒', '▓', '█'];

export function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function glyph(set: string, x: number, y: number, t: number): string {
  const idx = Math.floor(hash(x, y, Math.floor(t * 1.2 + hash(y, x) * 7)) * set.length);
  return set[idx] ?? set[0] ?? '.';
}

export function ell(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
}

export function drift(cols: number, f: number, t: number, v: number, w: number): number {
  const span = cols + w * 2;
  return ((((f * span + t * v) % span) + span) % span) - w;
}

export function near(x: number, y: number, fg: string, a = 0.3, odds = 0.5): PaletteTile | undefined {
  return hash(x, y, 3) < odds ? {fg, a} : undefined;
}

export function twinkle(x: number, y: number, t: number, fg: string, odds: number): PaletteTile | undefined {
  const s = hash(x, y, 9);
  if (s < odds) {
    return {
      ch: s < odds / 3 ? '+' : '.',
      fg,
      a: 0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t * (1 + s * 200) + s * 1000)),
    };
  }
  return undefined;
}

export function rising(x: number, y: number, t: number, v: number, odds: number): boolean {
  return hash(x, Math.floor(y + t * v), 11) < odds;
}

export function sketch(w: number, h: number, parts: [number, number, string][]): string[] {
  const g = Array.from({length: h}, () => Array<string>(w).fill('.'));
  for (const [r, c, s] of parts) {
    [...s].forEach((ch, i) => {
      if (ch !== ' ' && g[r]?.[c + i] !== undefined) g[r]![c + i] = ch;
    });
  }
  return g.map(r => r.join(''));
}

export function shape(w: number, h: number, at: (x: number, y: number) => string): string[] {
  return Array.from({length: h}, (_, y) => Array.from({length: w}, (_, x) => at(x, y)).join(''));
}

export function flip(art: string[]): string[] {
  return art.map(r => [...r].reverse().join(''));
}

export function frame<T>(frames: readonly T[], t: number, rate: number, phase = 0): T {
  const idx = Math.floor(Math.max(0, t * rate + phase)) % frames.length;
  return frames[idx]!;
}

export function shade(c: string, k: number): string {
  const target = k > 0 ? '#ffffff' : '#000000';
  return mixHex(c, target, Math.min(1, Math.abs(k)));
}

export function tint(bg: string, fg: string, alphas: number[]): Record<string, PaletteTile> {
  return Object.fromEntries(alphas.map((a, i) => [String(i + 1), {bg, fg, a}]));
}

const haloCache = new WeakMap<string[], [number, number][]>();
export function haloOf(art: string[]): [number, number][] {
  const cached = haloCache.get(art);
  if (cached) return cached;
  const on = (x: number, y: number) => (art[y]?.[x] ?? '.') !== '.';
  const out: [number, number][] = [];
  const width = art[0]?.length ?? 0;
  for (let y = -1; y <= art.length; y++) {
    for (let x = -1; x <= width; x++) {
      if (!on(x, y) && [-1, 0, 1].some(i => [-1, 0, 1].some(j => on(x + i, y + j))) && hash(x + 50, y + 50, 5) < 0.45) {
        out.push([x, y]);
      }
    }
  }
  haloCache.set(art, out);
  return out;
}

// ============================================================================
// 1. MOONLIT SCENE
// ============================================================================
const moonlitClouds = new Map<number, string[]>();
function moonlitCloudArt(w: number): string[] {
  if (!moonlitClouds.has(w)) {
    const cx = w / 2;
    const inside = (x: number, y: number) =>
      Math.min(ell(x, y, cx, 3, w / 2, 1.6), ell(x, y, cx + w * 0.1, 1.4, w * 0.28, 1.2)) <= 1;
    moonlitClouds.set(
      w,
      shape(w + 1, 6, (x, y) => (inside(x, y) ? String(1 + Math.min(3, Math.floor((4 * x) / (w + 1)))) : '.')),
    );
  }
  return moonlitClouds.get(w)!;
}
const METEOR = sketch(8, 4, [
  [0, 0, '11'],
  [1, 2, '22'],
  [2, 4, '33'],
  [3, 6, '4H'],
]);
const METEORS = [METEOR, flip(METEOR)];
const meteorPal = (ch: string): Record<string, PaletteTile> => ({
  H: {bg: '#fff6d0', fg: '#3a3524', a: 1},
  4: {ch, fg: '#fff6d0', a: 0.85},
  3: {ch, fg: '#fff6d0', a: 0.6},
  2: {ch, fg: '#dbe2f5', a: 0.4},
  1: {ch, fg: '#dbe2f5', a: 0.2},
});
const METEOR_PALS = [meteorPal('\\'), meteorPal('/')];
const MOONLIT_CLOUDS: [number, number, number, number][] = [
  [0.08, 0.14, 24, 0.6],
  [0.55, 0.36, 20, 0.45],
  [0.3, 0.6, 22, 0.5],
  [0.85, 0.8, 16, 0.7],
];
const MOONLIT_NIGHT = tint('#7088d8', '#18214a', [0.35, 0.5, 0.65, 0.82]);

// ============================================================================
// 2. FUTRYN SPARK SCENE (Original FUTRYN branding/sentinel, inspired by clawd)
// ============================================================================
const FUTRYN_BOT_BASE = ['.==###==.', '.#o#F#o#.', '#########', '.#######.'];
const FUTRYN_BOT_FRAMES = [
  [...FUTRYN_BOT_BASE, '.#.#.#.#.'],
  [...FUTRYN_BOT_BASE, '#.#.#.#..'],
];
const FUTRYN_BOT_PAL: Record<string, PaletteTile> = {
  '#': {bg: '#d97757', fg: '#3b1d12', a: 0.95},
  '=': {bg: '#f0883e', fg: '#2a1208', a: 0.95},
  o: {bg: '#2a1a14', fg: '#ffbe85', a: 0.95, ch: 'o'},
  F: {bg: '#2a1a14', fg: '#ffffff', a: 0.98, ch: 'F'},
};

// ============================================================================
// 3. CLOUD DRIFT SCENE
// ============================================================================
const BIRDS = [['v'], ['^']];
const BIRD_PAL: Record<string, PaletteTile> = {
  v: {ch: 'v', fg: '#3f6280', a: 0.8},
  '^': {ch: '^', fg: '#3f6280', a: 0.8},
};
const FLOCK: [number, number][] = [
  [0, 0],
  [2, -1],
  [4, 0],
  [1.5, 1.5],
];
const daySkies = new Map<number, string[]>();
function skyArt(seed: number): string[] {
  if (!daySkies.has(seed)) {
    const r = (j: number) => hash(seed, j, 3);
    const kind = seed % 4;
    const configs: [number, number, number, number][] = [
      [3 + Math.floor(r(2) * 2), 2.2, 3.8, 1],
      [5 + Math.floor(r(2) * 2), 1.1, 1.8, 1],
      [2, 1.5, 2.2, 1],
      [3, 2.4, 4.6, 2],
    ];
    const [n, R0, R1, base] = configs[kind]!;
    const domes: [number, number][] = [];
    for (let i = 0, cx = 0; i < n; i++) {
      const mid = 1 - Math.abs(i - (n - 1) / 2) / Math.max(1, (n - 1) / 2);
      const R = R0 + (R1 - R0) * (kind === 3 ? mid ** 2 : mid * 0.6 + r(10 + i) * 0.4);
      cx = i ? cx + R * 0.95 : R;
      domes.push([cx, R]);
      cx += R * 0.45;
    }
    const lastDome = domes[n - 1]!;
    const firstDome = domes[0]!;
    const W = lastDome[0] + lastDome[1];
    const lift = (x: number) =>
      Math.max(0, ...domes.map(([cx, R]) => (Math.abs(x - cx) < R ? Math.sqrt(R * R - (x - cx) ** 2) * 0.75 : 0)));
    const H = Math.ceil(Math.max(...domes.map(d => d[1])) * 0.75 + base);
    daySkies.set(
      seed,
      shape(Math.ceil(W) + 1, H, (x, y) => {
        const up = H - 1 - y;
        const h = Math.ceil(base + lift(x + 0.5) - 0.35);
        const end = x + 0.5 < firstDome[0] - firstDome[1] * 0.7 || x + 0.5 > lastDome[0] + lastDome[1] * 0.7;
        if (up >= h || (end && up >= base) || (up === h - 1 && h > 2 && hash(seed * 7 + x, 1, 4) < 0.25)) return '.';
        return String(1 + Math.min(3, Math.floor((4 * up) / H)));
      }),
    );
  }
  return daySkies.get(seed)!;
}
const DAY_TOPS: Record<string, PaletteTile> = {
  4: {bg: '#ffffff', fg: '#9db3c6', a: 0.96},
  3: {bg: '#f2f6fa', fg: '#93a9bd', a: 0.93},
  2: {bg: '#e0e9f1', fg: '#869cb0', a: 0.9},
  1: {bg: '#cad7e3', fg: '#7a90a4', a: 0.86},
};
const WISP = ['~-~~.~~-~~~.-~', '..~~-~.~~~....'];
const WISP_PAL: Record<string, PaletteTile> = {
  '~': {ch: '~', fg: '#ffffff', a: 0.55},
  '-': {ch: '-', fg: '#ffffff', a: 0.45},
};
const CLOUD_FAR: [number, number, number, number, number][] = [
  [2, 0.1, 0.14, 0.8, 0.65],
  [5, 0.55, 0.08, 0.95, 0.6],
  [6, 0.8, 0.3, 0.75, 0.65],
  [9, 0.35, 0.3, 0.85, 0.6],
];
const CLOUD_NEAR: [number, number, number, number, number][] = [
  [0, 0.15, 0.48, 1.6, 1],
  [3, 0.62, 0.42, 1.9, 1],
  [4, 0.88, 0.72, 1.7, 1],
  [7, 0.36, 0.78, 2.2, 1],
];

// ============================================================================
// 4. HONU LAGOON SCENE
// ============================================================================
const TURTLE_ART = [
  '......ppjMMNN....',
  '....pMMjnddjdj...',
  '..NMdndjddd4dddN.',
  '.jdgdk44ddjmDPSg.',
  '..ddpPRRSSDDNSRr.',
  '...KnngDDDDDngg..',
  '....PDPjDR..NJSR.',
  '...RPDnRK....nDP.',
];
const CLOWN_ART = ['..dmMP..', '.M4M44M.', '.ddM4dM.'];
const TANG_ART = ['...pp...', '.y6eeeFP', '.66666pH'];
const STAR_ART = ['...M....', '.MMMMMM.', '..MMMM..', '.MM..MM.'];
const KELP_ART = ['..J..', '.JD..', '..JJ.', '.JP..', '..DJ.', '...J.', '..J..', '.JD..'];
const HONU_PAL: Record<string, PaletteTile> = {
  p: {bg: '#21bbef', fg: '#0c4a60', a: 0.92},
  j: {bg: '#40b9cd', fg: '#144c56', a: 0.92},
  M: {bg: '#ee7e3a', fg: '#5e2b0d', a: 0.95},
  N: {bg: '#7c4d36', fg: '#331c11', a: 0.95},
  d: {bg: '#3b9662', fg: '#143d25', a: 0.95},
  4: {bg: '#f4e9bf', fg: '#5c5330', a: 0.95},
  k: {bg: '#b7a976', fg: '#423b22', a: 0.95},
  m: {bg: '#946a62', fg: '#382420', a: 0.95},
  D: {bg: '#116c66', fg: '#062b28', a: 0.95},
  P: {bg: '#5fc04f', fg: '#1e4a16', a: 0.95},
  S: {bg: '#97df4f', fg: '#335412', a: 0.95},
  g: {bg: '#cbd5ac', fg: '#454a34', a: 0.92},
  R: {bg: '#53ddf9', fg: '#145866', a: 0.92},
  r: {bg: '#05befa', fg: '#044861', a: 0.92},
  J: {bg: '#3b9662', fg: '#123822', a: 0.92},
  y: {bg: '#3074ee', fg: '#0e285c', a: 0.95},
  6: {bg: '#0163da', fg: '#052247', a: 0.95},
  e: {bg: '#163b5d', fg: '#071524', a: 0.95},
  F: {bg: '#f6cc38', fg: '#594708', a: 0.95},
  H: {bg: '#f6cc38', fg: '#594708', a: 0.95},
};
function nudgeArt(art: string[], pick: (x: number, y: number) => boolean, dx: number, dy: number): string[] {
  const g = art.map(r => [...r]);
  const moved: [number, number, string][] = [];
  art.forEach((row, y) =>
    [...row].forEach((k, x) => {
      if (k !== '.' && pick(x, y)) {
        moved.push([x + dx, y + dy, k]);
        g[y]![x] = '.';
      }
    }),
  );
  for (const [x, y, k] of moved) {
    if (g[y]?.[x] !== undefined) g[y]![x] = k;
  }
  return g.map(r => r.join(''));
}
const TURTLE_FRAMES = [
  TURTLE_ART,
  nudgeArt(TURTLE_ART, (_, y) => y >= 5, -1, 0),
  nudgeArt(TURTLE_ART, (_, y) => y >= 5, 0, 1),
];
const CLOWN_FRAMES = [
  CLOWN_ART,
  nudgeArt(CLOWN_ART, x => x < 3, 0, -1),
  CLOWN_ART,
  nudgeArt(CLOWN_ART, x => x < 3, 0, 1),
];
const TANG_FRAMES = [TANG_ART, nudgeArt(TANG_ART, x => x >= 5, 0, -1), TANG_ART, nudgeArt(TANG_ART, x => x >= 5, 0, 1)];

// ============================================================================
// 5. KOI POND SCENE
// ============================================================================
const LILIES: [number, number, number, number][] = [
  [0.82, 0.08, 3.8, 2.4],
  [0.94, 0.38, 4.2, 2.8],
  [0.06, 0.55, 4.4, 0.2],
  [0.18, 0.92, 4.0, -1.6],
  [0.92, 0.9, 4.2, -2.2],
];
const LOTUS: [number, number, number][] = [
  [0.84, 0.1, 2.6],
  [0.16, 0.85, 2.6],
];
const LILY_PAL = {
  pad: {bg: '#5c9a43', fg: '#2c5520', a: 0.93},
  rim: {bg: '#3f7a31', fg: '#1d3d15', a: 0.93},
  vein: {bg: '#86c066', fg: '#3a6a2a', a: 0.93},
  petal: {bg: '#f28bb8', fg: '#8a2d55', a: 0.95},
  inner: {bg: '#f9c3da', fg: '#a2466e', a: 0.95},
  heart: {bg: '#f6d03f', fg: '#7a5a08', a: 0.97},
  shadow: {bg: '#0b3430', fg: '#0b3430', ch: ' ', a: 0.35},
};
function lilyAt(x: number, y: number, cols: number, rows: number, t: number): PaletteTile | undefined {
  for (const [fx, fy, r] of LOTUS) {
    const cx = fx * cols;
    const cy = fy * rows;
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const d = Math.hypot(dx, dy);
    const th = Math.atan2(dy, dx);
    const p = r * (0.55 + 0.45 * Math.abs(Math.cos(4 * th + fx * 9))) * (1 + 0.07 * Math.sin(t * 0.8 + fx * 5));
    if (d < 0.8) return LILY_PAL.heart;
    if (d < p * 0.55) return LILY_PAL.inner;
    if (d < p) return LILY_PAL.petal;
  }
  for (const [fx, fy, r, notch] of LILIES) {
    const cx = fx * cols;
    const cy = fy * rows;
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const d = Math.hypot(dx, dy);
    if (d > r) continue;
    const th = Math.atan2(dy, dx);
    const off = Math.abs(((((th - notch) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (off < 0.3 && d > 0.4) continue;
    if (d > r - 0.8) return LILY_PAL.rim;
    const spoke = Math.abs(((((((th - notch) * 11) / (Math.PI * 2)) % 1) + 1) % 1) - 0.5);
    return d < 0.8 || (d > 1.2 && spoke > 0.5 - 0.35 / d) ? LILY_PAL.vein : LILY_PAL.pad;
  }
  return undefined;
}
const KOI_FRAMES_A = [
  ['..fwwrww..', '.wrrrrwwf.', '..fwwww...'],
  ['..fwwrww..', '.wrrrrww..', '..fwwwwf..'],
];
const KOI_FRAMES_B = [
  ['..FggggF..', '.ggllllgg.', '..Fgggg...'],
  ['..Fgggg...', '.ggllllggF', '..FggggF..'],
];
const KOI_SPRITE_PAL: Record<string, PaletteTile> = {
  w: {bg: '#f3eee5', fg: '#a59f94', a: 0.95},
  r: {bg: '#de3a2a', fg: '#6e140c', a: 0.95},
  g: {bg: '#f2b52c', fg: '#7a5208', a: 0.95},
  l: {bg: '#f8d769', fg: '#8a6110', a: 0.95},
  f: {bg: '#e6e2d8', fg: '#9a948a', a: 0.78},
  F: {bg: '#f5cc4f', fg: '#8a6110', a: 0.8},
};

// ============================================================================
// 6. JELLYFISH SCENE
// ============================================================================
function makeJellyArt(ph: number): string[] {
  return sketch(11, 12, [
    ...(ph
      ? [
          [0, 3, 'BBBBB'] as [number, number, string],
          [1, 1, 'BBBBBBBBB'] as [number, number, string],
          [2, 1, 'BBpBBBpBB'] as [number, number, string],
          [3, 0, 'RRRRRRRRRRR'] as [number, number, string],
        ]
      : [
          [0, 2, 'BBBBBBB'] as [number, number, string],
          [1, 1, 'BBBBBBBBB'] as [number, number, string],
          [2, 1, 'BBpBBBpBB'] as [number, number, string],
          [3, 1, 'RRRRRRRRR'] as [number, number, string],
        ]),
    [4, 2, 'kkkkkkk'],
    ...[1, 3, 5, 7, 9].flatMap((c, k) =>
      Array.from({length: 7}, (_, i) => {
        const r = hash(k, i, 7);
        return r < 0.2 ? [] : ([[5 + i, c, r < 0.45 ? 'o' : 'l']] as [number, number, string][]);
      }).flat(),
    ),
  ]);
}
const JELLY_ARTS = [makeJellyArt(0), makeJellyArt(1)];
function jellyPal(c: string): Record<string, PaletteTile> {
  return {
    B: {bg: c, fg: shade(c, -0.6), a: 0.72},
    p: {bg: shade(c, 0.55), fg: c, a: 0.85},
    R: {bg: shade(c, 0.15), fg: shade(c, -0.6), a: 0.78},
    k: {bg: shade(c, -0.15), fg: shade(c, -0.65), a: 0.6},
    l: {bg: c, fg: shade(c, -0.6), a: 0.62},
    o: {ch: 'o', fg: shade(c, 0.3), a: 0.5},
  };
}
const JELLY_SPECS: [number, Record<string, PaletteTile>, number, number][] = [
  [0.2, jellyPal('#9a7fe0'), 0.6, 0.75],
  [0.8, jellyPal('#ef8f63'), 0.9, 0.95],
  [0.08, jellyPal('#ec92c6'), 0.75, 0.9],
  [0.58, jellyPal('#7fb4ef'), 1.1, 0.65],
];

// ============================================================================
// 7. LANTERN NIGHT SCENE
// ============================================================================
const LANTERN_NEAR = [
  '..RRRR..',
  '.RRRRRR.',
  '.pPPPPp.',
  '.pPKKPp.',
  '.pPPPPp.',
  '.WWWWWW.',
  'wwwwwwww',
  '..rrrr..',
  '...rr...',
];
const LANTERN_FAR = ['RRRRR', '.pPp.', '.pKp.', '.WWW.', 'wwwww', '.rrr.', '..r..'];
const lanternFlicker = (art: string[]) => art.map((r, y) => (y === 2 ? r.replace(/P/g, 'p') : r));
const LANTERN_ARTS = [
  [LANTERN_FAR, lanternFlicker(LANTERN_FAR)],
  [LANTERN_NEAR, lanternFlicker(LANTERN_NEAR)],
];
const LANTERN_PAL: Record<string, PaletteTile> = {
  R: {bg: '#3a1a14', fg: '#170905', a: 0.95},
  P: {bg: '#ffd889', fg: '#c46a1c', a: 0.97},
  p: {bg: '#f4a347', fg: '#7a3a0c', a: 0.95},
  K: {bg: '#e07a2a', fg: '#5a2a08', a: 0.95},
  W: {bg: '#4a2e1c', fg: '#1e120a', a: 0.95},
  w: {bg: '#2e1c12', fg: '#120a06', a: 0.92},
  r: {bg: '#f6b04e', fg: '#7a3a0c', a: 0.4},
};
const LANTERN_SPECS: [number, number, number][] = [
  [0.08, 0.15, 0.14],
  [0.42, 0.08, 0.12],
  [0.76, 0.22, 0.16],
  [0.22, 0.45, 0.22],
  [0.64, 0.52, 0.2],
  [0.88, 0.38, 0.24],
  [0.14, 0.78, 0.3],
  [0.54, 0.84, 0.28],
];

// ============================================================================
// 8. FIREFLIES SCENE
// ============================================================================
const FLY_ARTS = [
  ['a..', '.Y.', '..c'],
  ['..b', '.Y.', '...'],
  ['...', '.Y.', 'b.a'],
];
const FLY_PAL: Record<string, PaletteTile> = {
  Y: {bg: '#e9f57a', fg: '#2c3308', a: 1},
  a: {ch: ':', fg: '#e9f57a', a: 0.55},
  b: {ch: "'", fg: '#e9f57a', a: 0.55},
  c: {ch: 'o', fg: '#e9f57a', a: 0.4},
};

// ============================================================================
// 9. NEON RAIN SCENE
// ============================================================================
const WALK_ARTS = [
  ['..uUu..', '.uUUUu.', 'uUUUUUu', 'd..|..d', '...h...', '..cCc..', '..l.l..'],
  ['..uUu..', '.uUUUu.', 'uUUUUUu', '...|...', 'd..h..d', '..cCc..', '...l...'],
];
function walkPal(c: string): Record<string, PaletteTile> {
  return {
    U: {bg: c, fg: shade(c, -0.6), a: 0.95},
    u: {bg: shade(c, -0.25), fg: shade(c, -0.7), a: 0.95},
    d: {ch: '.', fg: '#bcd2f5', a: 0.6},
    '|': {ch: '|', fg: '#8a92b0', a: 0.9},
    h: {bg: '#3a3550', fg: '#1a1828', a: 0.95},
    c: {bg: '#252a42', fg: '#121526', a: 0.95},
    C: {bg: '#2f3554', fg: '#151a2e', a: 0.95},
    l: {bg: '#1c2034', fg: '#0c0e18', a: 0.95},
  };
}
const NEON_SIGN_RAMEN = ['+-+', '|R|', '|A|', '|M|', '|E|', '|N|', '+-+'];
const NEON_SIGN_HOTEL = ['+-+', '|H|', '|O|', '|T|', '|E|', '|L|', '+-+'];
function neonSignPal(word: string, c: string): Record<string, PaletteTile> {
  const pal: Record<string, PaletteTile> = {
    '+': {ch: '+', fg: c, a: 0.9},
    '-': {ch: '-', fg: c, a: 0.9},
    '|': {ch: '|', fg: c, a: 0.9},
  };
  for (const ch of word) {
    pal[ch] = {bg: '#1c0b1a', fg: c, a: 0.95, ch};
  }
  return pal;
}

// ============================================================================
// 10. SAKURA DUSK SCENE
// ============================================================================
const SAKURA_BRANCH = [
  'BBBBBBBBbbb......FF..',
  'BBBBbbFFf..bbb..FFcFF',
  'BBb.FFcFF....bbb.FF..',
  'Bb...FFf..fFF..bb....',
  'B......FF..fFF..FFcFF',
  'b.....FcFF.......fFF.',
];
const SAKURA_BRANCHES_L = [0, 1, 2].map(k =>
  SAKURA_BRANCH.map(r => r.replace(/[Ff]/g, (c, i) => ((i + k) % 3 ? c : c === 'F' ? 'f' : 'F'))),
);
const SAKURA_BRANCHES_R = SAKURA_BRANCHES_L.map(flip);
const SAKURA_BRANCH_PAL: Record<string, PaletteTile> = {
  B: {bg: '#2a1a24', fg: '#120a10', a: 0.97},
  b: {ch: '=', fg: '#3e2834', a: 0.9},
  F: {bg: '#f7a8c4', fg: '#9a3d62', a: 0.95},
  f: {bg: '#ffd6e4', fg: '#b8607e', a: 0.9},
  c: {bg: '#ffe9a8', fg: '#9a5a20', a: 0.95},
};
const PETAL_ARTS = [['Pp'], ['P', '.'], ['pP'], ['.', 'P']];
const PETAL_PAL: Record<string, PaletteTile> = {
  P: {bg: '#f7a8c4', fg: '#9a3d62', a: 0.9},
  p: {ch: "'", fg: '#ffd6e4', a: 0.7},
};

// ============================================================================
// 11. SNOW CABIN SCENE
// ============================================================================
const CABIN_LIT = [
  '.........CC...',
  '.....NNNNCC...',
  '...NNNNNNNNNN.',
  '.NNRRRRRRRRRNN',
  '..LLLLLLLLLLL.',
  '..lYyYlLLDDDl.',
  '..LyyyLLLDDDL.',
  'NNNNNNNNNNNNNN',
];
const CABIN_ARTS = [CABIN_LIT, CABIN_LIT.map((r, y) => (y >= 5 && y <= 6 ? r.replace(/Y/g, 'Z') : r))];
const CABIN_PAL: Record<string, PaletteTile> = {
  N: {bg: '#e8f0fb', fg: '#9fb4d4', a: 0.95},
  C: {bg: '#3a2a24', fg: '#1a120e', a: 0.95},
  R: {bg: '#2a1c18', fg: '#120b08', a: 0.95},
  L: {bg: '#5a3b26', fg: '#2e1e12', a: 0.95},
  l: {bg: '#4a2f1e', fg: '#24160c', a: 0.95},
  D: {bg: '#3a2516', fg: '#1a1008', a: 0.95},
  y: {bg: '#5a3b26', fg: '#2e1e12', a: 0.95},
  Y: {bg: '#ffd38a', fg: '#c47a2a', a: 1},
  Z: {bg: '#f6b860', fg: '#a8601c', a: 1},
};
const PINE_ART = ['...N...', '..NGN..', '.GGGGG.', '..GNG..', '.NGGGN.', 'GGGGGGG', '...T...'];
const PINE_PAL: Record<string, PaletteTile> = {
  G: {bg: '#1f3a35', fg: '#0d1e1b', a: 0.95},
  N: {bg: '#dbe6f6', fg: '#8ea2c4', a: 0.92},
  T: {bg: '#3a2516', fg: '#1a1008', a: 0.95},
};

// ============================================================================
// 12. STAR VOYAGE SCENE
// ============================================================================
const ROCKET_HULL: [number, number, string][] = [
  [0, 3, 'W'],
  [1, 3, 'WBBBBb'],
  [2, 3, 'WBBoBBBBNn'],
  [3, 3, 'WBBBBb'],
  [4, 3, 'W'],
];
const ROCKET_FLAMES: [number, number, string][][] = [
  [[2, 0, 'fFF']],
  [
    [1, 1, 'f'],
    [2, 0, 'FFF'],
    [3, 1, 'f'],
  ],
  [
    [2, 1, 'fF'],
    [1, 2, 'f'],
  ],
];
const ROCKET_ARTS = ROCKET_FLAMES.map(f => sketch(13, 5, [...ROCKET_HULL, ...f]));
const ROCKET_PAL: Record<string, PaletteTile> = {
  B: {bg: '#dfe4f5', fg: '#6a7090', a: 0.95},
  b: {bg: '#aab1cc', fg: '#4a5070', a: 0.95},
  W: {bg: '#ff6fb5', fg: '#5a1838', a: 0.95},
  o: {bg: '#4fe3ff', fg: '#0d3a4a', a: 0.95},
  N: {bg: '#ff6fb5', fg: '#5a1838', a: 0.95},
  n: {ch: '>', fg: '#ff6fb5', a: 0.8},
  F: {bg: '#ffb347', fg: '#7a3a00', a: 0.9},
  f: {ch: '~', fg: '#ff7a3d', a: 0.8},
};
const ORBIT_MOON = ['.mm.', 'mMMm', '.mm.'];
const ORBIT_MOON_PAL: Record<string, PaletteTile> = {
  M: {bg: '#d8dcec', fg: '#5a6080', a: 0.95},
  m: {bg: '#a8aec8', fg: '#4a5070', a: 0.9},
};
const PLANET_BANDS = ['#7a4cc2', '#9b5fd6', '#c76fd0', '#8a55c8', '#6a3fae'];

export const WALLPAPER_SCENES: Record<WallpaperPresetId, WallpaperSceneDefinition> = {
  moonlit: {
    id: 'moonlit',
    name: 'Moonlit',
    tagline: 'A crescent moon, drifting clouds, twinkling stars',
    defaultBg: '#0d1530',
    defaultFg: '#dbe2f5',
    defaultAccent: '#d9c98f',
    cell: (x, y, cols, rows, t) => {
      const mx = Math.round(cols * 0.76);
      const my = Math.round(rows * 0.22);
      const R = Math.max(3.5, Math.min(6.5, cols * 0.06));
      const d1 = Math.hypot(x - mx, y - my);
      const d2 = Math.hypot(x - mx - R * 0.5, y - my + R * 0.28);
      if (d1 <= R && d2 > R * 0.85) return {bg: '#d9c98f', fg: '#3a3524', alpha: 0.9};
      if (d1 <= R + 1.4 && d2 > R * 0.85 + 0.5 && hash(x, y, 5) < 0.45) {
        return {fg: '#d9c98f', alpha: 0.25 + 0.15 * Math.sin(t * 2 + x)};
      }
      const tw = twinkle(x, y, t, '#dbe2f5', 0.015);
      return tw ? {ch: tw.ch, fg: tw.fg, alpha: tw.a} : undefined;
    },
    sprites: (cols, rows, t) => {
      const k = Math.floor(t / 12);
      const p = (t - k * 12) / 1.5;
      const meteors: SceneSprite[] = [];
      if (p >= 0 && p < 1) {
        const left = hash(k, 3) < 0.5;
        const run = 22 * p;
        const hx = cols * (0.25 + 0.5 * hash(k, 1)) + (left ? -run : run);
        const hy = rows * (0.06 + 0.24 * hash(k, 2)) + run * 0.4;
        meteors.push({
          art: METEORS[+left],
          pal: METEOR_PALS[+left],
          key: 40,
          a: Math.sin(Math.PI * p),
          x: left ? hx : hx - 7,
          y: hy - 3,
        });
      }
      return [
        ...meteors,
        ...MOONLIT_CLOUDS.map(([fx, fy, w, v], i) => ({
          art: moonlitCloudArt(w),
          pal: MOONLIT_NIGHT,
          halo: '#8ea2e6',
          x: drift(cols, fx, t, v, w) - w / 2,
          y: fy * rows - 3,
          key: i + 1,
        })),
      ];
    },
  },

  'futryn-spark': {
    id: 'futryn-spark',
    name: 'FUTRYN Spark',
    tagline: 'A turning amber spark, drifting embers, FUTRYN sentinel on patrol',
    defaultBg: '#1f1714',
    defaultFg: '#f2e6df',
    defaultAccent: '#d97757',
    cell: (x, y, cols, rows, t) => {
      const cx = cols * 0.82;
      const cy = rows * 0.28;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      if (r <= 1.4) return {bg: '#f0883e', fg: '#3b1d12', alpha: 0.85, floor: 0.55};
      for (let k = 0; k < 10; k++) {
        let da = Math.abs(ang - ((k * Math.PI * 2) / 10 + t * 0.06)) % (Math.PI * 2);
        da = Math.min(da, Math.PI * 2 - da);
        if (da >= Math.PI / 2) continue;
        const len = 5.5 + 4 * hash(k, 1) + Math.sin(t * 1.4 + k) * 0.7;
        const along = r * Math.cos(da);
        const off = r * Math.sin(da);
        if (along <= len && off <= 0.4 + 0.5 * (1 - along / len) ** 0.7) {
          return {bg: '#d97757', fg: '#3b1d12', alpha: 0.7 * (1 - Math.min(1, r / 11)), floor: 0.5};
        }
      }
      if (rising(x, y, t, 1.2, 0.007)) return {ch: '.', fg: '#e9a083', alpha: 0.5};
      const s = hash(x, y, 13);
      if (s < 0.008) {
        return {
          ch: '<>()=$/*'[Math.floor(s * 1000) % 8],
          fg: '#d97757',
          alpha: 0.2 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.3 + s * 900)),
        };
      }
      return undefined;
    },
    sprites: (cols, rows, t) => {
      const lo = cols * 0.15;
      const hi = Math.max(lo + 4, cols * 0.88 - 9);
      const p = ((t * 2.2) / Math.max(1, hi - lo)) % 2;
      return [
        {
          art: ['.'],
          pal: {},
          x: cols * 0.82 - 0.5,
          y: rows * 0.28 - 0.5,
          key: 2,
          glow: {r: 10, color: '#d97757', a: 0.28 + 0.05 * Math.sin(t * 1.4)},
        },
        {
          art: frame(FUTRYN_BOT_FRAMES, t, 5),
          pal: FUTRYN_BOT_PAL,
          x: lo + (hi - lo) * (p < 1 ? p : 2 - p),
          y: Math.max(2, rows - 7),
          key: 1,
        },
      ];
    },
  },

  'cloud-drift': {
    id: 'cloud-drift',
    name: 'Cloud Drift',
    tagline: 'White clouds over a bright sky, birds gliding by',
    defaultBg: '#d8ecfa',
    defaultFg: '#1d3447',
    defaultAccent: '#2f78bd',
    cell: (x, y, _cols, _rows) => {
      if ((x + y) % 19 === 0 && hash(x, y, 3) < 0.15) {
        return {ch: '·', fg: '#86c3f0', alpha: 0.22};
      }
      return undefined;
    },
    sprites: (cols, rows, t) => {
      const toCloud = ([seed, fx, fy, v, a]: [number, number, number, number, number]): SceneSprite => {
        const art = skyArt(seed);
        const w = art[0]?.length ?? 8;
        return {
          art,
          pal: DAY_TOPS,
          a,
          halo: '#ffffff',
          x: drift(cols, fx, t, v, w) - w / 2,
          y: fy * rows - art.length / 2,
          key: seed + 1,
        };
      };
      return [
        {art: WISP, pal: WISP_PAL, key: 60, x: drift(cols, 0.2, t, 2.4, 14) - 7, y: rows * 0.08},
        ...CLOUD_FAR.map(toCloud),
        ...FLOCK.map(([bx, by], j) => ({
          art: frame(BIRDS, t, 3, j * 0.5),
          pal: BIRD_PAL,
          key: 20 + j,
          x: drift(cols, 0.35, t, 2.5, 6) + bx,
          y: rows * 0.28 + Math.sin(t * 0.7) * 1.5 + by,
        })),
        ...CLOUD_NEAR.map(toCloud),
      ];
    },
  },

  'honu-lagoon': {
    id: 'honu-lagoon',
    name: 'Honu Lagoon',
    tagline: 'A sea turtle swimming across a lagoon, light rays and bubbles',
    defaultBg: '#0f3a44',
    defaultFg: '#e3f6f2',
    defaultAccent: '#5fd0b8',
    cell: (x, y, cols, rows, t) => {
      for (let i = 0; i < 7; i++) {
        const bx = Math.floor(hash(i, 31) * cols) + Math.round(Math.sin(t + i));
        const by = Math.round(rows - ((t * 1.8 * (1 + hash(i, 32)) + hash(i, 33) * rows) % (rows + 4)));
        if (x === bx && y === by) return {ch: 'o', fg: '#e8fbff', alpha: 0.65};
      }
      if (rising(x, y, t, 0.5, 0.008)) return {ch: '.', fg: '#cdeefa', alpha: 0.35};
      const tw = twinkle(x, y, t, '#e8fbff', 0.006);
      return tw ? {ch: tw.ch, fg: tw.fg, alpha: tw.a} : undefined;
    },
    sprites: (cols, rows, t) => [
      {
        art: KELP_ART,
        pal: HONU_PAL,
        key: 10,
        x: Math.round(cols * 0.04 + Math.sin(t * 1.1) * 0.8),
        y: Math.max(1, rows - KELP_ART.length - 1),
      },
      {
        art: KELP_ART,
        pal: HONU_PAL,
        key: 11,
        x: Math.round(cols * 0.9 + Math.cos(t * 1.1) * 0.8),
        y: Math.max(1, rows - KELP_ART.length - 1),
      },
      {
        art: STAR_ART,
        pal: HONU_PAL,
        key: 7,
        x: Math.round(cols * 0.08),
        y: Math.max(1, rows - STAR_ART.length - 1),
      },
      {
        art: frame(TURTLE_FRAMES, t, 2.2),
        pal: HONU_PAL,
        key: 1,
        shadow: '#0b3d7a',
        x: drift(cols, 0.25, t, 1.1, 17) - 8,
        y: Math.round(rows * 0.22 + Math.sin(t * 0.6) * 0.8),
      },
      {
        art: frame(CLOWN_FRAMES, t, 4.5),
        pal: HONU_PAL,
        key: 4,
        x: Math.round(cols * 0.16 + Math.sin(t * 0.8) * 2.5),
        y: Math.round(rows * 0.52 + Math.sin(t * 1.3) * 0.6),
      },
      {
        art: frame(TANG_FRAMES, t, 5),
        pal: HONU_PAL,
        key: 5,
        x: cols - drift(cols, 0.4, t, 1.8, 8),
        y: Math.round(rows * 0.64 + Math.sin(t * 1.4) * 0.5),
      },
    ],
  },

  'koi-pond': {
    id: 'koi-pond',
    name: 'Koi Pond',
    tagline: 'Koi circling a pond between lily pads, rings on the water',
    defaultBg: '#11332d',
    defaultFg: '#e4f2ea',
    defaultAccent: '#ef8a4a',
    cell: (x, y, cols, rows, t) => {
      const lily = lilyAt(x, y, cols, rows, t);
      if (lily) return {ch: lily.ch, bg: lily.bg, fg: lily.fg, alpha: lily.a};
      if (lilyAt(x - 1, y - 1, cols, rows, t)) {
        return {ch: ' ', bg: LILY_PAL.shadow.bg, fg: LILY_PAL.shadow.fg, alpha: LILY_PAL.shadow.a};
      }
      for (let i = 0; i < 4; i++) {
        const rr = (t * 1.6 + i * 3.7) % 10;
        const d = Math.hypot(x - hash(i, 61) * cols, y - hash(i, 62) * rows);
        if ((Math.abs(d - rr) < 0.5 || Math.abs(d - rr + 2.2) < 0.5) && hash(x, y, 63) < 0.7) {
          return {ch: 'o', fg: '#d6f1e8', alpha: 0.4 * (1 - rr / 10)};
        }
      }
      const tw = twinkle(x, y, t, '#e8fbf6', 0.005);
      return tw ? {ch: tw.ch, fg: tw.fg, alpha: tw.a} : undefined;
    },
    sprites: (cols, rows, t) => {
      const a1 = t * 0.35;
      const a2 = -t * 0.28 + 2.1;
      const d1 = Math.sin(a1) < 0;
      const d2 = Math.sin(a2) > 0;
      const art1 = frame(KOI_FRAMES_A, t, 3.2);
      const art2 = frame(KOI_FRAMES_B, t, 2.8);
      return [
        {
          art: d1 ? flip(art1) : art1,
          pal: KOI_SPRITE_PAL,
          key: 1,
          shadow: '#0b3430',
          x: cols * 0.72 + Math.cos(a1) * Math.max(4, cols * 0.14) - 5,
          y: rows * 0.32 + Math.sin(a1) * Math.max(2, rows * 0.16) - 1,
        },
        {
          art: d2 ? flip(art2) : art2,
          pal: KOI_SPRITE_PAL,
          key: 2,
          shadow: '#0b3430',
          x: cols * 0.26 + Math.cos(a2) * Math.max(4, cols * 0.13) - 5,
          y: rows * 0.62 + Math.sin(a2) * Math.max(2, rows * 0.16) - 1,
        },
      ];
    },
  },

  jellyfish: {
    id: 'jellyfish',
    name: 'Jellyfish',
    tagline: 'Jellyfish rising through deep water, bells pulsing',
    defaultBg: '#0a1830',
    defaultFg: '#dfe7fb',
    defaultAccent: '#a58cf0',
    cell: (x, y, cols, rows, t) => {
      const cx = -cols * 0.15;
      const cy = -rows * 0.35;
      const R = rows * 0.75 + cols * 0.1;
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - R) < 0.6 && (((Math.atan2(y - cy, x - cx) * R - t * 3) % 3) + 3) % 3 < 1) {
        return {ch: 'o', fg: '#dbe8ff', alpha: 0.55};
      }
      if (rising(x, y, t, 0.6, 0.01)) return {ch: '.', fg: '#9cc8ff', alpha: 0.35};
      return undefined;
    },
    sprites: (cols, rows, t) =>
      JELLY_SPECS.map(([fx, pal, v, a], i) => {
        const span = rows + 18;
        return {
          art: frame(JELLY_ARTS, t, 1.1, i * 0.5),
          pal,
          a,
          key: i + 1,
          x: fx * cols + Math.sin(t * 0.35 + i) * 2.5 - 5.5,
          y: rows + 2 - ((t * v + (i * span) / 4) % span),
        };
      }),
  },

  'lantern-night': {
    id: 'lantern-night',
    name: 'Lantern Night',
    tagline: 'Paper lanterns drifting down a river at night',
    defaultBg: '#0b1424',
    defaultFg: '#efe6d2',
    defaultAccent: '#f2a541',
    cell: (x, y, _cols, rows, t) => {
      const bank = Math.round(rows * 0.3);
      const roof = bank - 1 - Math.floor(2.2 * (0.5 + 0.5 * Math.sin(x * 0.21)) + hash(Math.floor(x / 3), 7) * 1.8);
      if (y < roof) {
        const tw = twinkle(x, y, t, '#fff1cf', 0.012);
        return tw ? {ch: tw.ch, fg: tw.fg, alpha: tw.a} : undefined;
      }
      if (y < bank) {
        if (y < bank - 1 && hash(x, y, 41) < 0.07) {
          return {bg: '#f2b65a', fg: '#6a3a0c', alpha: 0.55 + 0.3 * Math.sin(t * 0.7 + x) ** 2};
        }
        return {bg: '#04070e', fg: '#131c30', alpha: 0.95};
      }
      if (hash(Math.floor(x / 4 + t * 0.25 * (1 + (y % 3) * 0.3)), y, 45) < 0.07) {
        return {ch: (x + y) % 2 ? '~' : '-', fg: '#8fb0d6', alpha: 0.22};
      }
      return undefined;
    },
    sprites: (cols, rows, t) =>
      LANTERN_SPECS.map(([fx, depth, v], i) => {
        const isNear = depth > 0.45;
        const art = frame(LANTERN_ARTS[+isNear]!, t, 2.2, i * 1.7);
        const top = rows * 0.3 + 1 + depth * Math.max(2, rows * 0.65 - 10);
        return {
          art,
          pal: LANTERN_PAL,
          key: 60 + i,
          a: 0.7 + 0.3 * depth,
          glow: {r: isNear ? 6 : 3.5, color: '#ffb347', a: isNear ? 0.38 : 0.24},
          x: drift(cols, fx, t, v, art[0]?.length ?? 6),
          y: top + Math.sin(t * 0.8 + i * 2) * 0.5,
        };
      }),
  },

  fireflies: {
    id: 'fireflies',
    name: 'Fireflies',
    tagline: 'Fireflies wandering and blinking over tall grass',
    defaultBg: '#0b130e',
    defaultFg: '#e3eedc',
    defaultAccent: '#d8e86a',
    cell: (x, y, _cols, rows, t) => {
      const h = 2 + Math.floor(hash(x, 7) ** 2 * 6);
      if (y < rows - h || (y < rows - 1 && hash(x, y, 8) > 0.75)) return undefined;
      return {
        ch: glyph('SXt%S', x, y, t * 0.5),
        fg: '#4fb85c',
        alpha: 0.5 + (0.45 * (y - rows + h)) / h,
      };
    },
    sprites: (cols, rows, t) =>
      Array.from({length: 16}, (_, i) => {
        const b = Math.max(0, Math.min(1, Math.sin(t * (0.6 + 0.5 * hash(i, 5)) + i * 3) * 1.4 - 0.2));
        return {
          art: FLY_ARTS[i % 3],
          pal: FLY_PAL,
          key: i + 1,
          a: 0.12 + 0.88 * b,
          glow: {r: 3.2, color: '#cfe86a', a: 0.18 + 0.28 * b},
          x: hash(i, 1) * cols + Math.sin(t * 0.2 * (1 + hash(i, 2)) + i) * 5 - 1,
          y: rows * (0.08 + 0.65 * hash(i, 3)) + Math.cos(t * 0.17 * (1 + hash(i, 4)) + i * 2) * 3 - 1,
        };
      }),
  },

  'neon-rain': {
    id: 'neon-rain',
    name: 'Neon Rain',
    tagline: 'Rain over a city at night, neon signs buzzing, umbrellas passing by',
    defaultBg: '#0c1020',
    defaultFg: '#e3e8f6',
    defaultAccent: '#ff5fa2',
    cell: (x, y, cols, rows, t) => {
      const ground = rows - 3;
      if (y >= ground) {
        const sy = y - ground;
        if (sy === 0) return {ch: '_', fg: '#3a4570', alpha: 0.55};
        if (hash(x, sy, 40 + Math.floor(t * 3)) < 0.025) return {ch: 'o', fg: '#a9c4f0', alpha: 0.5};
        if (hash(x, Math.floor(t * 1.5) + sy, 41) < 0.12) {
          const smear = ['#ff5fa2', '#4fe3ff', '#f3c56b'][Math.floor(hash(x, 42) * 3)]!;
          return {ch: sy === 1 ? '|' : '~', fg: smear, alpha: 0.28};
        }
        return undefined;
      }
      const b = Math.floor(x / 6);
      const mid = cols / 2;
      const edge = Math.min(1, Math.abs(x - mid) / Math.max(1, mid));
      const h = Math.round(rows * (0.12 + 0.45 * edge ** 1.8 * (0.6 + 0.4 * hash(b, 2))));
      const top = ground - h;
      if (y >= top) {
        if (y === top) return {bg: '#2a3358', fg: '#3a4570', alpha: 0.92};
        if (x % 2 === 1 && (ground - y) % 2 === 0 && y > top + 1) {
          const lit = hash(x, y, 21) < 0.42 !== hash(x, y, 22 + Math.floor(t / 7)) < 0.08;
          if (lit) return {bg: '#f3c56b', fg: '#6a4a10', alpha: 0.82};
        }
        return {bg: '#1b2242', fg: '#2b355a', alpha: 0.9};
      }
      const q = Math.floor(y - t * 11);
      const track = Math.floor(x + y * 0.3);
      const m = ((q % 3) + 3) % 3;
      if (m < 2 && hash(track, Math.floor(q / 3), 27) < 0.09) {
        return {ch: '/', fg: '#a9c4f0', alpha: m ? 0.58 : 0.28};
      }
      return undefined;
    },
    sprites: (cols, rows, t, eventKind) => {
      const ground = Math.max(4, rows - 3);
      const lightningActive = eventKind === 'error' || t % 23 < 0.15;
      return [
        ...(lightningActive
          ? [
              {
                art: ['..../...', '.../....', '..\\.....', '...\\....', '..../...'],
                pal: {'/': {ch: '/', fg: '#eef3ff', a: 1}, '\\': {ch: '\\', fg: '#eef3ff', a: 1}},
                key: 80,
                x: Math.round(cols * 0.15),
                y: 1,
                glow: {r: 10, color: '#a9bcff', a: 0.4},
              },
            ]
          : []),
        {
          art: NEON_SIGN_RAMEN,
          pal: neonSignPal('RAMEN', '#ff5fa2'),
          key: 70,
          x: Math.max(1, Math.round(cols * 0.06)),
          y: Math.max(2, Math.round(rows * 0.35)),
          glow: {r: 5, color: '#ff5fa2', a: 0.32},
        },
        {
          art: NEON_SIGN_HOTEL,
          pal: neonSignPal('HOTEL', '#4fe3ff'),
          key: 71,
          x: Math.max(2, Math.round(cols * 0.88)),
          y: Math.max(2, Math.round(rows * 0.32)),
          glow: {r: 5, color: '#4fe3ff', a: 0.32},
        },
        {
          art: frame(WALK_ARTS, t, 3, 0),
          pal: walkPal('#ff5fa2'),
          key: 90,
          x: drift(cols, 0.2, t, 1.5, 7) - 3.5,
          y: Math.max(1, ground - 7),
        },
        {
          art: frame(WALK_ARTS, t, 3, 1),
          pal: walkPal('#f2c14e'),
          key: 91,
          x: cols - drift(cols, 0.7, t, 1.1, 7) - 3.5,
          y: Math.max(1, ground - 7),
        },
      ];
    },
  },

  'sakura-dusk': {
    id: 'sakura-dusk',
    name: 'Sakura Dusk',
    tagline: 'Cherry branches at the corners, petals drifting through a violet evening',
    defaultBg: '#231a2e',
    defaultFg: '#f6e9f0',
    defaultAccent: '#f29bb8',
    cell: (x, y, cols, rows, t) => {
      const hill =
        rows - 3 - Math.round(2.2 * (0.5 + 0.5 * Math.sin(x * 0.09 + 1)) + 1.2 * (0.5 + 0.5 * Math.sin(x * 0.23)));
      const sx = cols * 0.8;
      const sy = hill + 1;
      const d = Math.hypot((x - sx) * 0.5, y - sy);
      if (y >= hill) {
        if (hash(x, y, 21) < 0.05) return {ch: '.', fg: '#f7a8c4', alpha: 0.45};
        return {bg: '#1a1222', fg: '#2c1d34', alpha: 0.94};
      }
      if (d < 4) return {bg: '#ffb48a', fg: '#c0603a', alpha: 0.75, floor: 0.3};
      if (y < rows * 0.45) {
        const tw = twinkle(x, y, t, '#f3dcef', 0.012);
        if (tw) return {ch: tw.ch, fg: tw.fg, alpha: tw.a};
      }
      if (rising(x, y, -t, 0.6, 0.006)) return {ch: '.', fg: '#ffd6e4', alpha: 0.25};
      return undefined;
    },
    sprites: (cols, rows, t) => {
      const leftBranch = frame(SAKURA_BRANCHES_L, t, 1.4, 0);
      const rightBranch = frame(SAKURA_BRANCHES_R, t, 1.4, 1);
      const petalCount = Math.min(20, Math.max(6, Math.round(6 + cols / 10)));
      return [
        {
          art: leftBranch,
          pal: SAKURA_BRANCH_PAL,
          key: 1,
          halo: '#f7a8c4',
          x: 0,
          y: Math.sin(t * 0.5) * 0.4,
        },
        {
          art: rightBranch,
          pal: SAKURA_BRANCH_PAL,
          key: 2,
          halo: '#f7a8c4',
          x: Math.max(0, cols - (rightBranch[0]?.length ?? 20)),
          y: Math.sin(t * 0.5 + 2) * 0.4,
        },
        ...Array.from({length: petalCount}, (_, i) => {
          const v = 0.8 + 1.2 * hash(i, 1);
          const span = rows + 4;
          const py = ((((hash(i, 2) * span + t * v) % span) + span) % span) - 2;
          const side = hash(i, 3) < 0.5;
          const depth = hash(i, 4);
          const x0 = side ? cols * (0.02 + 0.3 * hash(i, 5)) : cols * (0.68 + 0.3 * hash(i, 5));
          return {
            art: frame(PETAL_ARTS, t, 2 + 2 * hash(i, 6), i),
            pal: PETAL_PAL,
            key: 10 + i,
            a: 0.35 + 0.6 * depth,
            x: x0 + py * 0.35 + Math.sin(t * 0.9 + i) * 3,
            y: py,
          };
        }),
      ];
    },
  },

  'snow-cabin': {
    id: 'snow-cabin',
    name: 'Snow Cabin',
    tagline: 'A log cabin under snowy peaks, a warm window, smoke curling into falling snow',
    defaultBg: '#0e1628',
    defaultFg: '#e6edf8',
    defaultAccent: '#ffb85c',
    cell: (x, y, cols, rows, t) => {
      const ground = Math.round(rows * 0.84 + Math.sin(x * 0.09) * 1.2);
      const peak = Math.max(
        0,
        rows * 0.32 - Math.abs(x - cols * 0.12) * 0.85,
        rows * 0.36 - Math.abs(x - cols * 0.88) * 0.8,
      );
      const ridge = Math.round(rows * 0.84 - peak);
      if (y >= ground) {
        if (hash(x, y, 21) < 0.02) return {ch: '*', fg: '#ffffff', alpha: 0.5};
        return {bg: '#3d4d6e', fg: '#56688c', alpha: 0.85};
      }
      if (y >= ridge) {
        if (y < ridge + 2 && peak > 5) return {bg: '#b8c7df', fg: '#8195b8', alpha: 0.7};
        return {bg: '#18233d', fg: '#222f4d', alpha: 0.88};
      }
      const cx = Math.round(cols * 0.05);
      const cy = ground - 8;
      const dy = cy + 1 - y;
      if (dy > 0 && dy < 10) {
        const mid = cx + 9.5 + Math.sin(t * 0.8 - dy * 0.5) * 1.1 + dy * 0.4;
        if (Math.abs(x - mid) <= 1 + dy * 0.1 && hash(x, Math.floor(y + t * 1.6), 17) < 0.55) {
          return {ch: dy < 4 ? 'o' : '~', fg: '#c9d3e6', alpha: 0.4 * (1 - dy / 10)};
        }
      }
      const fall = (v: number, odds: number, seed: number) =>
        hash(x + Math.round(Math.sin(y * 0.3 + t * 0.5 + seed) * 1.5), Math.floor(y - t * v), seed) < odds;
      if (fall(3.2, 0.012, 31)) return {ch: '*', fg: '#ffffff', alpha: 0.7};
      if (fall(1.6, 0.02, 33)) return {ch: '.', fg: '#dfe8f6', alpha: 0.45};
      const tw = twinkle(x, y, t, '#e6edf8', 0.01);
      return tw ? {ch: tw.ch, fg: tw.fg, alpha: tw.a} : undefined;
    },
    sprites: (cols, rows, t) => {
      const ground = Math.round(rows * 0.84);
      const cx = Math.round(cols * 0.05);
      const cy = Math.max(1, ground - 8);
      return [
        {
          art: frame(CABIN_ARTS, t, 1.6),
          pal: CABIN_PAL,
          key: 1,
          x: cx,
          y: cy,
          shadow: '#0a1020',
          glow: {r: 6, color: '#ffb85c', a: 0.3 + 0.06 * Math.sin(t * 3)},
        },
        ...[0.78, 0.88].map((fx, i) => ({
          art: PINE_ART,
          pal: PINE_PAL,
          key: 10 + i,
          x: Math.round(cols * fx),
          y: Math.max(1, ground - 7),
          halo: '#dfe8f6',
        })),
      ];
    },
  },

  'star-voyage': {
    id: 'star-voyage',
    name: 'Star Voyage',
    tagline: 'A little rocket passing a ringed planet, shooting stars overhead',
    defaultBg: '#0d0a1f',
    defaultFg: '#e6ecff',
    defaultAccent: '#ff6fb5',
    cell: (x, y, cols, rows, t) => {
      const R = Math.max(3.5, Math.min(8, cols * 0.065));
      const cx = cols * 0.84;
      const cy = rows * 0.32;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const ring = ell(x + 0.5, y + 0.5, cx, cy + dx * 0.12, R * 2.1, R * 0.5);
      const onRing = ring > 0.78 && ring < 1.05;
      const front = dy + dx * 0.12 > 0;
      if (onRing && (front || d > R)) {
        const a = 0.55 + 0.25 * Math.sin(dx * 0.6 - t * 1.5);
        return {bg: '#e6c9ff', fg: '#5a3a80', alpha: d > R ? a * 0.8 : a, floor: 0.45};
      }
      if (d <= R) {
        const bandIdx =
          Math.floor(Math.abs((dy / R + 1) * 2.5 + 0.4 * Math.sin(dx * 0.5 + t * 0.3))) % PLANET_BANDS.length;
        const band = PLANET_BANDS[bandIdx] ?? PLANET_BANDS[0]!;
        const lit = (-dx - dy) / (R * 1.6);
        return {
          bg: shade(band, Math.max(-0.55, Math.min(0.25, lit))),
          fg: shade(band, -0.6),
          alpha: 0.92,
          floor: 0.5,
        };
      }
      const rx = drift(cols, 0.3, t, 4, 13);
      const ry = rows * 0.14 + 1.5 * Math.sin(t * 0.9);
      const trailDist = rx - 6.5 - x;
      if (trailDist > 0 && trailDist < 14 && Math.abs(y - (ry + 2)) < 0.85 && hash(x, y, Math.floor(t * 5)) < 0.5) {
        return {
          ch: trailDist < 5 ? 'o' : '.',
          fg: trailDist < 5 ? '#ffb347' : '#ffd1ea',
          alpha: 0.6 * (1 - trailDist / 14),
        };
      }
      const tw = twinkle(x, y, t, '#e6ecff', 0.018);
      return tw ? {ch: tw.ch, fg: tw.fg, alpha: tw.a} : undefined;
    },
    sprites: (cols, rows, t) => {
      const R = Math.max(3.5, Math.min(8, cols * 0.065));
      const cx = cols * 0.84;
      const cy = rows * 0.32;
      const rx = drift(cols, 0.3, t, 4, 13);
      const ry = rows * 0.14 + 1.5 * Math.sin(t * 0.9);
      const m = t * 0.35;
      return [
        {
          art: ORBIT_MOON,
          pal: ORBIT_MOON_PAL,
          key: 2,
          shadow: '#05040d',
          halo: '#c9cde0',
          x: cx + Math.cos(m) * R * 2.5 - 2,
          y: cy + Math.sin(m) * R * 0.85 - 1.5,
        },
        {
          art: frame(ROCKET_ARTS, t, 8),
          pal: ROCKET_PAL,
          key: 3,
          shadow: '#05040d',
          x: rx - 6.5,
          y: ry,
          glow: {r: 4.5, color: '#ffb347', a: 0.3 + 0.1 * Math.sin(t * 13)},
        },
      ];
    },
  },
};

export function resolveWallpaperId(id: string | null | undefined): WallpaperPresetId | null {
  if (!id) return null;
  const normalized = id.trim().toLowerCase();
  if (normalized === 'clawd') return 'futryn-spark';
  if ((WALLPAPER_PRESET_IDS as readonly string[]).includes(normalized)) {
    return normalized as WallpaperPresetId;
  }
  return null;
}

export interface RenderWallpaperOptions {
  cols: number;
  rows: number;
  timeSeconds: number;
  config: AnimationConfig;
  backgroundHex: string;
  focused?: boolean;
  heavyLoad?: boolean;
  centerColumnRange?: [number, number];
  eventKind?: string;
}

export class WallpaperEngine {
  private paused = false;
  private focused = true;
  private lastRenderDurationMs = 0;
  private frameCounter = 0;

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  isFocused(): boolean {
    return this.focused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(config: AnimationConfig): boolean {
    if (this.paused) return true;
    if (!config.enabled) return true;
    if (config.pauseUnfocused && !this.focused) return true;
    return false;
  }

  lastFrameMs(): number {
    return this.lastRenderDurationMs;
  }

  listPresets(): WallpaperSceneDefinition[] {
    return WALLPAPER_PRESET_IDS.map(id => WALLPAPER_SCENES[id]);
  }

  getPreset(id: string | null | undefined): WallpaperSceneDefinition | null {
    const resolved = resolveWallpaperId(id);
    return resolved ? WALLPAPER_SCENES[resolved] : null;
  }

  /**
   * Compute a 2D grid of `SceneCell | null` for the terminal viewport.
   * Respects:
   * - `config.enabled`
   * - `config.reducedMotion` (freezes time at t = 20s)
   * - `config.motion` ('smooth' vs 'grid')
   * - `config.speed` and `config.cellSize`
   * - `config.veil` (attenuates decorative brightness in the center chat column so text is 100% readable)
   * - Terminal size minimum capability guard (`cols < 24 || rows < 8` auto-disables)
   */
  renderFrame(presetId: string | null | undefined, options: RenderWallpaperOptions): (SceneCell | null)[][] {
    const start = performance.now();
    const {cols, rows, config, backgroundHex} = options;
    const grid: (SceneCell | null)[][] = Array.from({length: Math.max(0, rows)}, () =>
      Array<SceneCell | null>(Math.max(0, cols)).fill(null),
    );

    const scene = this.getPreset(presetId);
    if (!scene || !config.enabled || cols < 24 || rows < 8) {
      this.lastRenderDurationMs = performance.now() - start;
      return grid;
    }

    const focused = options.focused ?? this.focused;
    if (config.pauseUnfocused && !focused && !config.reducedMotion) {
      // Render static frame when unfocused
    }

    const effectiveTime =
      config.reducedMotion || (config.pauseUnfocused && !focused)
        ? 20
        : options.timeSeconds * Math.max(0.1, Math.min(16, config.speed));

    const scale = Math.max(1, Math.min(4, Math.round(config.cellSize)));
    const sCols = Math.max(12, Math.ceil(cols / scale));
    const sRows = Math.max(6, Math.ceil(rows / scale));
    const isGrid = config.motion === 'grid';
    const veil = Math.max(0, Math.min(0.95, config.veil));
    const colRange = options.centerColumnRange ?? [Math.floor(cols * 0.12), Math.ceil(cols * 0.88)];

    const keepFactor = (px: number, floor = 0): number => {
      const [left, right] = colRange;
      if (px <= left || px >= right) return 1;
      const distInside = Math.min(px - left, right - px);
      const ramp = Math.max(0, Math.min(1, distInside / 6));
      const baseAttenuation = 1 - veil * 0.85 * ramp;
      return Math.max(floor * (1 - veil * 0.5), baseAttenuation);
    };

    const putCell = (
      gx: number,
      gy: number,
      tile: {ch?: string; fg: string; bg?: string; a: number; floor?: number},
      sx: number,
      sy: number,
      subPhase = 0,
    ) => {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const tx = gx * scale + dx;
          const ty = gy * scale + dy;
          if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) continue;
          const k = keepFactor(tx, tile.floor ?? 0);
          const alpha = Math.max(0, Math.min(1, tile.a * k));
          if (alpha < 0.04) continue;
          const fgBlended = mixHex(backgroundHex, tile.fg, alpha);
          const bgBlended = tile.bg ? mixHex(backgroundHex, tile.bg, alpha * 0.65) : undefined;
          let ch = tile.ch;
          if (!ch) {
            if (!isGrid && tile.bg && subPhase > 0) {
              ch = SMOOTH_SHADES[Math.min(4, Math.max(1, Math.round(alpha * 4)))] ?? '▒';
            } else {
              ch = glyph(tile.bg ? GLYPHS : LOOSE, sx, sy, effectiveTime);
            }
          }
          grid[ty]![tx] = {
            ch: ch[0] ?? '.',
            fg: fgBlended,
            bg: bgBlended,
            alpha,
            floor: tile.floor,
          };
        }
      }
    };

    if (scene.cell) {
      for (let sy = 0; sy < sRows; sy++) {
        for (let sx = 0; sx < sCols; sx++) {
          const c = scene.cell(sx, sy, sCols, sRows, effectiveTime, options.eventKind);
          if (c) {
            putCell(sx, sy, {ch: c.ch, fg: c.fg, bg: c.bg, a: c.alpha, floor: c.floor}, sx, sy);
          }
        }
      }
    }

    const sprites = scene.sprites?.(sCols, sRows, effectiveTime, options.eventKind) ?? [];
    for (const s of sprites) {
      const rawX = isGrid ? Math.round(s.x) : s.x;
      const rawY = isGrid ? Math.round(s.y) : s.y;
      const ox = Math.round(rawX);
      const oy = Math.round(rawY);
      const subPhase = Math.abs(rawX - ox) + Math.abs(rawY - oy);
      const m = s.a ?? 1;
      const k = s.key * 997;
      const bw = s.art ? (s.art[0]?.length ?? 0) : (s.w ?? 0);
      const bh = s.art ? s.art.length : (s.h ?? 0);
      if (ox > sCols + 4 || oy > sRows + 4 || ox + bw + 4 < 0 || oy + bh + 4 < 0) continue;

      if (s.glow) {
        const g = s.glow;
        const cx = ox + bw / 2;
        const cy = oy + bh / 2;
        const r = Math.min(12, g.r);
        const minY = Math.max(0, Math.floor(cy - r));
        const maxY = Math.min(sRows - 1, Math.ceil(cy + r));
        const minX = Math.max(0, Math.floor(cx - r));
        const maxX = Math.min(sCols - 1, Math.ceil(cx + r));
        for (let gy = minY; gy <= maxY; gy++) {
          for (let gx = minX; gx <= maxX; gx++) {
            const dist = Math.hypot(gx - cx, gy - cy);
            if (dist <= r && hash(gx, gy, s.key) < 0.35) {
              const ga = g.a * (1 - dist / r);
              putCell(gx, gy, {ch: '·', fg: g.color, a: ga}, gx, gy);
            }
          }
        }
      }

      const cells: [number, number, PaletteTile, number, number][] = [];
      if (s.art && s.pal) {
        s.art.forEach((row, gy) => {
          for (let gx = 0; gx < row.length; gx++) {
            const chKey = row[gx]!;
            const tile = s.pal![chKey];
            if (tile) cells.push([gx, gy, tile, gx + k, gy]);
          }
        });
      } else if (s.field && s.w && s.h) {
        for (let gy = 0; gy < s.h; gy++) {
          for (let gx = 0; gx < s.w; gx++) {
            const f = s.field(gx, gy);
            if (f) cells.push([gx, gy, f.c, (f.sx ?? gx) + k, f.sy ?? gy]);
          }
        }
      }

      if (s.shadow) {
        const shadowHex = typeof s.shadow === 'string' ? s.shadow : '#090910';
        for (const [gx, gy, c] of cells) {
          if (c.bg) {
            putCell(ox + gx + 1, oy + gy + 1, {bg: shadowHex, fg: shadowHex, ch: ' ', a: 0.35 * m}, 0, 0);
          }
        }
      }

      if (s.halo && s.art) {
        for (const [gx, gy] of haloOf(s.art)) {
          putCell(ox + gx, oy + gy, {fg: s.halo, a: 0.3 * m}, gx + k, gy);
        }
      }

      for (const [gx, gy, c, sx, sy] of cells) {
        putCell(ox + gx, oy + gy, m === 1 ? c : {...c, a: c.a * m}, sx, sy, subPhase);
      }
    }

    this.frameCounter++;
    this.lastRenderDurationMs = performance.now() - start;
    return grid;
  }
}

export {parseHexRgb, formatRgbHex};
