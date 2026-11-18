import {runUserShellCommand} from './user-shell';
import {realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {basename, dirname, join, resolve} from 'node:path';
import {
  FULL_ACCESS_WARNING,
  FutrynError,
  type Account,
  type CredentialVault,
  type Message,
  type ModelInfo,
  type ModelPort,
  type ModelRequest,
  type WorkspaceDiffReport,
  type ProjectContextOptions,
  type ProjectContextPort,
  type SkillsPort,
  type MemoriesPort,
  type SkillsReport,
  type ProjectContextReport,
  type Selection,
  type SessionRecord,
  type ToolPort,
  type ToolResult,
  type TurnBudget,
  analysisCapability,
  permissionRuleDecision,
  type PlanState,
  type Provider,
  type SubagentNotice,
  type SubagentWorktreePort,
} from '@futryn/contracts';
import {Conversation} from '@futryn/core';
import {
  SubagentManager,
  SubagentScheduler,
  isBuiltinAgentName,
  effectiveSubagentSandbox,
  filterSubagentTools,
  isToolAllowedForProfile,
  type ChildRunContext,
} from '@futryn/agents';
import {ToolDispatcher, type CommandRuntime} from '@futryn/tools';
import {WebSearchClient, type SearchKeys} from '@futryn/mcp';
import {LspManager} from '@futryn/code-intel';
import {
  ProjectContextLoader,
  AgentDefinitionCatalog,
  SkillCatalog,
  parseSkillDocument,
  renderSkillCatalog,
  skillInvocations,
  WorkspaceDenied,
  WorkspaceRoot,
  GitWorktrees,
  WorktreeError,
  type WorktreeInfo,
  nestedLabel,
} from '@futryn/workspace';
import {
  AccountManager,
  IntegrationRegistry,
  ModelCatalog,
  ModelRouter,
  ProviderAdapter,
  ProviderRegistry,
  ProviderTransport,
  parseOpenRouterKeyLimits,
  providerPresets,
  reservedProviderIds,
  type HostProviderEntry,
  loadHostConfig,
  renderProviderToml,
} from '@futryn/models';
import {
  FileCustomThemeStore,
  FileMemories,
  MigrationOutbox,
  removeRuntimeProfiles,
  SqliteConversations,
  SqliteSettings,
  ToolAuditStore,
  openPrivateDatabase,
} from '@futryn/persistence';
import {FutrynClient, SLASH_COMMANDS, parseSlashCommand, type TerminalRuntimeReport} from '@futryn/sdk';
import {
  ConfiguredNetworkPolicy,
  OpenRouterPKCE,
  Redactor,
  SecureVault,
  SessionGrants,
  evaluateRead,
  redactModel,
  terminalText,
  validateEndpoint,
} from '@futryn/security';
import {ChatGPTOAuth, openExternalURL, type ChatGPTOAuthOptions} from '../subscriptions/chatgpt-oauth';
import {grantLabel, toolPermissionRequest} from './approvals';
import {HostConfigStore, TokenCommandRunner} from './host-config';
import {
  CommandRuntimes,
  createCommandRuntime,
  permissionModeFromEnv,
  sandboxSettingsFromEnv,
  type LaunchPermissionFlags,
} from './commands';
import {defaultStateDirectory} from './paths';
import {fitUtf8Prefix} from './utf8';
import {refreshWorkspaceGitDiff, scanWorkspaceFiles} from './workspace-info';

export {computeWorkspaceGitDiff, scanWorkspaceFiles} from './workspace-info';
export {
  PERMISSION_CLI_OPTIONS,
  approvalPolicyFromEnv,
  parsePermissionFlags,
  permissionModeFromEnv,
  resolvePermissionFlags,
  sandboxSettingsFromEnv,
  type LaunchPermissionFlags,
} from './commands';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';

/** Committed history as conversation messages, keeping tool calls and tool results. */
function committedMessages(record: SessionRecord): Message[] {
  if (record.recovery) return record.recovery.messages;
  return record.messages
    .filter(m => m.state === 'committed')
    .map(({revision: _revision, state: _state, ...message}) => message);
}

/** Project context budget: explicit options, else FUTRYN_PROJECT_CONTEXT_MAX_BYTES, else 32 KiB. */
/**
 * Whether a Git-reported workspace path may reach the model without approval. Mirrors the read tool:
 * paths are judged under the canonical root, and an existing file is judged again at its real
 * location so a symlink cannot launder Futryn state or secrets. A deleted file has no current
 * target, so only its path is judged; any other resolution failure is not allowed.
 */
function readAllowedWithoutApproval(workspace: WorkspaceRoot, path: string, stateDirectory: string): boolean {
  const allowed = (relativePath: string, absolutePath: string) =>
    evaluateRead(relativePath, absolutePath, {stateDirectory}).effect === 'allow';
  if (!allowed(path, join(workspace.root, path))) return false;
  try {
    const file = workspace.resolve(path);
    return allowed(file.relative, file.absolute);
  } catch (error) {
    return error instanceof WorkspaceDenied && error.reason === 'not-found';
  }
}

function projectContextOptions(options: ProjectContextOptions): ProjectContextOptions & {maxBytes: number} {
  const envBudget = process.env.FUTRYN_PROJECT_CONTEXT_MAX_BYTES ?? process.env.HANNES_PROJECT_CONTEXT_MAX_BYTES;
  if (options.maxBytes === undefined && envBudget !== undefined && !/^\d+$/.test(envBudget)) {
    throw new FutrynError('INVALID_INPUT');
  }
  const resolved = {...options, maxBytes: options.maxBytes ?? (envBudget === undefined ? 32768 : Number(envBudget))};
  const valid = [resolved.maxBytes, resolved.maxFileBytes ?? 16384].every(
    n => Number.isSafeInteger(n) && n >= 0 && n <= 65536,
  );
  if (!valid) throw new FutrynError('INVALID_INPUT');
  return resolved;
}

/** What a conversation is wired to inside a client session. All optional for bare CLI conversations. */
interface ConversationWiring {
  tools?: ToolPort;
  workspaceRoot?: string;
  projectContext?: ProjectContextPort;
  skills?: SkillsPort;
  memories?: Pick<MemoriesPort, 'context'>;
  /** Lower-trust context messages (custom agent catalog / definition), never ModelRequest.instructions. */
  contextNotes?: () => string[];
  budget?: () => TurnBudget | undefined;
  /** Plan/review modes cannot be turned into mutating artifact recovery. */
  analysisOnly?: () => boolean;
  modeInstructions?: () => string;
}

/**
 * The composition root (CLAUDE.md, dependency rules): the only place that wires models, security,
 * persistence, core, tools, workspace and the SDK client together.
 */
export function startup(
  directory = defaultStateDirectory(),
  services: {
    vault?: CredentialVault;
    fetch?: typeof fetch;
    /** Test seams for the ChatGPT sign-in (issuer, browser opener, clock). */
    chatgpt?: ChatGPTOAuthOptions;
    /** Test seam for user skill discovery; production uses the OS home directory. */
    skillsHome?: string;
    /** Isolated user home for memory fixtures; production always uses ~/.futryn. */
    memoriesHome?: string;
    /** Host opener for an explicit /memory open action, never a model tool. */
    openMemoryFolder?: (path: string) => Promise<void>;
    commands?: (workspaceRoot: string, stateDirectory: string) => CommandRuntime;
    /** Session-only CLI launch permission overrides (ADR 0055). */
    permissions?: LaunchPermissionFlags;
  } = {},
) {
  let fullAccessWarned = false;
  const commandRuntimes = new CommandRuntimes();
  process.umask(0o077);
  const db = openPrivateDatabase(directory);
  const settings = new SqliteSettings(db);
  const redactor = new Redactor();
  const webKeys: SearchKeys = Object.fromEntries(
    ['EXA_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'PARALLEL_API_KEY'].map(name => [name, process.env[name]]),
  );
  for (const value of Object.values(webKeys)) if (value) redactor.register(value);
  const webSearch = new WebSearchClient({keys: webKeys, redact: text => redactor.text(text), fetch: services.fetch});
  const languageServerManagers = new Set<LspManager>();
  /** Background subagents are cancelled when the session closes (S5b): one hook per client. */
  const subagentShutdowns = new Set<() => Promise<void>>();
  const conversations = new SqliteConversations(db, value => redactor.text(value));
  const toolAudit = new ToolAuditStore(db);
  const customThemes = new FileCustomThemeStore(directory);
  const vault = services.vault ?? new SecureVault(redactor);
  const oauth = new OpenRouterPKCE(redactor, services.fetch);
  settings.update(state => {
    state.chatgptHostID ??= crypto.randomUUID();
  });
  const chatgpt = new ChatGPTOAuth(redactor, {
    fetch: services.fetch,
    hostID: `urn:uuid:${settings.read().chatgptHostID!}`,
    ...services.chatgpt,
  });
  // Credentials of accounts removed by a migration (ADR 0045, 0049) are deleted here, where the vault lives.
  // A failed deletion stays queued and is retried on the next start.
  const outbox = new MigrationOutbox(db);
  // Leftover Codex runtime profiles (ADR 0049) may hold a copy of its auth.json; nothing uses them now.
  try {
    removeRuntimeProfiles(directory);
  } catch {
    /* retried on the next start */
  }
  const migrationCleanup = (async () => {
    for (const row of outbox.pendingCredentials()) {
      try {
        await vault.delete(row.credential);
        outbox.done(row.id);
      } catch {
        /* retried on the next start */
      }
    }
  })();
  const registry = new ProviderRegistry(settings);
  // Host providers (ADR 0046) come only from <state directory>/config.toml, never from a workspace.
  const hostConfig = new HostConfigStore(directory, reservedProviderIds);
  const hostEntries = new Map<string, HostProviderEntry>();
  const registerHostSecrets = (provider: Provider) => {
    for (const variable of Object.values(provider.envHttpHeaders ?? {}))
      if (process.env[variable]) redactor.register(process.env[variable]!);
  };
  const tokens = new TokenCommandRunner(
    id => hostEntries.get(id)?.tokenCommand,
    token => redactor.register(token),
  );
  /** Make the settings match the config file: its providers replace same-id entries; removed ones go unless accounts use them. */
  const syncHostProviders = () => {
    const loaded = hostConfig.load();
    if (loaded.usable) {
      // Any provider that is gone or changed forgets its cached token (it is also bound to its destination).
      for (const id of hostEntries.keys()) tokens.invalidate(id);
      hostEntries.clear();
      for (const entry of loaded.providers) {
        hostEntries.set(entry.provider.id, entry);
        registerHostSecrets(entry.provider);
      }
      const state = settings.read();
      const wanted = new Set(loaded.providers.map(e => e.provider.id));
      const next = state.providers.filter(
        p => !(p.source === 'config' && !wanted.has(p.id) && !state.accounts.some(a => a.providerId === p.id)),
      );
      for (const {provider} of loaded.providers) {
        const index = next.findIndex(p => p.id === provider.id);
        if (index >= 0) next[index] = provider;
        else next.push(provider);
      }
      if (JSON.stringify(next) !== JSON.stringify(state.providers))
        settings.update(fresh => {
          fresh.providers = next;
        });
    }
    return loaded;
  };
  let hostLoaded = syncHostProviders();
  /** A custom provider is a host config entry: written to config.toml, then loaded like any other. */
  /** The host config rules applied to a provider built elsewhere (TUI form): render it, parse it back, report why not. */
  const validateHostProvider = (provider: Provider): string | null => {
    try {
      const loaded = loadHostConfig(Bun.TOML.parse(renderProviderToml({provider})), reservedProviderIds);
      return loaded.providers.length ? null : (loaded.diagnostics[0]?.message ?? 'invalid provider');
    } catch {
      return 'invalid provider';
    }
  };
  const addHostProvider = (entry: HostProviderEntry): Provider => {
    if (registry.list().some(x => x.id === entry.provider.id)) throw new FutrynError('INVALID_INPUT');
    if (validateHostProvider(entry.provider)) throw new FutrynError('INVALID_INPUT');
    hostConfig.add(entry);
    hostLoaded = syncHostProviders();
    if (!registry.list().some(x => x.id === entry.provider.id)) throw new FutrynError('INVALID_INPUT');
    return registry.get(entry.provider.id);
  };
  const removeProvider = (id: string) => {
    const provider = registry.get(id);
    if (provider.source === 'config') {
      if (settings.read().accounts.some(a => a.providerId === id)) throw new FutrynError('POLICY');
      hostConfig.remove(id);
    }
    registry.remove(id);
    hostEntries.delete(id);
    tokens.invalidate(id);
  };
  const integrations = new IntegrationRegistry(registry);
  const accounts = new AccountManager(settings, vault);
  const router = new ModelRouter(settings);
  const policy = new ConfiguredNetworkPolicy();

  const transport = (account: Account) =>
    new ProviderTransport(
      registry.get(account.providerId),
      account,
      vault,
      {
        authorize(provider, a) {
          // Re-read durable grants before every network operation, so logout in another process fences new requests.
          const fresh = accounts.get(a.id);
          const changed =
            (fresh.authGeneration ?? 1) !== (a.authGeneration ?? 1) ||
            JSON.stringify(fresh.credential) !== JSON.stringify(a.credential) ||
            JSON.stringify(registry.get(provider.id)) !== JSON.stringify(provider);
          if (changed) throw new FutrynError('POLICY');
          policy.authorize(provider, fresh);
        },
      },
      services.fetch,
      (provider, account, signal) =>
        provider.auth === 'oauth' ? chatgpt.accessToken(account, vault, signal) : tokens.token(provider, signal),
    );

  const catalog = (account: Account) => new ModelCatalog(settings, transport(account));
  /** Re-read on every use, so a model marked 'unsupported' or with new limits takes effect at once. */
  const cachedModel = (account: Account, modelId: string): ModelInfo | undefined =>
    catalog(account)
      .cached()
      .find(m => m.id === modelId);

  const resolveAccount = (id?: string) => {
    const selected = id ?? settings.read().activeAccountId;
    if (!selected) throw new FutrynError('AUTH');
    return accounts.get(selected);
  };

  /** Tools the model may see. Futryn runs every one of them; a provider only answers API requests (ADR 0049). */
  const modelTools = (account: Account, modelId: string, wiring: ConversationWiring): ToolPort | undefined => {
    const {tools} = wiring;
    if (!tools) return undefined;
    return {
      descriptors: () => {
        if (cachedModel(account, modelId)?.capabilities.tools === 'unsupported') return [];
        return tools.descriptors();
      },
      invoke: (call, signal, onOutput, onEvent) => tools.invoke(call, signal, onOutput, onEvent),
    };
  };

  /** The model port: always a direct provider API adapter. */
  const modelPort = (account: Account, selection: Selection, info: ModelInfo) =>
    new ProviderAdapter(transport(account), selection.modelId, info);

  const createConversationForSelection = (
    selection: Selection,
    existingSession?: {id: string; messages: Message[]},
    wiring: ConversationWiring = {},
  ) => {
    const account = accounts.get(selection.accountId);
    if (account.status === 'logged-out') throw new FutrynError('AUTH');
    const info = cachedModel(account, selection.modelId);
    if (!info) throw new FutrynError('NOT_FOUND');
    const baseModel: ModelPort = modelPort(account, selection, info);
    const prepare = (request: ModelRequest): ModelRequest => ({
      ...request,
      ...([request.instructions, wiring.modeInstructions?.()].filter(Boolean).length
        ? {instructions: [request.instructions, wiring.modeInstructions?.()].filter(Boolean).join('\n\n')}
        : {}),
    });
    const guidedModel: ModelPort = {
      stream: (request, signal) => baseModel.stream(prepare(request), signal),
      generate: (request, signal) => baseModel.generate(prepare(request), signal),
    };
    return new Conversation(
      selection,
      redactModel(guidedModel, redactor),
      conversations,
      existingSession,
      modelTools(account, selection.modelId, wiring),
      () => catalog(account).markToolsUnsupported(selection.modelId),
      wiring.projectContext,
      // ADR 0030: the user's optional work budget and the model's reported context window.
      {
        skills: wiring.skills,
        memories: wiring.memories,
        contextNotes: wiring.contextNotes,
        budget: wiring.budget ?? (() => undefined),
        // Parallel `agent` calls must reach the scheduler, which rejects the one beyond max_threads like
        // Codex; the generic shared-slot cap must therefore admit max_threads + 1 (ADR 0033/0058).
        parallelSlots: () => hostLoaded.agents.maxThreads + 1,
        analysisOnly: wiring.analysisOnly ?? (() => false),
        contextLimit: () => cachedModel(account, selection.modelId)?.contextLimit ?? null,
        outputLimit: () => cachedModel(account, selection.modelId)?.outputLimit ?? null,
        streamMaxRetries: () => registry.get(account.providerId).streamMaxRetries,
      },
    );
  };

  const conversation = (project?: string) => createConversationForSelection(router.resolve(project));

  const resumeConversation = (id: string) => {
    const record = conversations.get(id);
    if (!record) throw new FutrynError('NOT_FOUND');
    return createConversationForSelection(record.selection, {id, messages: committedMessages(record)});
  };

  const discoverModels = (account: Account, signal?: AbortSignal) => catalog(account).discover(signal);

  const validateAccount = async (account: Account, signal?: AbortSignal, generate = false) => {
    const provider = registry.get(account.providerId);
    // OpenRouter's /models is public and cannot prove that an API key is valid; its /key endpoint can.
    const checksKey = provider.id === 'openrouter' && provider.baseURL === OPENROUTER_API;
    // Manual catalogs (no model list) can only be validated by generating.
    const generates = generate || (provider.catalog === 'manual' && provider.auth !== 'oauth');
    try {
      if (checksKey) {
        const info = await transport(account).json('key', signal);
        const valid = info && typeof info === 'object' && 'data' in info && info.data && typeof info.data === 'object';
        if (!valid) throw new FutrynError('PROTOCOL');
      }
      // An explicit generation probe validates the pinned model without replacing richer cached
      // metadata with a less complete model-list response.
      const cached = generate ? catalog(account).cached() : [];
      const discovered = cached.length ? {models: cached, stale: false} : await discoverModels(account, signal);
      if (discovered.stale) throw new FutrynError('TRANSPORT');

      const modelId = account.defaultModel ?? discovered.models[0]?.id;
      if (generates && !modelId) throw new FutrynError('NOT_FOUND');
      if (generates && modelId) await generateProbe(account, modelId, signal);
      if (signal?.aborted) throw new FutrynError('CANCELLED');

      accounts.validation(account.id, true, account);
      let validation = 'model-discovery';
      if (generates) validation = 'generation';
      else if (checksKey) validation = 'authenticated-key-and-model-discovery';
      return {
        accountId: account.id,
        providerId: provider.id,
        connection: 'validated',
        models: discovered.models.length,
        validation,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof FutrynError && ['AUTH', 'FORBIDDEN'].includes(error.code)) {
        accounts.validation(account.id, false, account);
      }
      throw error;
    }
  };

  /** A minimal, possibly billable generation that proves the account can use the model. */
  const generateProbe = async (account: Account, modelId: string, signal?: AbortSignal) => {
    const adapter = new ProviderAdapter(transport(account), modelId);
    await adapter.generate(
      {
        requestId: crypto.randomUUID(),
        modelId,
        messages: [{role: 'user', content: 'Reply with OK.'}],
        maxOutputTokens: 16,
        tools: [],
      },
      signal,
    );
  };

  /** One SDK client per workspace: tools, approvals, project context and sessions for the TUI/CLI. */
  const createFutrynClient = (
    workspaceRoot = resolve('.'),
    contextOptions: ProjectContextOptions = {},
  ): FutrynClient => {
    const contextBudget = projectContextOptions(contextOptions);
    const stateDirectory = realpathSync.native(resolve(directory));
    // User-level config defaults (ADR 0055); the environment and CLI launch flags override them, never a workspace file.
    const permissionDefaults = hostLoaded.permissions;
    const effectiveEnv = {
      ...process.env,
      ...(services.permissions?.sandbox ? {FUTRYN_SANDBOX_MODE: services.permissions.sandbox} : {}),
      ...(services.permissions?.approval ? {FUTRYN_APPROVAL_POLICY: services.permissions.approval} : {}),
    };
    const sandboxSettings = sandboxSettingsFromEnv(effectiveEnv, permissionDefaults);
    if (sandboxSettings.mode === 'danger-full-access' && !fullAccessWarned) {
      fullAccessWarned = true;
      process.stderr.write(`${FULL_ACCESS_WARNING}\n`);
    }
    const grants = new SessionGrants();
    const activeConversations = new Map<string, Conversation>();
    let currentTurnConversation: Conversation | undefined;
    let client: FutrynClient | undefined;
    let projectReport: ProjectContextReport | null = null;
    let contextLoader: ProjectContextLoader | undefined;
    let commandRuntime: CommandRuntime | undefined;
    let dispatcher: ToolDispatcher | undefined;
    let workspace: WorkspaceRoot | undefined;
    let diffReport: WorkspaceDiffReport = {
      workspace: resolve(workspaceRoot),
      gitAvailable: false,
      state: 'error',
      message: 'Not inspected. Press R to refresh.',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
    let diffRefresh: Promise<WorkspaceDiffReport> | undefined;
    let terminalReport: TerminalRuntimeReport | undefined;
    const toolsEnabled = () => client?.toolsEnabled() === true;
    const plans = new Map<string, PlanState | null>();
    const memoriesEnabled = process.env.FUTRYN_MEMORY !== '0' && hostLoaded.memoriesEnabled;
    let memoryStore: FileMemories | undefined;
    const memories = () =>
      (memoryStore ??= new FileMemories(
        join(realpathSync.native(services.memoriesHome ?? homedir()), '.futryn'),
        workspaceTree().root,
        text => terminalText(redactor.text(text)),
        {maxUnusedDays: hostLoaded.memoryMaxUnusedDays},
      ));

    // Everything below is created lazily, on first use after folder consent.
    const workspaceTree = () => (workspace ??= new WorkspaceRoot(workspaceRoot));

    let skillCatalog: SkillCatalog | undefined;
    const skills = () =>
      (skillCatalog ??= new SkillCatalog({
        workspace: workspaceTree(),
        home: services.skillsHome,
        canRead: (relative, absolute) =>
          evaluateRead(relative, absolute, {
            stateDirectory:
              relative.startsWith('~/.futryn/skills/') && absolute.startsWith(join(stateDirectory, 'skills') + '/')
                ? undefined
                : stateDirectory,
          }).effect === 'allow' &&
          !['ask', 'deny'].includes(
            permissionRuleDecision(client?.permissionRules(), {tool: 'Read', target: relative}) ?? '',
          ),
      }));

    let agentCatalog: AgentDefinitionCatalog | undefined;
    const agentDefinitions = () =>
      (agentCatalog ??= new AgentDefinitionCatalog({
        workspace: workspaceTree(),
        home: services.skillsHome,
        reserved: isBuiltinAgentName,
        canRead: (relative, absolute) =>
          evaluateRead(relative, absolute, {
            stateDirectory:
              relative.startsWith('~/.futryn/agents/') && absolute.startsWith(join(stateDirectory, 'agents') + '/')
                ? undefined
                : stateDirectory,
          }).effect === 'allow' &&
          !['ask', 'deny'].includes(
            permissionRuleDecision(client?.permissionRules(), {tool: 'Read', target: relative}) ?? '',
          ),
      }));
    const subagentNoticeListeners = new Set<(notice: SubagentNotice) => void>();

    const commands = () => {
      if (commandRuntimes.closed) throw new FutrynError('CANCELLED');
      if (!commandRuntime) {
        commandRuntime = services.commands
          ? services.commands(workspaceTree().root, stateDirectory)
          : createCommandRuntime(
              workspaceTree().root,
              stateDirectory,
              process.env,
              skills().scriptDirectories(),
              skills().userDirectories(),
            );
        commandRuntimes.add(commandRuntime);
      }
      return commandRuntime;
    };

    // Workspace tools (ADR 0017+): offered only while the client allows them, i.e. after the TUI
    // obtained folder consent; approvals go through the client's permission dialog.
    // Language servers run only inside the command sandbox (ADR 0043); no sandbox → unavailable.
    let codeIntel: LspManager | undefined;
    const languageServers = () => {
      if (codeIntel) return codeIntel;
      codeIntel = new LspManager({
        workspace: workspaceTree(),
        canRead: file =>
          evaluateRead(file.relative, file.absolute, {stateDirectory}).effect === 'allow' &&
          !['deny', 'ask'].includes(
            permissionRuleDecision(client?.permissionRules(), {tool: 'Read', target: file.relative}) ?? '',
          ) &&
          !['deny', 'ask'].includes(
            permissionRuleDecision(client?.permissionRules(), {tool: 'Tool', target: 'lsp'}) ?? '',
          ),
        launch: (argv, cwd) => {
          const runtime = commands();
          if (!runtime.spawnService) throw new FutrynError('UNSUPPORTED');
          return runtime.spawnService(argv, cwd);
        },
        available: () => {
          if (commandRuntimes.closed) return false;
          const runtime = commands();
          return !!runtime.spawnService && runtime.availability().ok;
        },
      });
      languageServerManagers.add(codeIntel);
      return codeIntel;
    };

    const currentAgentsConfig = () => {
      const fresh = hostConfig.load();
      return fresh.usable ? fresh.agents : hostLoaded.agents;
    };
    const subagentScheduler = new SubagentScheduler(() => currentAgentsConfig().maxThreads);
    subagentShutdowns.add(() => subagentScheduler.shutdown());

    const resolveRootConversation = (): Conversation | undefined => {
      if (currentTurnConversation) return currentTurnConversation;
      const activeId = client?.activeSession()?.id;
      if (activeId && activeConversations.has(activeId)) return activeConversations.get(activeId);
      return (
        [...activeConversations.values()].find(c => c.activeTurnId() !== undefined) ??
        [...activeConversations.values()].at(-1)
      );
    };

    const lookupSubagentModel = (
      modelRef: string,
      defaultAccountId: string,
    ): {selection: Selection; model: ModelInfo} | undefined => {
      const ref = modelRef.trim();
      if (!ref) return undefined;
      const signedInAccounts = settings.read().accounts.filter(a => a.status !== 'logged-out');
      const colonIdx = ref.indexOf(':');
      if (colonIdx > 0) {
        const prefix = ref.slice(0, colonIdx).trim();
        const targetModelId = ref.slice(colonIdx + 1).trim();
        const matchedAccount = signedInAccounts.find(
          a => a.id === prefix || a.alias === prefix || a.providerId === prefix,
        );
        if (matchedAccount) {
          const model = catalog(matchedAccount)
            .cached()
            .find(m => m.id === targetModelId);
          if (model) return {selection: {accountId: matchedAccount.id, modelId: model.id}, model};
        }
      }
      try {
        const defaultAccount = accounts.get(defaultAccountId);
        if (defaultAccount.status !== 'logged-out') {
          const onDefault = catalog(defaultAccount)
            .cached()
            .find(m => m.id === ref);
          if (onDefault) return {selection: {accountId: defaultAccount.id, modelId: onDefault.id}, model: onDefault};
        }
      } catch {
        /* fallback to other signed-in accounts */
      }
      for (const acc of signedInAccounts) {
        if (acc.id === defaultAccountId) continue;
        const found = catalog(acc)
          .cached()
          .find(m => m.id === ref);
        if (found) return {selection: {accountId: acc.id, modelId: found.id}, model: found};
      }
      return undefined;
    };

    const availableSubagentModels = (accountId: string): string[] => {
      try {
        return catalog(accounts.get(accountId))
          .cached()
          .map(m => m.id);
      } catch {
        return [];
      }
    };

    // Isolated children (`isolation: "worktree"`, S5c): host-created Git worktrees, one per child id.
    // Per-user, 0700, next to (not inside) the state directory: reads and patches inside the state directory are
    // denied by policy, and the child must be able to use its worktree.
    const gitWorktrees = new GitWorktrees({
      workspaceRoot,
      baseDirectory: join(dirname(stateDirectory), `${basename(stateDirectory)}-worktrees`),
    });
    const worktreeInfos = new Map<string, WorktreeInfo>();
    const worktreePort: SubagentWorktreePort = {
      acquire: agentId => {
        if ((client ? client.sandboxConfig() : sandboxSettings).mode === 'read-only')
          return {
            ok: false,
            code: 'MODE_RESTRICTED',
            message: 'The read-only sandbox does not allow creating worktrees. Nothing was executed.',
          };
        try {
          let info = worktreeInfos.get(agentId);
          if (!info || !gitWorktrees.exists(info)) info = gitWorktrees.open(agentId) ?? gitWorktrees.create(agentId);
          worktreeInfos.set(agentId, info);
          return {ok: true, worktree: {path: info.path, branch: info.branch, gitCommonDir: info.gitCommonDir}};
        } catch (error) {
          const reason = error instanceof WorktreeError ? error.reason : 'create-failed';
          return {
            ok: false,
            code: reason === 'create-failed' ? 'EXECUTION_FAILED' : 'UNSUPPORTED',
            message:
              reason === 'not-a-repository'
                ? 'isolation "worktree" needs a Git repository; this workspace is not one. Run the subagent without isolation.'
                : reason === 'git-unavailable'
                  ? 'isolation "worktree" needs Git, which could not be started.'
                  : reason === 'no-commit'
                    ? 'isolation "worktree" needs at least one commit in the repository.'
                    : 'The Git worktree could not be created.',
          };
        }
      },
      finish: agentId => {
        const info = worktreeInfos.get(agentId);
        if (!info) return undefined;
        const outcome = gitWorktrees.finish(info);
        if (outcome.removed) worktreeInfos.delete(agentId);
        return {
          changed: outcome.changed,
          worktree: {path: info.path, branch: info.branch, gitCommonDir: info.gitCommonDir},
        };
      },
    };

    const createSubagentManager = (options: {
      depth: number;
      getParentConversation: () => Conversation | undefined;
      getParentSessionId: () => string;
      getParentSelection: () => Selection;
      getParentReasoningEffort: () => string | undefined;
      getParentAnalysisOnly: () => boolean;
    }): SubagentManager =>
      new SubagentManager({
        depth: options.depth,
        scheduler: subagentScheduler,
        getConfig: currentAgentsConfig,
        getParentState: () => {
          const conv = options.getParentConversation();
          return {
            sessionId: conv?.id ?? options.getParentSessionId(),
            turnId: conv?.activeTurnId() ?? client?.currentTurnId(),
            selection: options.getParentSelection(),
            reasoningEffort: options.getParentReasoningEffort(),
            analysisOnly: options.getParentAnalysisOnly(),
            messages: conv ? conv.forkableHistory() : (client?.activeSession()?.messages ?? []),
            limits: conv?.turnLimits(),
          };
        },
        lookupModel: lookupSubagentModel,
        availableModelIds: availableSubagentModels,
        worktrees: worktreePort,
        store: conversations,
        addParentUsage: usage => {
          options.getParentConversation()?.addSubagentUsage(usage);
        },
        customAgents: {
          report: () => {
            if (!toolsEnabled()) return {definitions: [], errors: [], warnings: []};
            try {
              return agentDefinitions().report();
            } catch {
              return {definitions: [], errors: [{code: 'AGENT_DISCOVERY_FAILED'}], warnings: []};
            }
          },
          load: name => (toolsEnabled() ? agentDefinitions().load(name) : undefined),
        },
        // Running children take the message as steering; the child's own turn journals it.
        steerChild: (agentId, message) =>
          activeConversations.get(agentId)?.steer(message) ?? {accepted: false, reason: 'no_active_turn'},
        // The parent's running turn is steered; otherwise the notification is durable next-turn input.
        deliverToParent: (parentId, text) => {
          const outcome = activeConversations.get(parentId)?.steer(text);
          if (outcome?.accepted) return 'steered';
          conversations.enqueueNextTurn(parentId, text);
          return 'queued';
        },
        onNotice: notice => {
          for (const listener of [...subagentNoticeListeners]) listener(notice);
        },
        redact: text => terminalText(redactor.text(text)),
        runChildTurn: async function* (runContext: ChildRunContext, childSignal: AbortSignal) {
          // Subagents inherit ONLY read grants from the parent session (Wave 2 S5a).
          const childGrants = grants.createChild();
          let childConv: Conversation | undefined;
          const parentIsAnalysisOnly = () => ['plan', 'review'].includes(client?.mode() ?? 'chat');
          const nestedSubagents = createSubagentManager({
            depth: runContext.depth,
            getParentConversation: () => childConv,
            getParentSessionId: () => runContext.agentId,
            getParentSelection: () => runContext.selection,
            getParentReasoningEffort: () => runContext.reasoningEffort,
            getParentAnalysisOnly: () => runContext.profile.readOnly || parentIsAnalysisOnly(),
          });
          // An isolated child sees only its worktree: its own workspace root, command runtime and writable root.
          const worktree = runContext.worktree;
          const childWorkspace = worktree ? new WorkspaceRoot(worktree.path) : workspaceTree();
          const childCommands = worktree
            ? services.commands
              ? services.commands(childWorkspace.root, stateDirectory)
              : createCommandRuntime(
                  childWorkspace.root,
                  stateDirectory,
                  process.env,
                  [...skills().scriptDirectories(), worktree.gitCommonDir],
                  [...skills().userDirectories(), worktree.gitCommonDir],
                )
            : commands();
          const childDispatcher = new ToolDispatcher({
            workspace: childWorkspace,
            skills: skills(),
            // Subagents never load or mutate user/project memories (Wave 2 S5a).
            memories: undefined,
            grants: childGrants,
            analysisOnly: () => runContext.profile.id === 'plan' || parentIsAnalysisOnly(),
            stateDirectory,
            readPolicy: relative => permissionRuleDecision(client?.permissionRules(), {tool: 'Read', target: relative}),
            commands: childCommands,
            sandbox: () =>
              effectiveSubagentSandbox(client ? client.sandboxConfig() : sandboxSettings, runContext.profile),
            turnId: () => childConv?.activeTurnId() ?? runContext.parentTurnId ?? client?.currentTurnId(),
            codeIntel: worktree ? undefined : languageServers(),
            web: {
              search: (query, count, signal) => webSearch.search(query, count, signal),
              searchEndpoint: webSearch.endpoint,
            },
            agentState: {
              updatePlan: plan => {
                conversations.savePlan(runContext.agentId, plan);
              },
              canAskUser: () => false,
            },
            subagents: nestedSubagents,
            redact: (text, incomplete) => (incomplete ? redactor.stream().push(text) : redactor.text(text)),
            audit: record => toolAudit.append(record),
            approve: (request, signal) =>
              client
                ? client.requestPermission(toolPermissionRequest(request, runContext.attribution), signal)
                : Promise.resolve('deny'),
          });

          const childToolPort: ToolPort = {
            descriptors: () => {
              if (!toolsEnabled()) return [];
              return filterSubagentTools(childDispatcher.descriptors(), runContext.profile, {
                depth: runContext.depth,
                maxDepth: runContext.maxDepth,
                parentAnalysisOnly: parentIsAnalysisOnly(),
              });
            },
            invoke: async (call, signal, onOutput, onEvent): Promise<ToolResult> => {
              if (!toolsEnabled()) {
                return {
                  callId: call.id,
                  name: call.name,
                  status: 'denied',
                  code: 'TOOLS_DISABLED',
                  content: 'Workspace tools are not enabled for this session.',
                };
              }
              if (call.name === 'agent' && runContext.depth >= runContext.maxDepth) {
                return {
                  callId: call.id,
                  name: call.name,
                  status: 'error',
                  code: 'AGENT_DEPTH_LIMIT',
                  content: 'Agent depth limit reached. Solve the task yourself.',
                };
              }
              if (
                !isToolAllowedForProfile(call.name, runContext.profile, {
                  depth: runContext.depth,
                  maxDepth: runContext.maxDepth,
                  parentAnalysisOnly: parentIsAnalysisOnly(),
                })
              ) {
                return {
                  callId: call.id,
                  name: call.name,
                  status: 'denied',
                  code: 'DENIED',
                  content: `Tool "${call.name}" is not permitted for subagent type "${runContext.profile.id}".`,
                };
              }
              const result = await childDispatcher.invoke(call, signal, onOutput, onEvent);
              return call.name === 'read' ? withNestedInstructions(result, signal) : result;
            },
          };

          const storedChild = runContext.resume ? conversations.get(runContext.agentId) : undefined;
          childConv = createConversationForSelection(
            runContext.selection,
            {
              id: runContext.agentId,
              messages: storedChild ? committedMessages(storedChild) : runContext.initialMessages,
            },
            {
              tools: childToolPort,
              skills: skillPort,
              memories: undefined,
              contextNotes: () => runContext.contextNotes,
              workspaceRoot: worktree ? childWorkspace.root : resolve(workspaceRoot),
              projectContext,
              budget: () => runContext.limits.budget,
              analysisOnly: () => runContext.profile.id === 'plan' || parentIsAnalysisOnly(),
              modeInstructions: () => runContext.profile.developerInstructions,
            },
          );
          activeConversations.set(childConv.id, childConv);
          try {
            yield* childConv.send(
              runContext.prompt,
              childSignal,
              runContext.limits.maxOutputTokens,
              runContext.limits.maxEstimatedCostUSD,
              runContext.reasoningEffort,
            );
          } finally {
            activeConversations.delete(childConv.id);
            if (worktree) await Promise.resolve(childCommands.shutdown?.()).catch(() => undefined);
          }
        },
      });

    const rootSubagents = createSubagentManager({
      depth: 0,
      getParentConversation: resolveRootConversation,
      getParentSessionId: () => client?.activeSession()?.id ?? resolveRootConversation()?.id ?? '',
      getParentSelection: () =>
        client?.activeSession()?.selection ??
        (resolveRootConversation() ? conversations.get(resolveRootConversation()!.id)?.selection : undefined) ??
        router.resolve(workspaceRoot),
      getParentReasoningEffort: () => client?.status().reasoningEffort ?? undefined,
      getParentAnalysisOnly: () => ['plan', 'review'].includes(client?.mode() ?? 'chat'),
    });

    const tools = () =>
      (dispatcher ??= new ToolDispatcher({
        workspace: workspaceTree(),
        skills: skills(),
        memories: memoriesEnabled
          ? {
              get directory() {
                return memories().directory;
              },
              list: () => memories().list(),
              read: name => memories().read(name),
              write: entry => memories().write(entry),
              delete: name => memories().delete(name),
              context: () => memories().context(),
            }
          : undefined,
        grants,
        analysisOnly: () => ['plan', 'review'].includes(client?.mode() ?? 'chat'),
        stateDirectory,
        readPolicy: relative => permissionRuleDecision(client?.permissionRules(), {tool: 'Read', target: relative}),
        commands: commands(),
        // The session's sandbox (Read Only / Auto / Full Access presets) is read for every call.
        sandbox: () => (client ? client.sandboxConfig() : sandboxSettings),
        turnId: () => client?.currentTurnId(),
        codeIntel: languageServers(),
        web: {
          search: (query, count, signal) => webSearch.search(query, count, signal),
          searchEndpoint: webSearch.endpoint,
        },
        agentState: {
          // The plan belongs to the active session and survives restart (ADR 0042).
          updatePlan: plan => {
            const id = client?.activeSession()?.id;
            if (!id) return;
            conversations.savePlan(id, plan);
            plans.set(id, plan);
            client?.planUpdated();
          },
          // Questions go to the attached UI; without one the tool reports itself unavailable.
          askUser: (questions, signal) =>
            client
              ? client.askUser(questions, signal)
              : Promise.resolve({kind: 'unavailable' as const, reason: 'no client'}),
          canAskUser: () => client?.userInputReady() === true,
        },
        subagents: rootSubagents,
        redact: (text, incomplete) => (incomplete ? redactor.stream().push(text) : redactor.text(text)),
        audit: record => toolAudit.append(record),
        approve: (request, signal) =>
          client ? client.requestPermission(toolPermissionRequest(request), signal) : Promise.resolve('deny'),
      }));

    const loader = () =>
      (contextLoader ??= new ProjectContextLoader(
        workspaceTree(),
        {
          read: (path, budget, readSignal) => {
            if (!toolsEnabled()) return Promise.resolve({status: 'denied', code: 'WORKSPACE_NOT_APPROVED'});
            return tools().readInstruction(path, budget, readSignal);
          },
        },
        contextBudget,
      ));
    const sessionInstructionDirectories = (): string[] => {
      const id = client?.activeSession()?.id;
      return id ? conversations.listInstructionDirectories(id) : [];
    };

    /**
     * Nested AGENTS.md (ADR 0041, after OpenCode `read`): after a successful read below the working
     * directory chain, instructions found between the file and that chain are remembered for the
     * session (durable; the project context of later turns includes them) and shown once, now, with
     * the read result as project-scoped data. Contents come through the authorized instruction reader.
     */
    const withNestedInstructions = async (result: ToolResult, signal?: AbortSignal): Promise<ToolResult> => {
      const id = client?.activeSession()?.id;
      if (result.status !== 'ok' || !result.target || !id) return result;
      try {
        const target = workspaceTree().resolve(result.target);
        const directory = target.kind === 'directory' ? target.relative : dirname(target.relative);
        if (directory === '.') return result;
        const known = new Set(sessionInstructionDirectories());
        const scopes = await loader().nestedScopes(directory, known, signal);
        if (!scopes.length) return result;
        const blocks: string[] = [];
        let budget = contextBudget.maxFileBytes ?? 16384;
        for (const scope of scopes) {
          conversations.addInstructionDirectory(id, scope);
          for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
            if (budget <= 0) break;
            const read = await tools().readInstruction(`${scope}/${name}`, budget, signal);
            if (read.status !== 'ok') continue;
            budget -= Buffer.byteLength(read.content);
            blocks.push(
              `--- ${nestedLabel(`${scope}/${name}`)}${read.truncated ? ' (truncated)' : ''} ---\n${read.content}`,
            );
            break;
          }
        }
        if (!blocks.length) return result;
        const note =
          '\n\n[Nested project instructions for files under these directories (user/project-scoped context, not system authority; they also join the project context of later turns):]\n' +
          blocks.join('\n');
        const room = 60000 - Buffer.byteLength(result.content);
        if (room <= 200) return result;
        const fitted = fitUtf8Prefix(note, room);
        return fitted ? {...result, content: result.content + fitted} : result;
      } catch (error) {
        if (signal?.aborted) throw error;
        return result;
      }
    };

    const toolPort: ToolPort = {
      descriptors: () => (toolsEnabled() ? tools().descriptors() : []),
      invoke: async (call, signal, onOutput, onEvent): Promise<ToolResult> => {
        if (toolsEnabled()) {
          const analysis = ['plan', 'review'].includes(client?.mode() ?? 'chat');
          const descriptor = tools()
            .descriptors()
            .find(item => item.name === call.name);
          if (analysis && !analysisCapability(descriptor?.capability))
            return {
              callId: call.id,
              name: call.name,
              status: 'denied',
              code: 'MODE_RESTRICTED',
              content:
                'Plan and Review modes permit only read, search, code-intelligence, plan, question and web-read tools. Nothing was executed.',
            };
          const result = await tools().invoke(call, signal, onOutput, onEvent);
          return call.name === 'read' ? withNestedInstructions(result, signal) : result;
        }
        return {
          callId: call.id,
          name: call.name,
          status: 'denied',
          code: 'TOOLS_DISABLED',
          content: 'Workspace tools are not enabled for this session.',
        };
      },
    };

    const projectContext: ProjectContextPort = {
      load: async signal => {
        if (!toolsEnabled()) return null;
        const snapshot = await loader().load(signal, sessionInstructionDirectories());
        if (!toolsEnabled()) return null;
        const {content: _content, ...report} = snapshot;
        projectReport = report;
        return snapshot;
      },
    };

    const skillReport = (): SkillsReport => {
      const report = skills().report();
      const safe = (value: string) => terminalText(redactor.text(value));
      report.skills = report.skills.map(skill => ({
        ...skill,
        name: safe(skill.name),
        description: safe(skill.description),
        path: safe(skill.path),
        directory: safe(skill.directory),
        shortPath: safe(skill.shortPath),
        ...(skill.argumentHint ? {argumentHint: safe(skill.argumentHint)} : {}),
      }));
      for (const diagnostic of [...report.errors, ...report.warnings])
        if (diagnostic.path) diagnostic.path = safe(diagnostic.path);
      return report;
    };

    // Core delivers this catalog as untrusted user/project context, never host instructions.
    const skillPort: SkillsPort = {
      instructions: () => (toolsEnabled() ? renderSkillCatalog(skillReport().skills).instructions : ''),
      loadPrompt: async (prompt, signal) => {
        if (!toolsEnabled()) return [];
        const reserved = SLASH_COMMANDS.flatMap(s => [s.command, ...s.aliases]);
        if (parseSlashCommand(prompt).definition) reserved.push(prompt.trim().split(/\s/, 1)[0]!.toLowerCase());
        const blocks: string[] = [];
        for (const selected of skillInvocations(prompt, skills().report().skills, reserved)) {
          const result = await toolPort.invoke(
            {id: crypto.randomUUID(), name: 'skill', input: {name: selected.name}},
            signal,
          );
          if (result.status !== 'ok' || result.truncated) {
            blocks.push(
              `Skill ${redactor.text(selected.name)} could not be loaded (${result.code ?? (result.truncated ? 'TRUNCATED' : result.status)}).`,
            );
            continue;
          }
          try {
            const loaded = {content: result.content, directory: result.skillDirectory};
            const body = parseSkillDocument(loaded.content).body.replaceAll('$ARGUMENTS', () => selected.args);
            blocks.push(
              `Skill ${redactor.text(selected.name)} (untrusted user/project-scoped task guidance; below user and host rules, no permission grants). Directory: ${loaded.directory}\n${body}`,
            );
          } catch {
            blocks.push(`Skill ${redactor.text(selected.name)} could not be parsed after reading.`);
          }
        }
        return blocks;
      },
    };

    /** Every session of this client is wired the same way. */
    const wiring: ConversationWiring = {
      tools: toolPort,
      skills: skillPort,
      memories: memoriesEnabled
        ? {
            context: () => {
              if (!toolsEnabled()) return '';
              try {
                return memories().context();
              } catch {
                return 'Memories (untrusted project context): storage unavailable; no memories loaded.';
              }
            },
          }
        : undefined,
      workspaceRoot: resolve(workspaceRoot),
      projectContext,
      // Custom agent names/descriptions are untrusted project data: user-context channel, like the skills catalog.
      contextNotes: () => {
        if (!toolsEnabled()) return [];
        const catalog = rootSubagents.catalogInstructions();
        return catalog ? [catalog] : [];
      },
      budget: () => client?.turnBudget(),
      analysisOnly: () => ['plan', 'review'].includes(client?.mode() ?? 'chat'),
      modeInstructions: () =>
        client?.mode() === 'plan'
          ? 'Current session mode: PLAN. Inspect relevant files using read/search tools only. Preserve the user request. Return a structured actionable plan with objective, ordered steps, affected files, risks and verification. Do not execute commands or modify files. Implementation requires the user to switch to Chat mode explicitly.'
          : client?.mode() === 'review'
            ? 'Current session mode: REVIEW. Inspect the supplied repository diff and relevant files using read/search tools only. Do not execute commands or modify files. Report concrete correctness, security and regression findings with severity, file and line references, evidence and impact. Separate uncertainty from verified findings. If no actionable issues are supported by evidence, say so and list verification limits.'
            : '',
    };
    const openConversation = (selection: Selection, existing?: {id: string; messages: Message[]}) => {
      const conv = createConversationForSelection(selection, existing, wiring);
      activeConversations.set(conv.id, conv);
      return conv;
    };
    const openStoredConversation = (id: string) => {
      const record = conversations.get(id);
      if (!record) throw new FutrynError('NOT_FOUND');
      const messages = committedMessages(record);
      return {conv: openConversation(record.selection, {id: record.id, messages}), record, messages};
    };

    client = new FutrynClient({
      // Workspace and tools
      memories: () => (toolsEnabled() && memoriesEnabled ? memories().list() : []),
      memoryDirectory: () =>
        toolsEnabled() && memoriesEnabled ? terminalText(redactor.text(memories().directory)) : null,
      openMemoryDirectory: async () => {
        if (!toolsEnabled() || !memoriesEnabled) throw new FutrynError('UNSUPPORTED');
        memories().prepareDirectory(); // Explicit user action: ensure/validate the fixed private folder.
        await (services.openMemoryFolder ?? (path => openExternalURL(pathToFileURL(path).href)))(memories().directory);
      },
      memoryAction: async (action, name, entry) =>
        toolPort.invoke({id: crypto.randomUUID(), name: 'memory', input: {...entry, action, name}}),
      skills: () => (toolsEnabled() ? skillReport() : {skills: [], errors: [], warnings: []}),
      availableTools: () =>
        toolsEnabled()
          ? tools()
              .descriptors()
              .map(d => d.name)
          : [],
      runShellCommand: async (command, signal, onOutput, context) => {
        if (!context) throw new FutrynError('INVALID_INPUT');
        const stored = conversations.get(context.sessionId);
        if (!stored) throw new FutrynError('NOT_FOUND');
        try {
          return await runUserShellCommand({
            store: conversations,
            sessionId: stored.id,
            selection: stored.selection,
            callId: context.callId,
            command,
            signal,
            onOutput,
            invoke: (call, commandSignal, output) => toolPort.invoke(call, commandSignal, output),
          });
        } finally {
          // The next model turn must reopen journal-backed history, including this user shell result.
          activeConversations.delete(stored.id);
        }
      },
      getProjectContext: () => (toolsEnabled() && projectReport ? structuredClone(projectReport) : null),
      permissionMode: permissionModeFromEnv(effectiveEnv, permissionDefaults),
      sandboxMode: sandboxSettings.mode,
      sandboxNetwork: sandboxSettings.network,
      getPlan: id => {
        if (!plans.has(id)) plans.set(id, conversations.loadPlan(id));
        return plans.get(id) ?? null;
      },
      subagents: sessionId => (sessionId ? rootSubagents.listSubagents(sessionId) : []),
      inspectSubagent: agentId => rootSubagents.inspectSubagent(agentId),
      agentTypes: () => rootSubagents.agentTypes(),
      stopSubagent: agentId => rootSubagents.stopSubagent(agentId),
      observeSubagentNotices: listener => {
        subagentNoticeListeners.add(listener);
        return () => subagentNoticeListeners.delete(listener);
      },
      toolGrants: {
        list: () => grants.list().map(grant => grantLabel(grant, workspaceTree())),
        clear: () => grants.clear(),
      },
      workspace: resolve(workspaceRoot),
      terminalRuntime: () => {
        if (!terminalReport) {
          const runtime = commands();
          const availability = runtime.availability();
          terminalReport = {
            label: runtime.label,
            available: availability.ok,
            ...(!availability.ok ? {reason: availability.reason} : {}),
            sandbox: sandboxSettings.mode,
            escalation: sandboxSettings.escalation,
            limitations: runtime.id.startsWith('native-macos')
              ? [
                  'Detached setsid descendants may survive; termination can be unconfirmed.',
                  'Secret files are readable unless FUTRYN_SANDBOX_HIDE_SECRETS=1.',
                ]
              : runtime.id.startsWith('native-linux')
                ? ['Linux bubblewrap has not received live platform acceptance.']
                : [],
          };
        }
        // The sandbox and escalation are the session's current preset (ADR 0055), not a startup snapshot.
        const config = client?.sandboxConfig() ?? sandboxSettings;
        return {
          ...terminalReport,
          sandbox: terminalReport.available ? config.mode : 'unavailable',
          escalation: config.escalation,
          limitations:
            config.mode === 'danger-full-access'
              ? ['Full Access: commands run WITHOUT the OS sandbox and with network.', ...terminalReport.limitations]
              : terminalReport.limitations,
        };
      },
      settings,
      listWorkspaceFiles: query => scanWorkspaceFiles(workspaceRoot, query),
      readAllowedWithoutApproval: path => readAllowedWithoutApproval(workspaceTree(), path, stateDirectory),
      getWorkspaceDiff: () => diffReport,
      refreshWorkspaceDiff: () => {
        if (!toolsEnabled())
          return Promise.resolve({
            ...diffReport,
            gitAvailable: false,
            state: 'denied' as const,
            files: [],
            totalAdditions: 0,
            totalDeletions: 0,
          });
        diffRefresh ??= refreshWorkspaceGitDiff(workspaceRoot)
          .then(rawReport => {
            const report = {
              ...rawReport,
              files: rawReport.files.map(file => ({
                ...file,
                path: terminalText(redactor.text(file.path)),
                ...(file.oldPath ? {oldPath: terminalText(redactor.text(file.oldPath))} : {}),
                lines: file.lines.map(line => ({...line, content: terminalText(redactor.text(line.content))})),
              })),
            };
            if (toolsEnabled()) diffReport = report;
            return toolsEnabled()
              ? report
              : {
                  ...report,
                  gitAvailable: false,
                  state: 'denied' as const,
                  files: [],
                  totalAdditions: 0,
                  totalDeletions: 0,
                };
          })
          .finally(() => {
            diffRefresh = undefined;
          });
        return diffRefresh;
      },
      sanitizeText: text => terminalText(redactor.text(text)),

      // Providers and sign-in
      listIntegrations: () => integrations.list(),
      beginProviderAuth: async (providerId, _methodId, signal) => {
        const integration = integrations.get(providerId);
        if (integration?.provider.auth === 'oauth') return chatgpt.begin(signal);
        if (!integration?.methods.some(m => m.id === 'openrouter-oauth')) throw new FutrynError('UNSUPPORTED');
        return oauth.begin();
      },
      completeProviderAuth: async (providerId, challengeId, code, signal) => {
        const integration = integrations.get(providerId);
        if (!integration?.methods.some(m => m.id === 'openrouter-oauth')) throw new FutrynError('UNSUPPORTED');
        return oauth.complete(challengeId, code, signal);
      },
      providerAuthProgress: id => {
        if (!chatgpt.has(id)) throw new FutrynError('NOT_FOUND');
        return chatgpt.progress(id);
      },
      completeOAuthSignIn: (_providerId, id, signal) => chatgpt.complete(id, signal),
      cancelProviderAuth: async id => {
        oauth.cancel(id);
        chatgpt.cancel(id);
      },
      listProviders: () => registry.list(),
      listProviderPresets: () => [...providerPresets],
      addProvider: p => {
        const provider = {...p, baseURL: validateEndpoint(p.baseURL)};
        if (provider.source !== 'config') return registry.add(provider);
        return addHostProvider({provider});
      },
      removeProvider,
      validateHostProvider,
      hostConfigDiagnostics: () =>
        hostLoaded.diagnostics.map(d => (d.providerId ? `${d.providerId}: ` : '') + d.message),

      // Accounts and models
      listAccounts: () => settings.read().accounts,
      getAccount: idOrAlias => accounts.get(idOrAlias),
      addAccount: (providerId, alias, credential, secret) => accounts.add(providerId, alias, credential, secret),
      reauthenticateAccount: (id, credential, secret) => accounts.reauthenticate(id, credential, secret),
      useAccount: idOrAlias => accounts.use(idOrAlias),
      renameAccount: (idOrAlias, newAlias) => {
        const target = accounts.get(idOrAlias);
        accounts.rename(target.id, newAlias);
        return accounts.get(target.id);
      },
      logoutAccount: async (idOrAlias, remove) => {
        await accounts.logout(accounts.get(idOrAlias).id, remove);
      },
      validateAccount,
      fetchAccountLimits: (account, signal) => {
        const provider = registry.get(account.providerId);
        // Only OpenRouter's official endpoint has a documented key-credit API; others report nothing.
        if (provider.id !== 'openrouter' || provider.baseURL !== OPENROUTER_API) return null;
        return transport(account)
          .json('key', signal)
          .then(body => {
            const {items, freeTier} = parseOpenRouterKeyLimits(body);
            return {items, note: freeTier ? 'Free-tier key' : undefined};
          });
      },
      discoverModels,
      cachedModels: account => catalog(account).cached(),
      addManualModel: (account, modelId) => catalog(account).manual(modelId),
      selectModel: (account, model, project) => router.select(account, model, project),
      resolveSelection: project => {
        try {
          return router.resolve(project);
        } catch {
          return null;
        }
      },

      // Sessions
      listSessions: () => conversations.list(),
      getSession: id => conversations.get(id),
      deleteSession: id => {
        activeConversations.delete(id);
        return conversations.delete(id);
      },
      forkSession: (id, selection) => {
        // Validate the target account/model before creating any durable copy.
        createConversationForSelection(selection, {id, messages: []});
        const record = conversations.fork(id, selection);
        const messages = committedMessages(record);
        const conv = openConversation(selection, {id: record.id, messages});
        return {id: conv.id, selection, messages};
      },
      startSession: project => {
        const conv = openConversation(router.resolve(project));
        return {id: conv.id, selection: router.resolve(project), messages: []};
      },
      resumeSession: id => {
        const {conv, record, messages} = openStoredConversation(id);
        return {id: conv.id, selection: record.selection, messages};
      },
      sendTurn: async function* (
        sessionId,
        content,
        signal,
        maxOutputTokens,
        maxEstimatedCostUSD,
        reasoningEffort,
        queuedInputId,
      ) {
        const conv = activeConversations.get(sessionId) ?? openStoredConversation(sessionId).conv;
        const previousTurnConversation = currentTurnConversation;
        currentTurnConversation = conv;
        try {
          yield* conv.send(content, signal, maxOutputTokens, maxEstimatedCostUSD, reasoningEffort, queuedInputId);
        } finally {
          currentTurnConversation = previousTurnConversation;
        }
      },
      compactSession: (sessionId, instructions, signal) =>
        (activeConversations.get(sessionId) ?? openStoredConversation(sessionId).conv).compact(instructions, signal),
      // Steering reaches only the conversation that owns the running turn; there is nothing to steer otherwise.
      steerTurn: (sessionId, content, expectedTurnId) =>
        activeConversations.get(sessionId)?.steer(content, expectedTurnId) ?? {
          accepted: false,
          reason: 'no_active_turn',
        },
      enqueueNextTurn: (sessionId, content) => conversations.enqueueNextTurn(sessionId, content),
      listNextTurn: sessionId => conversations.listNextTurn(sessionId),
      queuedInput: sessionId =>
        activeConversations.get(sessionId)?.queuedInput() ??
        (conversations.recover(sessionId).pendingInput ?? []).map(p => ({
          steerId: p.steerId,
          content: p.message.content,
        })),

      // Appearance
      loadCustomThemes: () => customThemes.loadAll(),
      saveCustomTheme: manifest => customThemes.save(manifest),
      removeCustomTheme: id => customThemes.remove(id),
    });
    return client;
  };

  return {
    db,
    settings,
    conversations,
    customThemes,
    redactor,
    vault,
    registry,
    integrations,
    accounts,
    router,
    transport,
    catalog,
    resolveAccount,
    conversation,
    resumeConversation,
    createFutrynClient,
    validateAccount,
    discoverModels,
    hostConfig,
    addHostProvider,
    removeProvider,
    hostConfigDiagnostics: () => hostLoaded.diagnostics,
    /** Resolves when credentials of migrated-away accounts are deleted. */
    migrationCleanup,
    takeStartupNotices: () => outbox.takeNotices(),
    shutdownCommands: async () => {
      // Background subagents never outlive the session: abort and await them before tearing down runtimes.
      await Promise.allSettled([...subagentShutdowns].map(shutdown => shutdown()));
      subagentShutdowns.clear();
      await Promise.allSettled([...languageServerManagers].map(manager => manager.shutdown()));
      languageServerManagers.clear();
      await webSearch.close();
      await commandRuntimes.shutdown();
    },
  };
}

export type Application = ReturnType<typeof startup>;
