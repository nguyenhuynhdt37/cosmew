import {join, resolve} from 'node:path';
import {lstatSync} from 'node:fs';
import {
  FutrynError,
  MCP_OAUTH_ISSUES,
  type CredentialVault,
  type McpManagedServer,
  type McpManagerSnapshot,
  type McpManagementAction,
  type McpManagementResult,
} from '@cosmew/contracts';
import {FileMcpSettings, FileMcpAuthStore} from '@cosmew/persistence';
import {registerConfigSecrets} from '@cosmew/security';
import {
  McpHub,
  McpCatalog,
  McpOAuthError,
  McpOAuthService,
  parseMcpConfig,
  recommendedMcpRecipes,
  type McpServerSpec,
} from '@cosmew/mcp';
import {createManagedMcpInstaller, type ManagedMcpInstallerOptions} from './mcp-install';

const nameSchema = {
  parse(name: unknown): string {
    if (
      typeof name !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(name) ||
      ['__proto__', 'prototype', 'constructor'].includes(name)
    )
      throw new FutrynError('INVALID_INPUT');
    return name;
  },
};
const object = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
/** GitHub Remote MCP needs a host-registered app for browser OAuth. */
function usesGitHubPat(spec: McpServerSpec): boolean {
  if (spec.transport !== 'http') return false;
  const url = new URL(spec.url);
  return (
    url.origin === 'https://api.githubcopilot.com' &&
    !url.search &&
    (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))
  );
}

interface PreviousInstallation {
  installationId: string;
  packageName: string;
  version: string;
  integrity: string;
  bin?: string;
  binName?: string;
  updatedAt: string;
}

interface Metadata {
  source?: McpManagedServer['source'];
  catalogId?: string;
  installationId?: string;
  packageName?: string;
  version?: string;
  integrity?: string;
  bin?: string;
  binName?: string;
  previousInstallations?: PreviousInstallation[];
}

const MAX_PREVIOUS_INSTALLATIONS = 5;

