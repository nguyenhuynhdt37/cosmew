import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {
  FutrynError,
  permissionRuleSchema,
  type PendingSettingsTrust,
  type PermissionMode,
  type PermissionRuleEffect,
  type PermissionRuleSet,
  type PermissionSettingsFileInfo,
  type PermissionSettingsPort,
  type PermissionSettingsScope,
  type PermissionSettingsSnapshot,
  type SettingsStore,
  type SandboxSettingsPatch,
  DOMAIN_PATTERN,
} from '@cosmew/contracts';
import type {SandboxConfig} from '@cosmew/tools';
import {
  describeLoosening,
  emptySettingsFile,
  mergeSettings,
  parseSettings,
  sandboxPathGlobs,
  settingsHash,
  type SettingsFile,
  type SettingsLayer,
} from '@cosmew/security';

/**
 * The Claude Code style settings files (ADR 0061), owned by the composition root:
 * `<state directory>/settings.json` (user), `<project>/.cosmew/settings.json` and
 * `<project>/.cosmew/settings.local.json`. Existing `.futryn`/`.hannes` roots are compatibility layers. Precedence local > project > user; deny and ask rules of
 * every file apply, but a repository file (project/local) can loosen anything only after the user
 * approved its exact content (hash). Reads are cached by mtime/size so `status()` stays cheap.
 */

const MAX_BYTES = 64 * 1024;
const MAX_TRUSTED_HASHES = 50;

function projectSettingsDirectory(workspace: string): string {
  for (const name of ['.cosmew', '.futryn', '.hannes']) {
    const directory = join(workspace, name);
    if (existsSync(directory)) return directory;
  }
  return join(workspace, '.cosmew');
}

export interface FilePermissionSettingsOptions {
  /** Canonical working directory (project root). */
  workspace: string;
  /** Cosmew state directory; holds the user `settings.json`. */
  stateDirectory: string;
  store: SettingsStore;
  home?: string;
  /** Startup notice inspection must not migrate workspace rules. */
  migrateLegacyRules?: boolean;
  /** `--allowedTools` / `--disallowedTools` of this launch: a trusted, unstored overlay. */
  launch?: {allow?: readonly string[]; ask?: readonly string[]; deny?: readonly string[]};
}

interface Loaded {
  scope: PermissionSettingsScope;
  path: string;
  exists: boolean;
  text: string;
  hash: string;
  file: SettingsFile;
  diagnostics: string[];
}

const SCOPE_NAMES: Record<PermissionSettingsScope, string> = {user: 'user', project: 'project', local: 'local'};

export class FilePermissionSettings implements PermissionSettingsPort {
  private readonly home: string;
  private readonly paths: Record<PermissionSettingsScope, string>;
  private readonly cache = new Map<string, {key: string; loaded: Loaded}>();
  /** Content approved for this session only (`session` answer); never persisted. */
  private readonly sessionTrusted = new Set<string>();
  /** Notes about the legacy-rule migration, shown once as diagnostics. */
  private migration: string[] = [];

  constructor(private readonly options: FilePermissionSettingsOptions) {
    this.home = options.home ?? homedir();
    const projectDirectory = projectSettingsDirectory(options.workspace);
    this.paths = {
      user: join(options.stateDirectory, 'settings.json'),
      project: join(projectDirectory, 'settings.json'),
      local: join(projectDirectory, 'settings.local.json'),
    };
    if (options.migrateLegacyRules !== false) this.migrateLegacyRules();
  }

  /** Record before displaying, so successful startup never repeats the upgrade notice. */
  defaultsNotice(): string | undefined {
    const loaded = this.load('user');
    if (loaded.diagnostics.length) return undefined;
    const raw = parseSettings(loaded.text).raw;
    if (Object.hasOwn(raw, 'sandbox') || raw.sandboxDefaultsNoticeVersion === 1) return undefined;
    try {
      this.mutate('user', value => {
        value.sandboxDefaultsNoticeVersion = 1;
      });
    } catch {
      return undefined; // Do not claim a one-time notice was recorded when persistence failed.
    }
    return 'Sandbox is now off by default; shell commands use regular permissions. Run /sandbox to turn it on.';
  }

  pathOf(scope: PermissionSettingsScope): string {
    return this.paths[scope];
  }

