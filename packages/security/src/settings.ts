import {createHash} from 'node:crypto';
import {isAbsolute, resolve} from 'node:path';
import {
  DOMAIN_PATTERN,
  permissionModeSchema,
  permissionRuleSchema,
  type PermissionMode,
  type PermissionRuleSet,
} from '@cosmew/contracts';

/**
 * Claude Code style settings (ADR 0061): `~/.cosmew/settings.json` (user), `<project>/.cosmew/settings.json`
 * (project, shared) and `<project>/.cosmew/settings.local.json` (local); existing `.futryn`/`.hannes` roots remain
 * readable compatibility layers, with precedence local > project > user
 * (a `--permission-mode`/`--allowedTools` launch overlay is the highest). Pure: parsing, merging, trust
 * and the pieces of the sandbox derived from rules. File access belongs to the composition root.
 *
 * Cosmew addition: a file inside the repository is untrusted data. Until the user approved its exact
 * content (a hash), it can only TIGHTEN: deny and ask rules apply, but allow rules, a looser default
 * mode, a disabled sandbox, excluded commands, extra domains and extra directories are ignored.
 */

export type SettingsScope = 'user' | 'project' | 'local' | 'cli';
export const SETTINGS_SCOPES: readonly SettingsScope[] = ['user', 'project', 'local'];

export interface SettingsFile {
  permissions: {
    allow: string[];
    ask: string[];
    deny: string[];
    defaultMode?: PermissionMode;
    additionalDirectories: string[];
  };
  sandbox: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    excludedCommands: string[];
    allowUnsandboxedCommands?: boolean;
    allowedDomains: string[];
  };
}

export const emptySettingsFile = (): SettingsFile => ({
  permissions: {allow: [], ask: [], deny: [], additionalDirectories: []},
  sandbox: {excludedCommands: [], allowedDomains: []},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Content hash that identifies the exact text of a settings file. */
export const settingsHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Lenient read: invalid fields are dropped with a diagnostic; invalid JSON gives an empty file. */
export function parseSettings(text: string): {
  settings: SettingsFile;
  diagnostics: string[];
  raw: Record<string, unknown>;
} {
  const settings = emptySettingsFile();
  const diagnostics: string[] = [];
  let raw: unknown;
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return {settings, raw: {}, diagnostics: ['not valid JSON; the file is ignored']};
  }
  if (!isRecord(raw)) return {settings, raw: {}, diagnostics: ['the top level must be an object; the file is ignored']};
  const strings = (value: unknown, label: string, accept: (item: string) => string | null): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      diagnostics.push(`${label} must be an array of strings`);
      return [];
    }
    const out: string[] = [];
    for (const item of value) {
      const accepted = typeof item === 'string' ? accept(item.trim()) : null;
      if (accepted === null) diagnostics.push(`${label}: ignored invalid entry ${JSON.stringify(item).slice(0, 80)}`);
      else if (!out.includes(accepted)) out.push(accepted);
    }
    return out.slice(0, 200);
  };
  const rule = (item: string) => {
    const parsed = permissionRuleSchema.safeParse(item);
    return parsed.success ? parsed.data : null;
  };
  const permissions = raw.permissions;
  if (permissions !== undefined) {
    if (!isRecord(permissions)) diagnostics.push('permissions must be an object');
    else {
      settings.permissions.allow = strings(permissions.allow, 'permissions.allow', rule);
      settings.permissions.ask = strings(permissions.ask, 'permissions.ask', rule);
      settings.permissions.deny = strings(permissions.deny, 'permissions.deny', rule);
      settings.permissions.additionalDirectories = strings(
        permissions.additionalDirectories,
        'permissions.additionalDirectories',
        item => (item && !/[\u0000-\u001f]/.test(item) ? item : null),
      );
      if (permissions.defaultMode !== undefined) {
        const mode = permissionModeSchema.safeParse(permissions.defaultMode);
        if (mode.success) settings.permissions.defaultMode = mode.data;
        else diagnostics.push('permissions.defaultMode must be default, acceptEdits, plan or bypassPermissions');
      }
    }
  }
  const sandbox = raw.sandbox;
  if (sandbox !== undefined) {
    if (!isRecord(sandbox)) diagnostics.push('sandbox must be an object');
    else {
      for (const key of ['enabled', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands'] as const) {
        const value = sandbox[key];
        if (value === undefined) continue;
        if (typeof value === 'boolean') settings.sandbox[key] = value;
        else diagnostics.push(`sandbox.${key} must be true or false`);
      }
      settings.sandbox.excludedCommands = strings(sandbox.excludedCommands, 'sandbox.excludedCommands', item =>
        item && item.length <= 200 && !/[\u0000-\u001f]/.test(item) ? item : null,
      );
      const network = sandbox.network;
      if (network !== undefined) {
        if (!isRecord(network)) diagnostics.push('sandbox.network must be an object');
        else
          settings.sandbox.allowedDomains = strings(network.allowedDomains, 'sandbox.network.allowedDomains', item => {
            const domain = item.toLowerCase();
            return DOMAIN_PATTERN.test(domain) ? domain : null;
          });
      }
    }
  }
  return {settings, diagnostics, raw};
}