function parsePreviousInstallations(raw: unknown): PreviousInstallation[] {
  if (!Array.isArray(raw)) return [];
  const out: PreviousInstallation[] = [];
  for (const item of raw) {
    const entry = object(item);
    if (
      typeof entry.installationId === 'string' &&
      typeof entry.packageName === 'string' &&
      typeof entry.version === 'string' &&
      typeof entry.integrity === 'string' &&
      typeof entry.updatedAt === 'string'
    ) {
      out.push({
        installationId: entry.installationId,
        packageName: entry.packageName,
        version: entry.version,
        integrity: entry.integrity,
        ...(typeof entry.bin === 'string' ? {bin: entry.bin} : {}),
        ...(typeof entry.binName === 'string' ? {binName: entry.binName} : {}),
        updatedAt: entry.updatedAt,
      });
    }
  }
  return out.slice(0, MAX_PREVIOUS_INSTALLATIONS);
}
export interface McpManagerOptions {
  directory: string;
  vault: CredentialVault;
  redact(text: string): string;
  registerSecret(secret: string): void;
  openURL(url: string): Promise<void>;
  fetch?: typeof fetch;
  installRunner?: ManagedMcpInstallerOptions['runner'];
  onChange?(): void;
  onStatusChange?(): void;
  /** Additional MCP server specs from enabled, SHA-256 trusted user plugins (ADR 0125). User mcp.json always wins on clash. */
  extraSpecs?: () => readonly McpServerSpec[];
}
/** One user-managed lifecycle for manual/catalog servers; never exposed as a model tool. */
export class McpManager {
  readonly hub: McpHub;
  readonly auth: McpOAuthService;
  private readonly store: FileMcpSettings;
  private readonly catalog: McpCatalog;
  private readonly installer: ReturnType<typeof createManagedMcpInstaller>;
  private readonly oauthRequired = new Set<string>();
  private readonly changing = new Set<string>();
  private readonly loggedOut = new Set<string>();
  private lastIdentity = '';
  constructor(private readonly options: McpManagerOptions) {
    this.store = new FileMcpSettings(options.directory);
    this.catalog = new McpCatalog(options.fetch);
    this.installer = createManagedMcpInstaller({
      stateDirectory: options.directory,
      fetcher: options.fetch,
      runner: options.installRunner,
    });
    this.auth = new McpOAuthService({
      store: new FileMcpAuthStore(options.directory, options.vault),
      openURL: options.openURL,
      fetch: options.fetch,
      registerSecret: options.registerSecret,
    });
    let specs: McpServerSpec[] = [],
      problems: string[] = [];
    try {
      const parsed = parseMcpConfig(JSON.stringify(this.store.read().document));
      specs = this.mergeExtraSpecs(parsed.servers);
      problems = parsed.problems;
    } catch {
      problems = ['MCP user configuration could not be read.'];
    }
    this.register(specs);
    this.lastIdentity = JSON.stringify(specs);
    this.hub = new McpHub(specs, {
      configPath: join(options.directory, 'mcp.json'),
      problems,
      redact: options.redact,
      fetch: options.fetch,
      onStatusChange: options.onStatusChange,
      onToolsChanged: options.onChange,
      authProvider: spec => {
        if (usesGitHubPat(spec)) return undefined;
        const url = new URL(spec.url);
        return url.protocol === 'https:' || ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
          ? this.auth.getProvider(spec.url)
          : undefined;
      },
    });
  }
  private register(specs: McpServerSpec[]) {
    for (const spec of specs)
      registerConfigSecrets(spec.transport === 'http' ? spec.headers : spec.env, this.options.registerSecret);
  }
  private mergeExtraSpecs(userSpecs: McpServerSpec[]): McpServerSpec[] {
    const extras = this.options.extraSpecs?.() ?? [];
    if (!extras.length) return userSpecs;
    const existing = new Set(userSpecs.map(s => s.name));
    const merged = [...userSpecs];
    for (const extra of extras) {
      if (existing.has(extra.name)) continue;
      existing.add(extra.name);
      merged.push({...extra});
    }
    return merged;
  }
  private read() {
    const saved = this.store.read();
    const parsed = parseMcpConfig(JSON.stringify(saved.document));
    const merged = this.mergeExtraSpecs(parsed.servers);
    this.register(merged);
    return {...saved, ...parsed, servers: merged};
  }
  private async specs(): Promise<McpServerSpec[]> {
    const specs = this.read().servers;
    for (const spec of specs) if (spec.transport === 'http' && this.loggedOut.has(spec.url)) spec.enabled = false;
    for (const spec of specs)
      if (spec.transport === 'http') {
        try {
          const bearer = await this.auth.bearer(spec.url);
          if (bearer) spec.headers = {...spec.headers, Authorization: `Bearer ${bearer}`};
        } catch {
          /* Non-OAuth transports remain valid; errors are visible in auth status. */
        }
      }
    return specs;
  }
  async connect(signal?: AbortSignal) {
    const specs = await this.specs();
    const identity = JSON.stringify(specs);
    if (identity !== this.lastIdentity) {
      this.options.onChange?.();
      this.lastIdentity = identity;
    }
    return this.hub.replaceSpecs(specs, signal);
  }
  async snapshot(): Promise<McpManagerSnapshot> {
    const configPath = join(this.options.directory, 'mcp.json');
    try {
      const saved = this.read(),
        live = this.hub.snapshot();
      const tools = this.hub.tools();
      const servers: McpManagedServer[] = [];
      for (const spec of saved.servers) {
        const entry = object(saved.document.mcpServers[spec.name]);
        const meta = object(entry.cosmew) as Metadata;
        const observed = live.servers.find(server => server.name === spec.name);
        const connection =
          spec.enabled === false
            ? 'disabled'
            : this.loggedOut.has(spec.transport === 'http' ? spec.url : '')
              ? 'needs-auth'
              : (observed?.state ?? 'stopped');
        let auth: McpManagedServer['auth'] = {state: 'not-required'};
        if (spec.transport === 'http') {
          try {
            const status = await this.auth.status(spec.url);
            auth =
              status.status === 'needs-login'
                ? {
                    state:
                      connection === 'needs-auth' || this.oauthRequired.has(spec.url) || status.issue
                        ? 'needs-login'
                        : connection === 'connected'
                          ? 'not-required'
                          : 'unknown',
                  }
                : {state: status.status, ...(status.scopes ? {scopes: status.scopes} : {})};
            if (status.issue) auth = {...auth, issue: status.issue};
          } catch {
            auth = {state: 'unknown'};
          }
          if (Object.keys(spec.headers).some(key => key.toLowerCase() === 'authorization'))
            auth = {state: 'authorized'};
          if (usesGitHubPat(spec)) {
            auth = {
              ...auth,
              ...(connection === 'needs-auth' || auth.state === 'unknown' ? {state: 'needs-login'} : {}),
              method: 'github-pat',
            };
          }
        }
        let installation: McpManagedServer['installation'] =
          spec.transport === 'http' ? {state: 'not-applicable'} : {state: 'unmanaged'};
        if (spec.transport === 'stdio' && meta.installationId) {
          const installed = this.installer.list().find(item => item.installationId === meta.installationId);
          let ready =
            installed?.state === 'ready' &&
            installed.packageName === meta.packageName &&
            installed.version === meta.version;
          const expectedRoot = join(
            this.options.directory,
            'mcp-packages',
            meta.installationId,
            'node_modules',
            meta.packageName ?? '',
          );
          try {
            const executable = spec.args[0];
            ready = Boolean(
              ready &&
              executable &&
              resolve(executable) === join(expectedRoot, installed!.bin ?? '') &&
              lstatSync(executable).isFile() &&
              !lstatSync(executable).isSymbolicLink(),
            );
          } catch {
            ready = false;
          }
          const previous = parsePreviousInstallations(meta.previousInstallations);
          installation = {
            state: ready ? 'ready' : 'missing',
            id: meta.installationId,
            packageName: meta.packageName,
            version: meta.version,
            ...((installed?.integrity ?? meta.integrity) ? {integrity: installed?.integrity ?? meta.integrity} : {}),
            ...(previous[0]?.version ? {previousVersion: previous[0].version} : {}),
            ...(previous.length ? {rollbackCount: previous.length} : {}),
          };
        }
        const endpoint =
          spec.transport === 'http'
            ? (() => {
                const url = new URL(spec.url);
                return url.origin + url.pathname;
              })()
            : undefined;
        const source = ['manual', 'registry', 'recommended', 'plugin'].includes(meta.source ?? '')
          ? meta.source!
          : 'manual';
        const promptCount = this.hub.prompts().filter(prompt => prompt.server === spec.name).length;
        servers.push({
          name: spec.name,
          transport: spec.transport,
          source,
          enabled: spec.enabled !== false,
          connection,
          auth,
          installation,
          toolCount: observed?.tools ?? 0,
          ...(promptCount ? {promptCount} : {}),
          tools: tools
            .filter(tool => tool.server === spec.name)
            .map(tool => ({name: tool.name, description: this.options.redact(tool.description)})),
          ...(endpoint ? {endpoint: this.options.redact(endpoint)} : {}),
          ...(observed?.error ? {diagnostic: this.options.redact(observed.error)} : {}),
          ...(meta.catalogId ? {catalogId: this.options.redact(meta.catalogId)} : {}),
        });
      }
      for (const [name, raw] of Object.entries(saved.document.mcpServers)) {
        if (servers.some(server => server.name === name)) continue;
        const entry = object(raw);
        servers.push({
          name: this.options.redact(name),
          transport: typeof entry.url === 'string' ? 'http' : 'stdio',
          source: 'manual',
          enabled: entry.enabled !== false,
          connection: 'failed',
          auth: {state: 'unknown'},
          installation: {state: 'unmanaged'},
          toolCount: 0,
          tools: [],
          diagnostic: 'Invalid or unsupported configuration. Edit or remove this entry.',
        });
      }
      return {
        supported: true,
        configPath,
        servers,
        problems: [...new Set([...saved.problems, ...live.problems])].map(text => this.options.redact(text)),
      };
    } catch {
      return {
        supported: true,
        configPath,
        servers: [],
        problems: ['MCP user configuration could not be read. Fix the file before making changes.'],
      };
    }
  }
  private change(
    name: string,
    update: (entry: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
  ) {
    const saved = this.read();
    this.store.update(saved.revision, document => {
      const original = Object.hasOwn(document.mcpServers, name) ? object(document.mcpServers[name]) : undefined;
      const entry = update(original);
      if (entry) document.mcpServers[name] = entry;
      else delete document.mcpServers[name];
    });
    this.options.onChange?.();
  }
  private removeUnreferencedInstallation(installationId: string) {
    const current = this.read();
    const stillReferenced = current.servers.some(other => {
      const m = object(object(current.document.mcpServers[other.name]).cosmew);
      if (m.installationId === installationId) return true;
      return parsePreviousInstallations(m.previousInstallations).some(p => p.installationId === installationId);
    });
    if (!stillReferenced) {
      try {
        this.installer.remove(installationId);
      } catch {
        /* already removed or missing */
      }
    }
  }
  private clearInlineAuthorization(name: string) {
    this.change(name, entry => {
      const headers = Object.fromEntries(
        Object.entries(object(entry?.headers)).filter(([key]) => key.toLowerCase() !== 'authorization'),
      );
      return {...entry!, headers};
    });
  }
  async perform(action: McpManagementAction, signal?: AbortSignal): Promise<McpManagementResult> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    if (action.type === 'search') {
      const page = await this.catalog.search(action.query, {cursor: action.cursor, signal});
      return {snapshot: await this.snapshot(), ...page};
    }
    if (action.type === 'recommended') return {snapshot: await this.snapshot(), entries: recommendedMcpRecipes()};
    const name = nameSchema.parse(action.name);
    if (this.changing.has(name)) throw new FutrynError('RUNTIME_UNAVAILABLE');
    this.changing.add(name);
    try {
      let message: string | undefined, logout: McpManagementResult['logout'];
      if (action.type === 'add' || action.type === 'edit') {
        const config = action.config;
        const baseRaw =
          config.transport === 'http'
            ? {url: config.url, headers: config.headers ?? {}}
            : {
                command: config.command,
                args: config.args ?? [],
                env: config.env ?? {},
              };
        const checked = parseMcpConfig(
          JSON.stringify({mcpServers: {[name]: {...baseRaw, enabled: config.enabled ?? true}}}),
        );
        if (checked.servers.length !== 1 || checked.problems.length) throw new FutrynError('INVALID_INPUT');
        this.change(name, previous => {
          if (action.type === 'add' && previous) throw new FutrynError('INVALID_INPUT');
          if (action.type === 'edit' && !previous) throw new FutrynError('NOT_FOUND');
          if (action.type === 'edit' && object(previous?.cosmew).installationId) throw new FutrynError('UNSUPPORTED');
          const previousMeta = object(previous?.cosmew);
          const enabled =
            config.enabled !== undefined
              ? config.enabled
              : action.type === 'edit' && typeof previous?.enabled === 'boolean'
                ? previous.enabled
                : true;
          const catalogId =
            action.type === 'add'
              ? action.catalogId
              : typeof previousMeta.catalogId === 'string'
                ? previousMeta.catalogId
                : undefined;
          return {
            ...baseRaw,
            enabled,
            cosmew: {
              source: action.type === 'add' ? (action.source ?? 'manual') : (previousMeta.source ?? 'manual'),
              ...(catalogId ? {catalogId: catalogId.slice(0, 256)} : {}),
            },
          };
        });
        await this.connect(signal);
        message =
          action.type === 'add'
            ? 'Server added. Connection and authentication are shown separately.'
            : 'Server updated. Connection and authentication are shown separately.';
      } else if (action.type === 'install') {
        if (this.read().servers.some(server => server.name === name)) throw new FutrynError('INVALID_INPUT');
        const installed = await this.installer.install(
          {
            ...action,
            id: name,
            lockfile:
              action.lockfile === undefined
                ? undefined
                : typeof action.lockfile === 'string'
                  ? action.lockfile
                  : JSON.stringify(action.lockfile),
          },
          signal,
        );
        try {
          signal?.throwIfAborted();
          this.change(name, previous => {
            if (previous) throw new FutrynError('INVALID_INPUT');
            const {transport: _transport, ...config} = installed.spec;
            return {
              ...config,
              enabled: true,
              cosmew: {
                source: action.catalogId ? 'registry' : 'manual',
                catalogId: action.catalogId,
                installationId: installed.installationId,
                packageName: installed.packageName,
                version: installed.version,
                integrity: installed.integrity,
                bin: installed.bin,
                ...(action.bin ? {binName: action.bin} : {}),
              },
            };
          });
        } catch (error) {
          this.installer.remove(installed.installationId);
          throw error;
        }
        await this.connect(signal);
        message = 'Pinned package installed with lifecycle scripts disabled.';
      } else {
        const saved = this.read();
        const spec = saved.servers.find(server => server.name === name);
        if (!spec) {
          if (action.type === 'remove' && Object.hasOwn(saved.document.mcpServers, name)) {
            this.change(name, () => undefined);
            await this.connect(signal);
            return {snapshot: await this.snapshot(), message: 'Invalid server entry removed.'};
          }
          throw new FutrynError('NOT_FOUND');
        }
        if (action.type === 'login') {
          const github = usesGitHubPat(spec);
          if (github && action.bearer === undefined)
            throw new Error(`GitHub MCP requires a personal access token. Use cosmew mcp credentials ${name}.`);
          if (!github && action.bearer !== undefined) throw new FutrynError('INVALID_INPUT');
        }
        const meta = object(object(saved.document.mcpServers[name]).cosmew) as Metadata;
        const originalIdentity = JSON.stringify(spec);
        const ensureCurrent = () => {
          if (JSON.stringify(this.read().servers.find(server => server.name === name)) !== originalIdentity)
            throw new FutrynError('POLICY');
        };
        if (action.type === 'enable' || action.type === 'disable') {
          if (action.type === 'enable' && spec.transport === 'http') this.loggedOut.delete(spec.url);
          this.change(name, entry => ({...entry!, enabled: action.type === 'enable'}));
          await this.connect(signal);
        } else if (action.type === 'update') {
          if (spec.transport !== 'stdio' || !meta.installationId || !meta.packageName)
            throw new FutrynError('UNSUPPORTED');
          const previousList = parsePreviousInstallations(meta.previousInstallations);
          const currentRecord = this.installer.list().find(item => item.installationId === meta.installationId);
          const selectedBinName = action.bin ?? meta.binName;
          const installed = await this.installer.install(
            {
              id: name,
              packageName: meta.packageName,
              version: action.version,
              integrity: action.integrity,
              bin: selectedBinName,
              lockfile:
                action.lockfile === undefined
                  ? undefined
                  : typeof action.lockfile === 'string'
                    ? action.lockfile
                    : JSON.stringify(action.lockfile),
            },
            signal,
          );
          const nextPrevious: PreviousInstallation[] = [
            ...(currentRecord
              ? [
                  {
                    installationId: currentRecord.installationId,
                    packageName: currentRecord.packageName,
                    version: currentRecord.version,
                    integrity: currentRecord.integrity,
                    ...(currentRecord.bin ? {bin: currentRecord.bin} : {}),
                    ...(meta.binName ? {binName: meta.binName} : {}),
                    updatedAt: new Date().toISOString(),
                  },
                ]
              : []),
            ...previousList.filter(item => item.installationId !== currentRecord?.installationId),
          ];
          const keptPrevious = nextPrevious.slice(0, MAX_PREVIOUS_INSTALLATIONS);
          const evicted = nextPrevious.slice(MAX_PREVIOUS_INSTALLATIONS);
          try {
            signal?.throwIfAborted();
            ensureCurrent();
            this.change(name, entry => {
              if (!entry) throw new FutrynError('NOT_FOUND');
              const {transport: _transport, ...config} = installed.spec;
              return {
                ...config,
                env: object(entry.env),
                enabled: entry.enabled !== false,
                cosmew: {
                  source: meta.source ?? 'manual',
                  ...(meta.catalogId ? {catalogId: meta.catalogId} : {}),
                  installationId: installed.installationId,
                  packageName: installed.packageName,
                  version: installed.version,
                  integrity: installed.integrity,
                  bin: installed.bin,
                  ...(selectedBinName ? {binName: selectedBinName} : {}),
                  previousInstallations: keptPrevious,
                },
              };
            });
          } catch (error) {
            this.installer.remove(installed.installationId);
            throw error;
          }
          await this.connect(signal);
          for (const stale of evicted) {
            this.removeUnreferencedInstallation(stale.installationId);
          }
          message = `Updated ${name} (${installed.packageName}) from ${meta.version ?? 'unknown'} to ${installed.version}.`;
        } else if (action.type === 'rollback') {
          if (spec.transport !== 'stdio' || !meta.installationId || !meta.packageName)
            throw new FutrynError('UNSUPPORTED');
          const previousList = parsePreviousInstallations(meta.previousInstallations);
          const target = previousList[0];
          if (!target) throw new FutrynError('NOT_FOUND');
          const restored = this.installer.resolveExecutable(
            target.installationId,
            target.packageName,
            target.version,
            target.integrity,
          );
          const discardedId = meta.installationId;
          signal?.throwIfAborted();
          ensureCurrent();
          this.change(name, entry => {
            if (!entry) throw new FutrynError('NOT_FOUND');
            const {transport: _transport, ...config} = restored.spec;
            return {
              ...config,
              env: object(entry.env),
              enabled: entry.enabled !== false,
              cosmew: {
                source: meta.source ?? 'manual',
                ...(meta.catalogId ? {catalogId: meta.catalogId} : {}),
                installationId: restored.installationId,
                packageName: restored.packageName,
                version: restored.version,
                integrity: restored.integrity,
                bin: restored.bin,
                ...(target.binName ? {binName: target.binName} : {}),
                ...(previousList.length > 1 ? {previousInstallations: previousList.slice(1)} : {}),
              },
            };
          });
          await this.connect(signal);
          if (discardedId !== restored.installationId) {
            this.removeUnreferencedInstallation(discardedId);
          }
          message = `Rolled back ${name} (${restored.packageName}) to ${restored.version}.`;
        } else if (action.type === 'remove') {
          await this.hub.setEnabled(name, false, signal);
          if (
            spec.transport === 'http' &&
            !saved.servers.some(other => other.name !== name && other.transport === 'http' && other.url === spec.url)
          )
            logout = await this.auth.logout(spec.url);
          ensureCurrent();
          this.change(name, () => undefined);
          await this.connect(signal);
          const candidates = [
            ...(meta.installationId ? [meta.installationId] : []),
            ...parsePreviousInstallations(meta.previousInstallations).map(item => item.installationId),
          ];
          for (const id of new Set(candidates)) this.removeUnreferencedInstallation(id);
          message = 'Server removed. Remote service data was not deleted.';
        } else if (action.type === 'login' && action.bearer === undefined) {
          if (spec.transport !== 'http') throw new FutrynError('UNSUPPORTED');
          this.oauthRequired.add(spec.url);
          await this.auth.login(spec.url, {signal});
          ensureCurrent();
          this.loggedOut.delete(spec.url);
          this.options.onChange?.();
          await this.connect(signal);
          await this.hub.setEnabled(name, spec.enabled !== false, signal);
          await this.hub.reconnect(name, signal);
          message = 'Sign-in completed.';
        } else if (action.type === 'logout') {
          if (spec.transport !== 'http') throw new FutrynError('UNSUPPORTED');
          for (const peer of saved.servers)
            if (peer.transport === 'http' && peer.url === spec.url) await this.hub.setEnabled(peer.name, false, signal);
          logout = await this.auth.logout(spec.url);
          ensureCurrent();
          for (const peer of saved.servers)
            if (peer.transport === 'http' && peer.url === spec.url) this.clearInlineAuthorization(peer.name);
          this.loggedOut.add(spec.url);
          this.oauthRequired.add(spec.url);
          this.options.onChange?.();
          message = logout.remoteRevoked
            ? 'Local credentials cleared and remote access revoked.'
            : 'Local credentials cleared. Remote revocation was not confirmed.';
        } else if (action.type === 'credentials' || action.type === 'login') {
          if (spec.transport !== 'http') throw new FutrynError('UNSUPPORTED');
          if (action.type === 'credentials' && action.expectedEndpoint !== undefined) {
            const endpoint = new URL(spec.url);
            if (endpoint.origin + endpoint.pathname !== action.expectedEndpoint) throw new FutrynError('POLICY');
          }
          const bearer = action.bearer;
          if (bearer === undefined) throw new FutrynError('INVALID_INPUT');
          if (this.hub.snapshot().servers.some(server => server.name === name))
            await this.hub.setEnabled(name, false, signal);
          signal?.throwIfAborted();
          ensureCurrent();
          if (bearer === null) await this.auth.clearBearer(spec.url);
          else await this.auth.setBearer(spec.url, bearer);
          this.loggedOut.delete(spec.url);
          ensureCurrent();
          this.clearInlineAuthorization(name);
          this.options.onChange?.();
          await this.connect(signal);
          await this.hub.setEnabled(name, spec.enabled !== false, signal);
          message = action.bearer === null ? 'Stored bearer credential cleared.' : 'Bearer credential saved securely.';
        } else if (action.type === 'reconnect' || action.type === 'doctor') {
          if (spec.transport === 'http') this.loggedOut.delete(spec.url);
          await this.connect(signal);
          await this.hub.setEnabled(name, spec.enabled !== false, signal);
          await this.hub.reconnect(name, signal);
          message = 'Connection checked. Inspect status and diagnostics.';
        }
      }
      return {snapshot: await this.snapshot(), ...(message ? {message} : {}), ...(logout ? {logout} : {})};
    } catch (error) {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      if (error instanceof FutrynError) throw error;
      if (error instanceof McpOAuthError) {
        const issue = new FutrynError('AUTH');
        issue.message =
          MCP_OAUTH_ISSUES[error.issue] +
          (action.type === 'login'
            ? ` If the provider supplies a bearer token, use cosmew mcp credentials ${action.name}.`
            : '');
        throw issue;
      }
      const safe = new FutrynError('INVALID_INPUT');
      safe.message = this.options
        .redact(error instanceof Error ? error.message : 'MCP operation failed.')
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .slice(0, 300);
      throw safe;
    } finally {
      this.changing.delete(name);
    }
  }
}
