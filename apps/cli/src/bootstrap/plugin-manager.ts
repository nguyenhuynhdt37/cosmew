import {randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {
  FutrynError,
  PLUGIN_ID_PATTERN,
  type ConfiguredHook,
  type InstalledPluginView,
  type PluginManagementAction,
  type PluginManagementResult,
  type PluginSnapshot,
  type PluginTrustState,
} from '@cosmew/contracts';
import {parseMcpConfig, type McpServerSpec} from '@cosmew/mcp';
import {
  MAX_INSTALLED_PLUGINS,
  copyPluginDirectorySafe,
  parsePluginDirectory,
  type ParsedPluginPackage,
} from '@cosmew/workspace';

interface StoredPluginRecord {
  id: string;
  enabled: boolean;
  trustedHash: string | null;
  installedAt: string;
  sourcePath?: string;
}

interface StoredRegistry {
  version: 1;
  plugins: Record<string, StoredPluginRecord>;
}

interface LoadedPluginEntry {
  view: InstalledPluginView;
  parsed?: ParsedPluginPackage;
  mcpSpecs: McpServerSpec[];
  untrustedHookCount: number;
}

export interface PluginManagerOptions {
  /** User state directory (normally `~/.cosmew`). Repository directories are never loaded here. */
  directory: string;
  redact?: (text: string) => string;
  onChange?: () => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: FutrynError['code'], message: string): never {
  const err = new FutrynError(code);
  err.message = message;
  throw err;
}

/**
 * User-scoped plugin host manager (ADR 0125).
 * Stores installed packages under `<stateDirectory>/plugins/<id>` and metadata in `<stateDirectory>/plugins.json`.
 * Executable capabilities (`hooks` and `mcpServers`) stay disabled until the user approves the exact SHA-256 content hash.
 */
export class PluginManager {
  readonly pluginsDir: string;
  readonly registryPath: string;
  private entries = new Map<string, LoadedPluginEntry>();
  private globalDiagnostics: string[] = [];
  private readonly redact: (text: string) => string;

  constructor(private readonly options: PluginManagerOptions) {
    this.pluginsDir = join(options.directory, 'plugins');
    this.registryPath = join(options.directory, 'plugins.json');
    this.redact = options.redact ?? (text => text);
    this.reload();
  }

  private readRegistry(): StoredRegistry {
    const empty: StoredRegistry = {version: 1, plugins: {}};
    if (!existsSync(this.registryPath)) return empty;
    try {
      const stat = lstatSync(this.registryPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 256 * 1024) {
        this.globalDiagnostics.push('plugins.json is invalid or oversized; ignored.');
        return empty;
      }
      const raw = JSON.parse(readFileSync(this.registryPath, 'utf8'));
      if (!isPlainObject(raw) || !isPlainObject(raw.plugins)) {
        this.globalDiagnostics.push('plugins.json has an invalid format; ignored.');
        return empty;
      }
      const plugins: Record<string, StoredPluginRecord> = {};
      for (const [id, value] of Object.entries(raw.plugins)) {
        if (!PLUGIN_ID_PATTERN.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) continue;
        if (!isPlainObject(value)) continue;
        plugins[id] = {
          id,
          enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
          trustedHash:
            typeof value.trustedHash === 'string' && /^[a-f0-9]{64}$/.test(value.trustedHash)
              ? value.trustedHash
              : null,
          installedAt: typeof value.installedAt === 'string' ? value.installedAt : new Date(0).toISOString(),
          ...(typeof value.sourcePath === 'string' ? {sourcePath: value.sourcePath} : {}),
        };
      }
      return {version: 1, plugins};
    } catch {
      this.globalDiagnostics.push('plugins.json could not be parsed; ignored.');
      return empty;
    }
  }

  private writeRegistry(registry: StoredRegistry): void {
    mkdirSync(dirname(this.registryPath), {recursive: true, mode: 0o700});
    const temp = `${this.registryPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, {mode: 0o600});
    renameSync(temp, this.registryPath);
  }

  /** Rescan `<stateDirectory>/plugins/` and re-verify every plugin's SHA-256 content hash. */
  reload(): PluginSnapshot {
    this.entries = new Map();
    this.globalDiagnostics = [];
    const registry = this.readRegistry();
    const discoveredIds = new Set<string>(Object.keys(registry.plugins));

    if (existsSync(this.pluginsDir)) {
      try {
        const dirStat = lstatSync(this.pluginsDir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          this.globalDiagnostics.push('plugins directory must be a real directory, not a symlink.');
        } else {
          for (const item of readdirSync(this.pluginsDir, {withFileTypes: true}).sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            if (item.name.startsWith('.')) continue;
            if (!PLUGIN_ID_PATTERN.test(item.name)) {
              this.globalDiagnostics.push(`Ignored invalid plugin directory name "${item.name}".`);
              continue;
            }
            discoveredIds.add(item.name);
          }
        }
      } catch {
        this.globalDiagnostics.push('Unable to scan plugins directory.');
      }
    }

    const sortedIds = [...discoveredIds].sort((a, b) => a.localeCompare(b));
    if (sortedIds.length > MAX_INSTALLED_PLUGINS) {
      this.globalDiagnostics.push(`Plugin count truncated at ${MAX_INSTALLED_PLUGINS}.`);
    }

    for (const id of sortedIds.slice(0, MAX_INSTALLED_PLUGINS)) {
      const record: StoredPluginRecord = registry.plugins[id] ?? {
        id,
        enabled: true,
        trustedHash: null,
        installedAt: new Date().toISOString(),
      };
      const pluginPath = join(this.pluginsDir, id);
      if (!existsSync(pluginPath)) {
        this.entries.set(id, {
          view: {
            id,
            name: id,
            version: '0.0.0',
            description: '',
            path: pluginPath,
            enabled: false,
            trustState: 'untrusted',
            contentHash: '',
            trustedHash: record.trustedHash,
            installedAt: record.installedAt,
            counts: {skills: 0, commands: 0, agents: 0, hooks: 0, mcpServers: 0},
            grants: [],
            diagnostics: ['Plugin directory is missing on disk.'],
          },
          mcpSpecs: [],
          untrustedHookCount: 0,
        });
        continue;
      }

      try {
        const parsed = parsePluginDirectory(pluginPath, id);
        const diagnostics = [...parsed.diagnostics];
        const hasExec = parsed.hooks.length > 0 || Object.keys(parsed.rawMcpServers).length > 0;
        let trustState: PluginTrustState;
        if (!hasExec) {
          trustState = 'no-exec';
        } else if (record.trustedHash === parsed.contentHash) {
          trustState = 'trusted';
        } else if (record.trustedHash) {
          trustState = 'trust-changed';
          diagnostics.push(
            'Plugin content changed since trust approval; hooks and MCP servers are paused until re-trusted.',
          );
        } else {
          trustState = 'untrusted';
        }

        let mcpSpecs: McpServerSpec[] = [];
        if (Object.keys(parsed.rawMcpServers).length > 0) {
          const mcpParsed = parseMcpConfig(JSON.stringify({mcpServers: parsed.rawMcpServers}));
          for (const problem of mcpParsed.problems) diagnostics.push(problem);
          if (record.enabled && trustState === 'trusted') {
            mcpSpecs = mcpParsed.servers;
          }
        }

        const untrustedHookCount =
          record.enabled && trustState !== 'trusted' && trustState !== 'no-exec' ? parsed.hooks.length : 0;

        this.entries.set(id, {
          parsed,
          mcpSpecs,
          untrustedHookCount,
          view: {
            id,
            name: parsed.manifest.name,
            version: parsed.manifest.version,
            description: parsed.manifest.description,
            ...(parsed.manifest.author ? {author: parsed.manifest.author} : {}),
            path: pluginPath,
            enabled: record.enabled,
            trustState,
            contentHash: parsed.contentHash,
            trustedHash: record.trustedHash,
            installedAt: record.installedAt,
            counts: parsed.counts,
            grants: parsed.grants.map(grant => ({
              kind: grant.kind,
              summary: this.redact(grant.summary),
            })),
            diagnostics,
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Invalid plugin package.';
        this.entries.set(id, {
          view: {
            id,
            name: id,
            version: '0.0.0',
            description: '',
            path: pluginPath,
            enabled: false,
            trustState: 'untrusted',
            contentHash: '',
            trustedHash: record.trustedHash,
            installedAt: record.installedAt,
            counts: {skills: 0, commands: 0, agents: 0, hooks: 0, mcpServers: 0},
            grants: [],
            diagnostics: [msg],
          },
          mcpSpecs: [],
          untrustedHookCount: 0,
        });
      }
    }

    return this.snapshot();
  }

  snapshot(): PluginSnapshot {
    const plugins = [...this.entries.values()].map(entry => structuredClone(entry.view));
    const untrustedCount = plugins.filter(
      plugin => plugin.enabled && (plugin.trustState === 'untrusted' || plugin.trustState === 'trust-changed'),
    ).length;
    return {
      supported: true,
      directory: this.pluginsDir,
      plugins,
      untrustedCount,
      diagnostics: [...this.globalDiagnostics],
    };
  }

  activeSkillRoots(): {path: string; pluginId: string}[] {
    const roots: {path: string; pluginId: string}[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.view.enabled || !entry.parsed) continue;
      for (const dir of entry.parsed.skillDirs) roots.push({path: dir, pluginId: entry.view.id});
    }
    return roots;
  }

  activeCommandRoots(): {path: string; pluginId: string}[] {
    const roots: {path: string; pluginId: string}[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.view.enabled || !entry.parsed) continue;
      for (const dir of entry.parsed.commandDirs) roots.push({path: dir, pluginId: entry.view.id});
    }
    return roots;
  }

  activeAgentRoots(): {path: string; pluginId: string}[] {
    const roots: {path: string; pluginId: string}[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.view.enabled || !entry.parsed) continue;
      for (const dir of entry.parsed.agentDirs) roots.push({path: dir, pluginId: entry.view.id});
    }
    return roots;
  }

  /** Only hooks from enabled plugins whose current SHA-256 matches the user's explicit trust approval. */
  activeHooks(): ConfiguredHook[] {
    const hooks: ConfiguredHook[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.view.enabled || entry.view.trustState !== 'trusted' || !entry.parsed) continue;
      hooks.push(...entry.parsed.hooks);
    }
    return hooks;
  }

  untrustedHooksCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.untrustedHookCount;
    return total;
  }

  /** Only MCP server specs from enabled, SHA-256 trusted plugins. User `mcp.json` still takes precedence in McpManager. */
  activeMcpSpecs(): McpServerSpec[] {
    const specs: McpServerSpec[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.view.enabled || entry.view.trustState !== 'trusted') continue;
      specs.push(...entry.mcpSpecs);
    }
    return specs;
  }

  install(sourcePath: string): PluginManagementResult {
    const resolvedSource = resolve(sourcePath.trim());
    if (!sourcePath.trim() || !existsSync(resolvedSource)) {
      fail('NOT_FOUND', `Plugin source path not found: ${sourcePath}`);
    }
    const registry = this.readRegistry();
    if (Object.keys(registry.plugins).length >= MAX_INSTALLED_PLUGINS) {
      fail('POLICY', `Maximum installed plugin limit (${MAX_INSTALLED_PLUGINS}) reached.`);
    }

    let preview: ParsedPluginPackage;
    try {
      preview = parsePluginDirectory(resolvedSource);
    } catch (error) {
      fail('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid plugin package.');
    }

    const id = preview.manifest.name;
    const destination = join(this.pluginsDir, id);
    let installed: ParsedPluginPackage;
    try {
      installed = copyPluginDirectorySafe(resolvedSource, destination);
    } catch (error) {
      fail('INVALID_INPUT', error instanceof Error ? error.message : 'Failed to copy plugin package.');
    }

    const previous = registry.plugins[id];
    // Re-installing never carries forward trust unless the SHA-256 content hash is byte-identical.
    const preservedTrust = previous?.trustedHash === installed.contentHash ? previous.trustedHash : null;
    registry.plugins[id] = {
      id,
      enabled: true,
      trustedHash: preservedTrust,
      installedAt: new Date().toISOString(),
      sourcePath: resolvedSource,
    };
    this.writeRegistry(registry);
    const snapshot = this.reload();
    this.options.onChange?.();
    const plugin = snapshot.plugins.find(p => p.id === id);
    const needsTrust = plugin && (plugin.trustState === 'untrusted' || plugin.trustState === 'trust-changed');
    return {
      ok: true,
      message: needsTrust
        ? `Installed plugin "${id}" (${installed.manifest.version}). Hooks/MCP are paused until you approve SHA-256 ${installed.contentHash.slice(0, 12)}…`
        : `Installed plugin "${id}" (${installed.manifest.version}).`,
      ...(plugin ? {plugin} : {}),
      snapshot,
    };
  }

  uninstall(id: string): PluginManagementResult {
    if (!PLUGIN_ID_PATTERN.test(id)) throw new FutrynError('INVALID_INPUT');
    const registry = this.readRegistry();
    const pluginPath = join(this.pluginsDir, id);
    const existed = Boolean(registry.plugins[id]) || existsSync(pluginPath);
    if (!existed) fail('NOT_FOUND', `Plugin "${id}" is not installed.`);

    delete registry.plugins[id];
    this.writeRegistry(registry);
    if (existsSync(pluginPath)) {
      rmSync(pluginPath, {recursive: true, force: true});
    }
    const snapshot = this.reload();
    this.options.onChange?.();
    return {ok: true, message: `Uninstalled plugin "${id}".`, snapshot};
  }

  setEnabled(id: string, enabled: boolean): PluginManagementResult {
    if (!PLUGIN_ID_PATTERN.test(id)) throw new FutrynError('INVALID_INPUT');
    const current = this.entries.get(id);
    if (!current) fail('NOT_FOUND', `Plugin "${id}" is not installed.`);

    const registry = this.readRegistry();
    const existing = registry.plugins[id];
    registry.plugins[id] = {
      id,
      enabled,
      trustedHash: existing?.trustedHash ?? null,
      installedAt: existing?.installedAt ?? current.view.installedAt,
      ...(existing?.sourcePath ? {sourcePath: existing.sourcePath} : {}),
    };
    this.writeRegistry(registry);
    const snapshot = this.reload();
    this.options.onChange?.();
    const plugin = snapshot.plugins.find(p => p.id === id);
    return {
      ok: true,
      message: `${enabled ? 'Enabled' : 'Disabled'} plugin "${id}".`,
      ...(plugin ? {plugin} : {}),
      snapshot,
    };
  }

  /** Approve executable capabilities (`hooks` / `mcpServers`) for the exact SHA-256 hash shown to the user (TOCTOU-safe). */
  trust(id: string, expectedHash: string): PluginManagementResult {
    if (!PLUGIN_ID_PATTERN.test(id) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new FutrynError('INVALID_INPUT');
    }
    // Re-read on disk immediately before persisting trust so modifications after display are rejected.
    this.reload();
    const current = this.entries.get(id);
    if (!current) fail('NOT_FOUND', `Plugin "${id}" is not installed.`);
    if (!current.parsed || !current.view.contentHash) {
      fail('POLICY', `Plugin "${id}" has validation errors and cannot be trusted.`);
    }
    if (current.view.contentHash !== expectedHash) {
      fail(
        'POLICY',
        `Plugin "${id}" hash mismatch (content changed before approval). Reload and inspect before trusting.`,
      );
    }

    const registry = this.readRegistry();
    const existing = registry.plugins[id];
    registry.plugins[id] = {
      id,
      enabled: existing?.enabled ?? true,
      trustedHash: expectedHash,
      installedAt: existing?.installedAt ?? current.view.installedAt,
      ...(existing?.sourcePath ? {sourcePath: existing.sourcePath} : {}),
    };
    this.writeRegistry(registry);
    const snapshot = this.reload();
    this.options.onChange?.();
    const plugin = snapshot.plugins.find(p => p.id === id);
    return {
      ok: true,
      message: `Trusted plugin "${id}" (SHA-256 ${expectedHash.slice(0, 12)}…).`,
      ...(plugin ? {plugin} : {}),
      snapshot,
    };
  }

  revokeTrust(id: string): PluginManagementResult {
    if (!PLUGIN_ID_PATTERN.test(id)) throw new FutrynError('INVALID_INPUT');
    const current = this.entries.get(id);
    if (!current) fail('NOT_FOUND', `Plugin "${id}" is not installed.`);

    const registry = this.readRegistry();
    const existing = registry.plugins[id];
    registry.plugins[id] = {
      id,
      enabled: existing?.enabled ?? current.view.enabled,
      trustedHash: null,
      installedAt: existing?.installedAt ?? current.view.installedAt,
      ...(existing?.sourcePath ? {sourcePath: existing.sourcePath} : {}),
    };
    this.writeRegistry(registry);
    const snapshot = this.reload();
    this.options.onChange?.();
    const plugin = snapshot.plugins.find(p => p.id === id);
    return {
      ok: true,
      message: `Revoked execution trust for plugin "${id}".`,
      ...(plugin ? {plugin} : {}),
      snapshot,
    };
  }

  manage(action: PluginManagementAction): PluginManagementResult {
    switch (action.type) {
      case 'install':
        return this.install(action.sourcePath);
      case 'uninstall':
        return this.uninstall(action.id);
      case 'enable':
        return this.setEnabled(action.id, true);
      case 'disable':
        return this.setEnabled(action.id, false);
      case 'trust':
        return this.trust(action.id, action.hash);
      case 'revoke':
        return this.revokeTrust(action.id);
      case 'reload': {
        const snapshot = this.reload();
        this.options.onChange?.();
        return {
          ok: true,
          message: `Reloaded ${snapshot.plugins.length} plugin${snapshot.plugins.length === 1 ? '' : 's'}${snapshot.untrustedCount ? ` (${snapshot.untrustedCount} awaiting trust)` : ''}.`,
          snapshot,
        };
      }
    }
  }
}
