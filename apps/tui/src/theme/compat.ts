import {
  FutrynError,
  WALLPAPER_PRESET_IDS,
  compatibilityReportSchema,
  hexColorSchema,
  themeIdSchema,
  themeManifestSchema,
  type BorderStyle,
  type CompatibilityReport,
  type ThemeManifest,
  type ThemeTokens,
} from '@futryn/contracts';
import { ALL_BUILTIN_THEMES, deriveTokensFromTriplet, mixHex, relativeLuminance } from './presets';

export interface ThemeImportResult {
  manifest: ThemeManifest | null;
  report: CompatibilityReport;
}

const BUILTIN_IDS = new Set(ALL_BUILTIN_THEMES.map(t => t.id));
const VALID_WALLPAPERS = new Set<string>(WALLPAPER_PRESET_IDS);

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function sanitizeId(raw: unknown, fallback = 'imported-theme'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!cleaned || !/^[a-z]/.test(cleaned)) return fallback;
  return cleaned.length >= 2 ? cleaned : `${cleaned}-theme`;
}

/**
 * Convert an OpenCode theme JSON (`{ defs?: Record<string, string>, theme: Record<string, string | { dark: string, light: string }> }`)
 * into a native FUTRYN `ThemeManifest` with a detailed `CompatibilityReport`.
 */