  private load(scope: PermissionSettingsScope): Loaded {
    const path = this.paths[scope];
    let key = 'missing';
    let stat;
    try {
      stat = lstatSync(path);
      key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      /* no file */
    }
    const cached = this.cache.get(path);
    if (cached && cached.key === key) return cached.loaded;
    const loaded = this.read(scope, path, stat);
    this.cache.set(path, {key, loaded});
    return loaded;
  }

  private read(scope: PermissionSettingsScope, path: string, stat: ReturnType<typeof lstatSync> | undefined): Loaded {
    const empty = (diagnostic?: string): Loaded => ({
      scope,
      path,
      exists: stat !== undefined,
      text: '',
      hash: settingsHash(''),
      file: emptySettingsFile(),
      diagnostics: diagnostic ? [diagnostic] : [],
    });
    if (!stat) return empty();
    if (stat.isSymbolicLink() || !stat.isFile()) return empty('must be a regular file, not a link; ignored');
    if (stat.size > MAX_BYTES) return empty('is larger than 64 KiB; ignored');
    if (scope === 'user' && process.getuid && stat.uid !== process.getuid())
      return empty('is owned by another user; ignored');
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return empty('could not be read; ignored');
    }
    const parsed = parseSettings(text);
    return {
      scope,
      path,
      exists: true,
      text,
      hash: settingsHash(text),
      file: parsed.settings,
      diagnostics: parsed.diagnostics,
    };
  }

  private trustedHashes(path: string): string[] {
    return this.options.store.read().trustedProjectSettings?.[path] ?? [];
  }

  private isTrusted(loaded: Loaded): boolean {
    if (loaded.scope === 'user') return true;
    // A missing, empty or purely tightening file has nothing to approve; it is trusted by construction.
    return (
      !loaded.exists ||
      describeLoosening(loaded.file).length === 0 ||
      this.trustedHashes(loaded.path).includes(loaded.hash) ||
      this.sessionTrusted.has(`${loaded.path}\0${loaded.hash}`)
    );
  }

  snapshot(): PermissionSettingsSnapshot {
    const loaded = (['user', 'project', 'local'] as const).map(scope => this.load(scope));
    const layers: SettingsLayer[] = loaded.map(item => ({
      scope: item.scope,
      file: item.file,
      trusted: this.isTrusted(item),
      baseDir: item.scope === 'user' ? this.home : this.options.workspace,
    }));
    const launch = this.options.launch;
    if (launch || this.legacyOverlay) {
      const file = emptySettingsFile();
      file.permissions.allow = [...(launch?.allow ?? []), ...(this.legacyOverlay?.allow ?? [])];
      file.permissions.ask = [...(launch?.ask ?? []), ...(this.legacyOverlay?.ask ?? [])];
      file.permissions.deny = [...(launch?.deny ?? []), ...(this.legacyOverlay?.deny ?? [])];
      layers.push({scope: 'cli', file, trusted: true, baseDir: this.options.workspace});
    }
    const merged = mergeSettings(layers, this.home);
    const pendingTrust: PendingSettingsTrust[] = [];
    const files: PermissionSettingsFileInfo[] = loaded.map((item, index) => {
      const trusted = layers[index]!.trusted;
      if (!trusted && item.scope !== 'user')
        pendingTrust.push({
          scope: item.scope,
          path: item.path,
          hash: item.hash,
          grants: describeLoosening(item.file),
        });
      return {
        scope: item.scope,
        path: item.path,
        exists: item.exists,
        trusted,
        rules: {
          allow: [...item.file.permissions.allow],
          ask: [...item.file.permissions.ask],
          deny: [...item.file.permissions.deny],
        },
        ...(item.file.permissions.defaultMode ? {defaultMode: item.file.permissions.defaultMode} : {}),
        allowedDomains: [...item.file.sandbox.allowedDomains],
        diagnostics: item.diagnostics,
      };
    });
    return {
      rules: merged.rules,
      ...(merged.defaultMode ? {defaultMode: merged.defaultMode} : {}),
      additionalDirectories: merged.additionalDirectories,
      sandbox: merged.sandbox,
      files,
      pendingTrust,
      diagnostics: [
        ...loaded.flatMap(item => item.diagnostics.map(line => `${SCOPE_NAMES[item.scope]} settings: ${line}`)),
        ...this.migration,
      ],
    };
  }

  trust(path: string, hash: string, persist: boolean): void {
    const scope = (['project', 'local'] as const).find(name => this.paths[name] === path);
    if (!scope) throw new FutrynError('INVALID_INPUT');
    // The approval is for the content the user saw; a file changed since then stays untrusted.
    if (this.load(scope).hash !== hash) throw new FutrynError('POLICY');
    if (!persist) {
      this.sessionTrusted.add(`${path}\0${hash}`);
      return;
    }
    this.options.store.update(settings => {
      const all = (settings.trustedProjectSettings ??= {});
      all[path] = [...(all[path] ?? []).filter(entry => entry !== hash), hash].slice(-MAX_TRUSTED_HASHES);
    });
  }

  /** Read-modify-write one file, keeping every key this program does not own. */
  private mutate(scope: PermissionSettingsScope, change: (raw: Record<string, unknown>) => void): void {
    const path = this.paths[scope];
    const before = this.load(scope);
    if (before.exists && (lstatSync(path).mode & 0o222) === 0) throw new FutrynError('POLICY');
    let raw: Record<string, unknown> = {};
    if (before.exists) {
      if (before.diagnostics.some(line => /ignored/.test(line))) throw new FutrynError('INVALID_INPUT');
      try {
        const parsed: unknown = before.text.trim() ? JSON.parse(before.text) : {};
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
        raw = parsed as Record<string, unknown>;
      } catch {
        throw new FutrynError('INVALID_INPUT');
      }
    }
    const wasTrusted = this.isTrusted(before);
    change(raw);
    const text = JSON.stringify(raw, null, 2) + '\n';
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, {mode: 0o600});
    renameSync(temporary, path);
    this.cache.delete(path);
    // The user just authored this change, so the result is theirs - unless the file already held
    // content nobody approved: then the new hash stays untrusted and the user is asked about all of it.
    if (scope !== 'user' && wasTrusted) this.trust(path, settingsHash(text), true);
  }

  addRule(scope: PermissionSettingsScope, effect: PermissionRuleEffect, rule: string): void {
    const parsed = permissionRuleSchema.safeParse(rule);
    if (!parsed.success) throw new FutrynError('INVALID_INPUT');
    this.mutate(scope, raw => {
      const permissions = ensureObject(raw, 'permissions');
      for (const key of ['allow', 'ask', 'deny'] as const) {
        const list = ensureList(permissions, key).filter(entry => entry !== parsed.data);
        permissions[key] = key === effect ? [...list, parsed.data] : list;
      }
      if ((permissions[effect] as string[]).length > 200) throw new FutrynError('POLICY');
    });
  }

  removeRule(scope: PermissionSettingsScope, effect: PermissionRuleEffect, rule: string): void {
    if (!this.load(scope).exists) return;
    this.mutate(scope, raw => {
      const permissions = ensureObject(raw, 'permissions');
      permissions[effect] = ensureList(permissions, effect).filter(entry => entry !== rule);
    });
  }

  updateSandbox(patch: SandboxSettingsPatch): void {
    this.mutate('user', raw => {
      const sandbox = ensureObject(raw, 'sandbox');
      for (const key of ['enabled', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands'] as const) {
        if (patch[key] !== undefined) {
          if (typeof patch[key] !== 'boolean') throw new FutrynError('INVALID_INPUT');
          sandbox[key] = patch[key];
        }
      }
      if (patch.excludeCommand !== undefined) {
        const pattern = patch.excludeCommand.trim();
        if (!pattern || pattern.length > 200 || /[\u0000-\u001f]/.test(pattern)) throw new FutrynError('INVALID_INPUT');
        const list = ensureList(sandbox, 'excludedCommands');
        if (!list.includes(pattern)) list.push(pattern);
        if (list.length > 200) throw new FutrynError('INVALID_INPUT');
        sandbox.excludedCommands = list;
      }
    });
  }

  addAllowedDomain(scope: PermissionSettingsScope, domain: string): void {
    const name = domain.toLowerCase();
    if (!DOMAIN_PATTERN.test(name)) throw new FutrynError('INVALID_INPUT');
    this.mutate(scope, raw => {
      const network = ensureObject(ensureObject(raw, 'sandbox'), 'network');
      const list = ensureList(network, 'allowedDomains');
      if (!list.includes(name)) list.push(name);
      network.allowedDomains = list;
    });
  }

  /**
   * Rules saved by the previous model (per-workspace, in Cosmew's own settings store) move into
   * this project's local settings file so nothing is lost. `Network(...)`/`Unsandboxed(...)` rules
   * have no Claude Code counterpart: deny/ask forms become `Bash(...)` rules, allow forms are
   * reported and dropped (the sandbox proxy and `dangerouslyDisableSandbox` always ask).
   */
  private migrateLegacyRules(): void {
    let legacy: PermissionRuleSet | undefined;
    try {
      legacy = this.options.store.read().projectPermissionRules?.[this.options.workspace];
    } catch {
      return;
    }
    if (!legacy || (!legacy.allow.length && !legacy.ask.length && !legacy.deny.length)) return;
    const notes: string[] = [];
    const converted: PermissionRuleSet = {allow: [], ask: [], deny: []};
    for (const effect of ['allow', 'ask', 'deny'] as const) {
      for (const rule of legacy[effect]) {
        const match = /^(Network|Unsandboxed)(\((.*)\))?$/.exec(rule);
        if (!match) {
          if (permissionRuleSchema.safeParse(rule).success) converted[effect].push(rule);
          else notes.push(`dropped invalid legacy rule ${rule.slice(0, 80)}`);
        } else if (effect === 'allow') {
          notes.push(`dropped legacy allow rule ${rule.slice(0, 80)} (no equivalent: it always asks now)`);
        } else converted[effect].push(match[3] === undefined ? 'Bash' : `Bash(${match[3]})`);
      }
    }
    try {
      this.mutate('local', raw => {
        const permissions = ensureObject(raw, 'permissions');
        for (const effect of ['allow', 'ask', 'deny'] as const) {
          const list = ensureList(permissions, effect);
          for (const rule of converted[effect]) if (!list.includes(rule)) list.push(rule);
          permissions[effect] = list;
        }
      });
      this.options.store.update(settings => {
        if (settings.projectPermissionRules) delete settings.projectPermissionRules[this.options.workspace];
      });
      this.migration = [
        `moved ${legacy.allow.length + legacy.ask.length + legacy.deny.length} saved permission rule(s) to ${this.paths.local}`,
        ...notes,
      ];
    } catch {
      // Keep the old store untouched; the rules still apply as a trusted user overlay (never lost).
      this.migration = ['could not move saved permission rules to the local settings file; they stay in effect'];
      this.legacyOverlay = converted;
    }
  }

  private legacyOverlay: PermissionRuleSet | undefined;
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) return (parent[key] = {});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FutrynError('INVALID_INPUT');
  return value as Record<string, unknown>;
}

