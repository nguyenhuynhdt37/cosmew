import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {isAbsolute, posix, resolve} from 'node:path';
import {
  DOMAIN_PATTERN,
  HOOK_EVENTS,
  permissionModeSchema,
  permissionRuleSchema,
  type ConfiguredHook,
  type HookCommandDefinition,
  type HookEventName,
  type HookMatcherEntry,
  type HooksConfig,
  type PermissionMode,
  type PermissionRuleSet,
} from '@cosmew/contracts';

/**
 * Claude Code style settings (ADR 0061): `~/.cosmew/settings.json` (user), `<project>/.cosmew/settings.json`
 * (project, shared) and `<project>/.cosmew/settings.local.json` (local). Precedence is local > project > user
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
  hooks: HooksConfig;
}

export const emptySettingsFile = (): SettingsFile => ({
  permissions: {allow: [], ask: [], deny: [], additionalDirectories: []},
  sandbox: {excludedCommands: [], allowedDomains: []},
  hooks: {},
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
  const hooksRaw = raw.hooks;
  if (hooksRaw !== undefined) {
    if (!isRecord(hooksRaw)) diagnostics.push('hooks must be an object');
    else {
      let totalHooks = 0;
      const MAX_HOOKS_PER_FILE = 50;
      for (const [eventName, entriesValue] of Object.entries(hooksRaw)) {
        if (!(HOOK_EVENTS as readonly string[]).includes(eventName)) {
          diagnostics.push(`hooks.${eventName} is not a supported hook event`);
          continue;
        }
        const event = eventName as HookEventName;
        if (!Array.isArray(entriesValue)) {
          diagnostics.push(`hooks.${event} must be an array`);
          continue;
        }
        const parsedEntries: HookMatcherEntry[] = [];
        for (const entryValue of entriesValue) {
          if (!isRecord(entryValue)) {
            diagnostics.push(`hooks.${event}: ignored non-object matcher entry`);
            continue;
          }
          let matcher: string | undefined;
          if (entryValue.matcher !== undefined) {
            if (
              typeof entryValue.matcher !== 'string' ||
              entryValue.matcher.length > 200 ||
              /[\u0000-\u001f]/.test(entryValue.matcher)
            ) {
              diagnostics.push(`hooks.${event}: ignored entry with invalid matcher`);
              continue;
            }
            const trimmed = entryValue.matcher.trim();
            if (trimmed) matcher = trimmed;
          }
          if (!Array.isArray(entryValue.hooks)) {
            diagnostics.push(`hooks.${event}: entry hooks must be an array`);
            continue;
          }
          const parsedHooks: HookCommandDefinition[] = [];
          for (const hookValue of entryValue.hooks) {
            if (totalHooks >= MAX_HOOKS_PER_FILE) {
              diagnostics.push(`hooks: ignored entries beyond limit of ${MAX_HOOKS_PER_FILE}`);
              break;
            }
            if (!isRecord(hookValue) || hookValue.type !== 'command' || typeof hookValue.command !== 'string') {
              diagnostics.push(`hooks.${event}: ignored hook (only {type: "command", command} is supported)`);
              continue;
            }
            const command = hookValue.command.trim();
            if (!command || command.length > 2000 || command.includes('\u0000')) {
              diagnostics.push(`hooks.${event}: ignored hook with empty or invalid command`);
              continue;
            }
            let timeout: number | undefined;
            if (hookValue.timeout !== undefined) {
              if (
                typeof hookValue.timeout !== 'number' ||
                !Number.isFinite(hookValue.timeout) ||
                hookValue.timeout < 1 ||
                hookValue.timeout > 60
              ) {
                diagnostics.push(`hooks.${event}: ignored hook with invalid timeout (must be 1..60 seconds)`);
                continue;
              }
              timeout = hookValue.timeout;
            }
            parsedHooks.push({type: 'command', command, ...(timeout !== undefined ? {timeout} : {})});
            totalHooks++;
          }
          if (parsedHooks.length) {
            parsedEntries.push({...(matcher ? {matcher} : {}), hooks: parsedHooks});
          }
        }
        if (parsedEntries.length) settings.hooks[event] = parsedEntries;
      }
    }
  }
  return {settings, diagnostics, raw};
}

/** Total configured command hooks in a parsed settings file. */
export function countSettingsHooks(file: SettingsFile): number {
  let count = 0;
  for (const event of HOOK_EVENTS) {
    for (const entry of file.hooks[event] ?? []) count += entry.hooks.length;
  }
  return count;
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
  for (const event of HOOK_EVENTS) {
    for (const entry of file.hooks[event] ?? []) {
      for (const hook of entry.hooks) {
        const target = entry.matcher ? `, matcher: ${entry.matcher}` : '';
        const preview = hook.command.length > 120 ? hook.command.slice(0, 117) + '...' : hook.command;
        lines.push(`hook (${event}${target}): ${preview}`);
      }
    }
  }
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
  /** Trusted lifecycle hooks merged in execution order (user -> project -> local). */
  hooks: ConfiguredHook[];
}