/** What a file would grant beyond tightening, in words for the trust prompt. Empty = nothing to approve. */
export function describeLoosening(file: SettingsFile): string[] {
  const lines: string[] = [];
  for (const rule of file.permissions.allow) lines.push(`allow rule: ${rule}`);
  const mode = file.permissions.defaultMode;
  if (mode === 'acceptEdits' || mode === 'bypassPermissions') lines.push(`defaultMode: ${mode}`);
  for (const dir of file.permissions.additionalDirectories) lines.push(`additional directory: ${dir}`);
  if (file.sandbox.enabled === false) lines.push('sandbox.enabled: false (commands run without the OS sandbox)');
  if (file.sandbox.autoAllowBashIfSandboxed === true) lines.push('sandbox.autoAllowBashIfSandboxed: true');
  if (file.sandbox.allowUnsandboxedCommands === true) lines.push('sandbox.allowUnsandboxedCommands: true');
  for (const command of file.sandbox.excludedCommands) lines.push(`excluded from the sandbox: ${command}`);
  for (const domain of file.sandbox.allowedDomains) lines.push(`network domain: ${domain}`);
  return lines;
}

export interface SettingsLayer {
  scope: SettingsScope;
  file: SettingsFile;
  /** User-owned input (user settings, CLI flags) or a repository file the user approved by hash. */
  trusted: boolean;
  /** Directory relative `additionalDirectories` resolve against. */
  baseDir: string;
}

export interface EffectiveSettings {
  rules: PermissionRuleSet;
  defaultMode?: PermissionMode;
  /** Absolute directories whose files commands and edits may change besides the working directory. */
  additionalDirectories: string[];
  sandbox: {
    enabled: boolean;
    autoAllowBashIfSandboxed: boolean;
    excludedCommands: string[];
    allowUnsandboxedCommands: boolean;
    allowedDomains: string[];
  };
}

const PRECEDENCE: Record<SettingsScope, number> = {cli: 3, local: 2, project: 1, user: 0};
const unique = (items: string[]) => [...new Set(items)];