function convertOpenCodeTheme(raw: Record<string, unknown>, suggestedId?: string): ThemeImportResult {
  const defs = (raw.defs && typeof raw.defs === 'object' ? raw.defs : {}) as Record<string, unknown>;
  const themeObj = raw.theme as Record<string, unknown>;
  const converted: string[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];

  const resolveColor = (key: string, mode: 'dark' | 'light'): string | undefined => {
    const entry = themeObj[key];
    if (!entry) return undefined;
    let ref: unknown;
    if (typeof entry === 'string') {
      ref = entry;
    } else if (typeof entry === 'object' && entry !== null) {
      ref = (entry as Record<string, unknown>)[mode];
    }
    if (typeof ref !== 'string') return undefined;
    if (isHex(ref)) return ref.toLowerCase();
    const fromDefs = defs[ref];
    if (isHex(fromDefs)) return fromDefs.toLowerCase();
    return undefined;
  };

  for (const key of Object.keys(themeObj)) {
    const d = resolveColor(key, 'dark');
    const l = resolveColor(key, 'light');
    if (d || l) converted.push(`theme.${key}`);
    else unsupported.push(`theme.${key}`);
  }

  const darkBg = resolveColor('background', 'dark') ?? '#0a0a0a';
  const darkFg = resolveColor('text', 'dark') ?? '#eeeeee';
  const darkAccent = resolveColor('accent', 'dark') ?? resolveColor('primary', 'dark') ?? '#fab283';

  const lightBg = resolveColor('background', 'light') ?? '#ffffff';
  const lightFg = resolveColor('text', 'light') ?? '#1a1a1a';
  const lightAccent = resolveColor('accent', 'light') ?? resolveColor('primary', 'light') ?? '#3b7dd8';

  const mapModeTokens = (mode: 'dark' | 'light', bg: string, fg: string, accent: string): Partial<ThemeTokens> => {
    const pick = (k: string) => resolveColor(k, mode);
    const out: Partial<ThemeTokens> = {};
    if (pick('background')) out.background = pick('background');
    if (pick('backgroundPanel')) out.backgroundPanel = pick('backgroundPanel');
    if (pick('backgroundElement')) out.backgroundElevated = pick('backgroundElement');
    if (pick('text')) out.foreground = pick('text');
    if (pick('textMuted')) out.foregroundMuted = pick('textMuted');
    if (pick('borderSubtle')) out.foregroundSubtle = pick('borderSubtle');
    if (pick('accent') ?? pick('primary')) out.accent = pick('accent') ?? pick('primary');
    if (pick('border')) out.border = pick('border');
    if (pick('borderActive')) out.borderFocused = pick('borderActive');
    if (pick('error')) out.error = pick('error');
    if (pick('warning')) out.warning = pick('warning');
    if (pick('success')) out.success = pick('success');
    if (pick('info')) out.info = pick('info');
    if (pick('diffAdded')) out.diffAdded = pick('diffAdded');
    if (pick('diffRemoved')) out.diffRemoved = pick('diffRemoved');
    if (pick('diffContext')) out.diffContext = pick('diffContext');
    if (pick('syntaxKeyword')) out.syntaxKeyword = pick('syntaxKeyword');
    if (pick('syntaxString')) out.syntaxString = pick('syntaxString');
    if (pick('syntaxComment')) out.syntaxComment = pick('syntaxComment');
    if (pick('syntaxFunction')) out.syntaxFunction = pick('syntaxFunction');
    if (pick('markdownHeading')) out.markdownHeading = pick('markdownHeading');
    if (pick('markdownCode')) out.markdownCode = pick('markdownCode');
    return deriveTokensFromTriplet(bg, fg, accent, out);
  };

  let id = sanitizeId(raw.id ?? suggestedId ?? 'opencode-custom');
  if (BUILTIN_IDS.has(id)) {
    warnings.push(`Theme ID "${id}" conflicts with a built-in preset; renamed to "${id}-custom".`);
    id = `${id}-custom`;
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : `OpenCode (${id})`;
  const attribution = typeof raw.attribution === 'string' ? raw.attribution : 'Imported from OpenCode theme JSON format';

  const manifest = themeManifestSchema.parse({
    schemaVersion: 1,
    id,
    name,
    category: 'custom',
    description: typeof raw.description === 'string' ? raw.description.slice(0, 240) : 'Imported OpenCode color theme',
    attribution,
    sourceFormat: 'opencode',
    builtIn: false,
    defaultMode: 'dark',
    borderStyle: 'soft',
    wallpaper: null,
    dark: mapModeTokens('dark', darkBg, darkFg, darkAccent),
    light: mapModeTokens('light', lightBg, lightFg, lightAccent),
  });

  return {
    manifest,
    report: compatibilityReportSchema.parse({
      sourceFormat: 'opencode',
      compatible: true,
      themeId: manifest.id,
      convertedProperties: converted,
      unsupportedProperties: unsupported,
      warnings,
      refusedExecutableContent: false,
      attribution,
    }),
  };
}

/**
 * Convert a Claude Desktop Themes JSON (`{ id, name, tagline, bg, text, accent, font?, vars?, deco?, wallpaper?, css? }`)
 * into a native FUTRYN `ThemeManifest` with explicit compatibility reporting.
 */
function convertClaudeDesktopTheme(
  raw: Record<string, unknown>,
  externalCss?: string,
  hasExternalSceneJs = false,
): ThemeImportResult {
  const converted: string[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];
  let refusedExecutableContent = false;

  const rawId = typeof raw.id === 'string' ? raw.id : '';
  const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
  const bg = raw.bg;
  const text = raw.text;
  const accent = raw.accent;

  if (!/^[a-z][a-z0-9-]{1,40}$/.test(rawId) || !rawName || !isHex(bg) || !isHex(text) || !isHex(accent)) {
    return {
      manifest: null,
      report: compatibilityReportSchema.parse({
        sourceFormat: 'claude-desktop',
        compatible: false,
        convertedProperties: [],
        unsupportedProperties: [],
        warnings: ['Invalid Claude Desktop Theme: requires valid id, name, and #rrggbb hex values for bg, text, and accent.'],
        refusedExecutableContent: hasExternalSceneJs,
      }),
    };
  }

  converted.push('id', 'name', 'bg', 'text', 'accent');
  if (typeof raw.tagline === 'string') converted.push('tagline -> description');

  let id = rawId;
  if (BUILTIN_IDS.has(id)) {
    return {
      manifest: null,
      report: compatibilityReportSchema.parse({
        sourceFormat: 'claude-desktop',
        compatible: false,
        convertedProperties: [],
        unsupportedProperties: [],
        warnings: [`Theme ID "${id}" is reserved by an immutable built-in theme and cannot be overwritten.`],
        refusedExecutableContent: hasExternalSceneJs,
      }),
    };
  }

  if (typeof raw.font === 'string' && raw.font.trim()) {
    unsupported.push('font (terminal emulator controls font family)');
    warnings.push(`Desktop CSS font "${raw.font}" cannot be applied inside a terminal emulator; using terminal font.`);
  }

  if (typeof raw.deco === 'string' && raw.deco.trim()) {
    unsupported.push('deco (desktop SVG tile markup)');
  }

  if (typeof raw.thumb === 'string' && raw.thumb.trim()) {
    unsupported.push('thumb (desktop raster image data URL)');
  }

  let borderStyle: BorderStyle = 'soft';
  let greeting: string | undefined;

  if (raw.vars && typeof raw.vars === 'object') {
    const vars = raw.vars as Record<string, unknown>;
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== 'string') {
        unsupported.push(`vars.${k}`);
        continue;
      }
      if (/[;{}<>]/.test(v) || (/url\s*\(/i.test(v) && !/url\(\s*['"]?data:/i.test(v))) {
        refusedExecutableContent = true;
        unsupported.push(`vars.${k} (unsafe CSS value refused)`);
        warnings.push(`Refused unsafe CSS variable "${k}".`);
        continue;
      }
      if (k === 'cds-radius') {
        borderStyle = v === '0px' ? 'sharp' : parseFloat(v) <= 4 ? 'double' : 'soft';
        converted.push(`vars.cds-radius (${v}) -> borderStyle (${borderStyle})`);
      } else if (k === 'wall-greet') {
        try {
          const parsedGreet = JSON.parse(v);
          if (typeof parsedGreet === 'string') greeting = parsedGreet.slice(0, 120);
        } catch {
          greeting = v.replace(/^['"]|['"]$/g, '').slice(0, 120);
        }
        converted.push('vars.wall-greet -> greeting');
      } else if (k === 'wall-halo' || k === 'wall-rim' || k === 'wall-glass' || k === 'wall-sky') {
        converted.push(`vars.${k} (mapped to terminal backdrop/veil tokens)`);
      } else {
        unsupported.push(`vars.${k} (desktop-only CSS token)`);
      }
    }
  }

  const combinedCss = [typeof raw.css === 'string' ? raw.css : '', externalCss ?? ''].filter(Boolean).join('\n');
  if (combinedCss) {
    unsupported.push('css (DOM stylesheet rules are not injected into terminal renderer)');
    if (/@import\b/i.test(combinedCss) || /url\s*\(\s*['"]?(?!data:)/i.test(combinedCss) || /\\/.test(combinedCss)) {
      refusedExecutableContent = true;
      warnings.push('Refused unsafe CSS containing external @import, remote url(), or escape sequences.');
    } else {
      warnings.push('Desktop CSS rules were inspected and ignored; terminal uses semantic color tokens and native reactive effects.');
    }
  }

  if (hasExternalSceneJs || typeof raw.scene === 'string') {
    refusedExecutableContent = true;
    unsupported.push('scene.js (arbitrary JavaScript wallpaper execution is forbidden in FUTRYN)');
    warnings.push('Refused arbitrary JavaScript scene file: FUTRYN only executes declarative built-in terminal scenes.');
  }

  let wallpaper: string | null = null;
  if (typeof raw.wallpaper === 'string' && raw.wallpaper.trim()) {
    const requested = raw.wallpaper.trim().toLowerCase();
    const mapped = requested === 'clawd' ? 'futryn-spark' : requested;
    if (VALID_WALLPAPERS.has(mapped)) {
      wallpaper = mapped;
      converted.push(`wallpaper (${requested} -> ${mapped})`);
    } else {
      unsupported.push(`wallpaper (${requested} is not a built-in declarative terminal scene)`);
      warnings.push(`Custom wallpaper "${requested}" is not a built-in declarative scene; falling back to static theme colors.`);
    }
  }

  const isLightPrimary = relativeLuminance(bg) > 0.45;
  const primaryTokens = deriveTokensFromTriplet(bg, text, accent);
  const counterpartBg = isLightPrimary ? mixHex('#121318', bg, 0.12) : mixHex('#f7f5f0', bg, 0.12);
  const counterpartText = isLightPrimary ? mixHex('#f2efe9', text, 0.15) : mixHex('#22201d', text, 0.15);
  const counterpartTokens = deriveTokensFromTriplet(counterpartBg, counterpartText, accent);

  const attribution =
    typeof raw.attribution === 'string'
      ? raw.attribution
      : `Imported from Claude Desktop Themes format (${rawName})`;

  const manifest = themeManifestSchema.parse({
    schemaVersion: 1,
    id,
    name: rawName.slice(0, 80),
    category: 'custom',
    description: typeof raw.tagline === 'string' ? raw.tagline.slice(0, 240) : 'Imported Claude Desktop theme',
    attribution,
    sourceFormat: 'claude-desktop',
    builtIn: false,
    defaultMode: isLightPrimary ? 'light' : 'dark',
    borderStyle,
    wallpaper,
    greeting,
    dark: isLightPrimary ? counterpartTokens : primaryTokens,
    light: isLightPrimary ? primaryTokens : counterpartTokens,
  });

  return {
    manifest,
    report: compatibilityReportSchema.parse({
      sourceFormat: 'claude-desktop',
      compatible: true,
      themeId: manifest.id,
      convertedProperties: converted,
      unsupportedProperties: unsupported,
      warnings,
      refusedExecutableContent,
      attribution,
    }),
  };
}

/**
 * Inspect and import a theme from JSON string or parsed object.
 * Supports:
 * 1. Native FUTRYN ThemeManifest JSON (`schemaVersion: 1`, `dark`, `light`)
 * 2. OpenCode Theme JSON (`defs` + `theme`)
 * 3. Claude Desktop Themes JSON (`id`, `name`, `bg`, `text`, `accent`, `vars`, etc.)
 */
export function importThemeManifest(
  input: string | unknown,
  options?: { externalCss?: string; hasExternalSceneJs?: boolean; suggestedId?: string },
): ThemeImportResult {
  let parsed: unknown;
  if (typeof input === 'string') {
    if (input.length > 262144) {
      return {
        manifest: null,
        report: compatibilityReportSchema.parse({
          sourceFormat: 'unknown',
          compatible: false,
          convertedProperties: [],
          unsupportedProperties: [],
          warnings: ['Theme input exceeds 256 KiB size limit.'],
          refusedExecutableContent: false,
        }),
      };
    }
    try {
      parsed = JSON.parse(input);
    } catch {
      return {
        manifest: null,
        report: compatibilityReportSchema.parse({
          sourceFormat: 'unknown',
          compatible: false,
          convertedProperties: [],
          unsupportedProperties: [],
          warnings: ['Malformed JSON: unable to parse theme definition.'],
          refusedExecutableContent: false,
        }),
      };
    }
  } else {
    parsed = input;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      manifest: null,
      report: compatibilityReportSchema.parse({
        sourceFormat: 'unknown',
        compatible: false,
        convertedProperties: [],
        unsupportedProperties: [],
        warnings: ['Theme definition must be a JSON object.'],
        refusedExecutableContent: false,
      }),
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Reject any object with prototype pollution or executable script fields
  if (
    Object.prototype.hasOwnProperty.call(obj, '__proto__') ||
    Object.prototype.hasOwnProperty.call(obj, 'constructor') ||
    typeof obj.execute === 'string' ||
    typeof obj.script === 'string'
  ) {
    return {
      manifest: null,
      report: compatibilityReportSchema.parse({
        sourceFormat: 'unknown',
        compatible: false,
        convertedProperties: [],
        unsupportedProperties: ['executable/script fields'],
        warnings: ['Refused theme containing executable or unsafe prototype fields.'],
        refusedExecutableContent: true,
      }),
    };
  }

  // Case 1: Native FUTRYN Theme Manifest (`dark` and `light` token objects)
  if (obj.dark && typeof obj.dark === 'object' && obj.light && typeof obj.light === 'object') {
    if (obj.schemaVersion !== undefined && obj.schemaVersion !== 1) {
      return {
        manifest: null,
        report: compatibilityReportSchema.parse({
          sourceFormat: 'futryn',
          compatible: false,
          convertedProperties: [],
          unsupportedProperties: [`schemaVersion=${String(obj.schemaVersion)}`],
          warnings: [`Unsupported FUTRYN theme schemaVersion "${String(obj.schemaVersion)}"; only version 1 is supported.`],
          refusedExecutableContent: false,
        }),
      };
    }
    const idCheck = themeIdSchema.safeParse(obj.id);
    if (idCheck.success && BUILTIN_IDS.has(idCheck.data)) {
      return {
        manifest: null,
        report: compatibilityReportSchema.parse({
          sourceFormat: 'futryn',
          compatible: false,
          convertedProperties: [],
          unsupportedProperties: [],
          warnings: [`Theme ID "${idCheck.data}" is reserved by an immutable built-in theme.`],
          refusedExecutableContent: false,
        }),
      };
    }
    const candidate = themeManifestSchema.safeParse({
      ...obj,
      category: 'custom',
      builtIn: false,
      sourceFormat: 'futryn',
    });
    if (!candidate.success) {
      return {
        manifest: null,
        report: compatibilityReportSchema.parse({
          sourceFormat: 'futryn',
          compatible: false,
          convertedProperties: [],
          unsupportedProperties: candidate.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
          warnings: ['Native FUTRYN theme failed strict schema validation.'],
          refusedExecutableContent: false,
        }),
      };
    }
    return {
      manifest: candidate.data,
      report: compatibilityReportSchema.parse({
        sourceFormat: 'futryn',
        compatible: true,
        themeId: candidate.data.id,
        convertedProperties: ['id', 'name', 'dark.*', 'light.*', 'borderStyle', 'wallpaper'],
        unsupportedProperties: [],
        warnings: [],
        refusedExecutableContent: false,
        attribution: candidate.data.attribution ?? 'Native FUTRYN Theme v1',
      }),
    };
  }

  // Case 2: OpenCode Theme JSON (`theme` object with dark/light mappings and optional `defs`)
  if (obj.theme && typeof obj.theme === 'object' && !Array.isArray(obj.theme)) {
    return convertOpenCodeTheme(obj, options?.suggestedId);
  }

  // Case 3: Claude Desktop Themes JSON (`bg`, `text`, `accent`)
  if ('bg' in obj || 'text' in obj || 'accent' in obj || 'vars' in obj || 'tagline' in obj) {
    return convertClaudeDesktopTheme(obj, options?.externalCss, options?.hasExternalSceneJs);
  }

  return {
    manifest: null,
    report: compatibilityReportSchema.parse({
      sourceFormat: 'unknown',
      compatible: false,
      convertedProperties: [],
      unsupportedProperties: Object.keys(obj).slice(0, 30),
      warnings: ['Unrecognized theme format. Expected FUTRYN v1, OpenCode JSON, or Claude Desktop Themes JSON.'],
      refusedExecutableContent: false,
    }),
  };
}

export function validateHexColor(value: string): string {
  try {
    return hexColorSchema.parse(value);
  } catch {
    throw new FutrynError('INVALID_INPUT');
  }
}