const PRECEDENCE: Record<SettingsScope, number> = {cli: 3, local: 2, project: 1, user: 0};
const MODE_STRICTNESS: Record<PermissionMode, number> = {
  bypassPermissions: 0,
  acceptEdits: 1,
  default: 2,
  plan: 3,
};
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
  let defaultMode: PermissionMode | undefined;
  let untrustedFloor = 0;
  for (const layer of ordered) {
    const mode = layer.file.permissions.defaultMode;
    if (!mode) continue;
    if (layer.trusted) {
      if (!defaultMode || MODE_STRICTNESS[mode] > MODE_STRICTNESS[defaultMode]) defaultMode = mode;
      break;
    }
    if ((mode === 'default' || mode === 'plan') && MODE_STRICTNESS[mode] > untrustedFloor) {
      untrustedFloor = MODE_STRICTNESS[mode];
      defaultMode = mode;
    }
  }
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
    hooks: [...trusted]
      .reverse()
      .filter((layer): layer is SettingsLayer & {scope: 'user' | 'project' | 'local'} => layer.scope !== 'cli')
      .flatMap(layer =>
        HOOK_EVENTS.flatMap(event =>
          (layer.file.hooks[event] ?? []).flatMap(entry =>
            entry.hooks.map(hook => ({
              scope: layer.scope,
              event,
              ...(entry.matcher ? {matcher: entry.matcher} : {}),
              command: hook.command,
              timeoutMs: Math.round((hook.timeout ?? 10) * 1000),
            })),
          ),
        ),
      ),
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

/** Linear-time glob match for `*` wildcards without dynamic regex backtracking. */
function matchWildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let backtrack = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      backtrack = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++backtrack;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Does a command match one `sandbox.excludedCommands` entry (`git`, `docker:*`, `npm run *`)? */
export function matchesExcludedCommand(pattern: string, command: string): boolean {
  const text = command.trim();
  const head = pattern.endsWith(':*') ? pattern.slice(0, -2) : pattern;
  if (head.includes('*')) return matchWildcard(head, text);
  return text === head || text.startsWith(head + ' ');
}

const HOOK_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  exec_command: ['exec_command', 'Bash'],
  write_stdin: ['write_stdin', 'Bash'],
  edit: ['edit', 'Edit'],
  write: ['write', 'Write'],
  apply_patch: ['apply_patch', 'Edit', 'Write'],
  read: ['read', 'Read'],
  grep: ['grep', 'Grep'],
  glob: ['glob', 'Glob'],
  web_fetch: ['web_fetch', 'WebFetch'],
  web_search: ['web_search', 'WebSearch'],
  agent: ['agent', 'Agent', 'Task'],
  skill: ['skill', 'Skill'],
};

/**
 * Matches a hook `matcher` (`*`, `Bash|Edit`, `mcp__github__*`, or exact name) against a tool name
 * and its Claude Code canonical aliases using linear-time wildcard matching (no ReDoS).
 */
export function matchesHookMatcher(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*') return true;
  if (!toolName) return false;
  const candidates = HOOK_TOOL_ALIASES[toolName] ?? [toolName];
  for (const rawBranch of matcher.split('|')) {
    const branch = rawBranch.trim();
    if (!branch) continue;
    if (branch === '*') return true;
    for (const candidate of candidates) {
      if (branch.includes('*') ? matchWildcard(branch, candidate) : branch === candidate) return true;
    }
  }
  return false;
}

function canonicalVariants(base: string): string[] {
  const cleaned = posix.normalize(base.replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
  const variants = [cleaned];
  try {
    const real = realpathSync.native(base).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    if (!variants.includes(real)) variants.push(real);
  } catch {
    /* non-existent path in unit tests keeps its logical base */
  }
  return variants;
}

function normalizeAbsoluteGlob(raw: string): string {
  const normalized = posix.normalize(raw.replace(/\\/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** Absolute filesystem globs the OS sandbox must hide or protect, from `Read(...)`/`Edit(...)` rules. */
export function sandboxPathGlobs(
  rules: readonly string[],
  tool: 'Read' | 'Edit',
  workspace: string,
  home: string,
): string[] {
  const workspaces = canonicalVariants(workspace);
  const homes = canonicalVariants(home);
  const out = new Set<string>();
  for (const rule of rules) {
    const match = /^(Read|Edit)\((.+)\)$/.exec(rule);
    if (!match || match[1] !== tool) continue;
    const pattern = match[2]!.trim();
    if (pattern.startsWith('//')) {
      out.add(normalizeAbsoluteGlob(pattern.slice(1)));
    } else if (pattern === '~' || pattern.startsWith('~/')) {
      const tail = pattern.slice(1);
      for (const h of homes) out.add(normalizeAbsoluteGlob(h + tail));
    } else if (pattern.startsWith('/')) {
      for (const ws of workspaces) out.add(normalizeAbsoluteGlob(ws + pattern));
    } else {
      const rel = pattern.replace(/^\.\//, '');
      for (const ws of workspaces) out.add(normalizeAbsoluteGlob(ws + '/' + rel));
    }
  }
  return [...out];
}