/** Merge layers: deny/ask always, everything that loosens only from trusted layers. */
export function mergeSettings(layers: readonly SettingsLayer[], home: string): EffectiveSettings {
  const ordered = [...layers].sort((a, b) => PRECEDENCE[b.scope] - PRECEDENCE[a.scope]);
  const trusted = ordered.filter(layer => layer.trusted);
  const first = <T>(
    pick: (layer: SettingsLayer) => T | undefined,
    tightening: (value: T) => boolean,
  ): T | undefined => {
    for (const layer of ordered) {
      const value = pick(layer);
      if (value !== undefined && (layer.trusted || tightening(value))) return value;
    }
    return undefined;
  };
  const expand = (layer: SettingsLayer, dir: string) =>
    dir === '~' || dir.startsWith('~/')
      ? resolve(home, dir.slice(2))
      : isAbsolute(dir)
        ? resolve(dir)
        : resolve(layer.baseDir, dir);
  const defaultMode = first(
    layer => layer.file.permissions.defaultMode,
    mode => mode === 'default' || mode === 'plan',
  );
  return {
    rules: {
      allow: unique(trusted.flatMap(layer => layer.file.permissions.allow)).slice(0, 400),
      ask: unique(ordered.flatMap(layer => layer.file.permissions.ask)).slice(0, 400),
      deny: unique(ordered.flatMap(layer => layer.file.permissions.deny)).slice(0, 400),
    },
    ...(defaultMode ? {defaultMode} : {}),
    additionalDirectories: unique(
      trusted.flatMap(layer => layer.file.permissions.additionalDirectories.map(dir => expand(layer, dir))),
    ),
    sandbox: {
      enabled:
        first(
          layer => layer.file.sandbox.enabled,
          value => value === true,
        ) ?? false,
      autoAllowBashIfSandboxed:
        first(
          layer => layer.file.sandbox.autoAllowBashIfSandboxed,
          value => value === false,
        ) ?? false,
      excludedCommands: unique(trusted.flatMap(layer => layer.file.sandbox.excludedCommands)),
      allowUnsandboxedCommands:
        first(
          layer => layer.file.sandbox.allowUnsandboxedCommands,
          value => value === false,
        ) ?? true,
      allowedDomains: unique(trusted.flatMap(layer => layer.file.sandbox.allowedDomains)),
    },
  };
}

/**
 * Split a `--allowedTools` / `--disallowedTools` value (comma or space separated, as Claude Code)
 * into rules, keeping `Bash(git log:*)` together. Invalid entries are returned separately.
 */
export function splitRuleList(values: readonly string[]): {rules: string[]; invalid: string[]} {
  const rules: string[] = [];
  const invalid: string[] = [];
  for (const value of values) {
    let depth = 0;
    let current = '';
    const flush = () => {
      const item = current.trim();
      current = '';
      if (!item) return;
      const parsed = permissionRuleSchema.safeParse(item);
      if (parsed.success) rules.push(parsed.data);
      else invalid.push(item);
    };
    for (const ch of value) {
      if (ch === '(') depth++;
      if (ch === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && (ch === ',' || /\s/.test(ch))) flush();
      else current += ch;
    }
    flush();
  }
  return {rules, invalid};
}

/** Does a command match one `sandbox.excludedCommands` entry (`git`, `docker:*`, `npm run *`)? */
export function matchesExcludedCommand(pattern: string, command: string): boolean {
  const text = command.trim();
  const head = pattern.endsWith(':*') ? pattern.slice(0, -2) : pattern;
  if (head.includes('*')) {
    return new RegExp(
      '^' +
        head
          .split('*')
          .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    ).test(text);
  }
  return text === head || text.startsWith(head + ' ');
}

/** Absolute filesystem globs the OS sandbox must hide or protect, from `Read(...)`/`Edit(...)` rules. */
export function sandboxPathGlobs(
  rules: readonly string[],
  tool: 'Read' | 'Edit',
  workspace: string,
  home: string,
): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const match = /^(Read|Edit)\((.+)\)$/.exec(rule);
    if (!match || match[1] !== tool) continue;
    const pattern = match[2]!.trim();
    if (pattern.startsWith('//')) out.push(pattern.slice(1));
    else if (pattern === '~' || pattern.startsWith('~/')) out.push(home.replace(/\/+$/, '') + pattern.slice(1));
    else if (pattern.startsWith('/')) out.push(workspace + pattern);
    else out.push(workspace + '/' + pattern.replace(/^\.\//, ''));
  }
  return out;
}