function ensureList(parent: Record<string, unknown>, key: string): string[] {
  const value = parent[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new FutrynError('INVALID_INPUT');
  return [...(value as string[])];
}

/**
 * The sandbox configuration the tool dispatcher reads for every call (ADR 0061), derived from the
 * merged settings, the session permission mode and the `Read`/`Edit` deny rules (which also fence
 * the commands' own file access).
 */
export function sandboxConfigFromSettings(
  snapshot: PermissionSettingsSnapshot,
  mode: PermissionMode,
  workspace: string,
  home: string,
): SandboxConfig {
  return {
    enabled: snapshot.sandbox.enabled,
    autoAllowBash: snapshot.sandbox.autoAllowBashIfSandboxed,
    excludedCommands: snapshot.sandbox.excludedCommands,
    allowUnsandboxed: snapshot.sandbox.allowUnsandboxedCommands,
    // Seatbelt matches real paths: a directory that does not exist (yet) grants nothing.
    additionalDirectories: snapshot.additionalDirectories.flatMap(directory => {
      try {
        return [realpathSync.native(directory)];
      } catch {
        return [];
      }
    }),
    network: true,
    permissionMode: mode,
    denyRead: sandboxPathGlobs(snapshot.rules.deny, 'Read', workspace, home),
    denyWrite: sandboxPathGlobs(snapshot.rules.deny, 'Edit', workspace, home),
  };
}
