import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  HannesError,
  type Account,
  type ProjectContextPort,
  type ProjectContextOptions,
  type ProjectContextReport,
  type CredentialVault,
  type DiffLine,
  type Message,
  type ToolPort,
  type ToolResult,
  type WorkspaceDiffFile,
  type WorkspaceDiffReport,
  type TurnBudget,
} from '@hannes/contracts';
import { Conversation } from '@hannes/core';
import { ToolDispatcher, platformCommandRuntime, type CommandRuntime } from '@hannes/tools';
import { WorkspaceRoot, ProjectContextLoader } from '@hannes/workspace';
import {
  AccountManager,
  IntegrationRegistry,
  ModelCatalog,
  ModelRouter,
  ProviderAdapter,
  SubscriptionAdapter,
  ProviderRegistry,
  ProviderTransport,
  providerPresets,
  parseOpenRouterKeyLimits,
} from '@hannes/models';
import {
  FileCustomThemeStore,
  RuntimeLeases,
  SqliteConversations,
  SqliteSettings,
  ToolAuditStore,
  openPrivateDatabase,
} from '@hannes/persistence';
import { SubscriptionHost, type RuntimeApprover, type SubscriptionHostOptions } from '../subscriptions/host';
import { FutrynClient } from '@hannes/sdk';
import { ConfiguredNetworkPolicy, OpenRouterPKCE, Redactor, SecureVault, SessionGrants, redactModel, terminalText, validateEndpoint } from '@hannes/security';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.hannes', 'dist', '.DS_Store', '.codegraph']);

export function scanWorkspaceFiles(workspaceRoot: string, query?: string, limit = 250): string[] {
  const root = resolve(workspaceRoot);
  const results: string[] = [];
  const q = query?.trim().toLowerCase() ?? '';

  const walk = (dir: string, depth: number) => {
    if (depth > 5 || results.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (!q || relPath.toLowerCase().includes(q)) {
          results.push(relPath);
        }
      }
    }
  };

  walk(root, 0);
  return results.sort();
}

export function computeWorkspaceGitDiff(workspaceRoot: string): WorkspaceDiffReport {
  const root = resolve(workspaceRoot);
  try {
    const proc = Bun.spawnSync(['git', 'diff', '--no-color', '--unified=3'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      return {
        workspace: root,
        gitAvailable: false,
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };
    }

    // File names and contents are untrusted: strip terminal control bytes before they reach any UI.
    const raw = terminalText(Buffer.from(proc.stdout).toString('utf8'));
    if (!raw.trim()) {
      return {
        workspace: root,
        gitAvailable: true,
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };
    }

    const files: WorkspaceDiffFile[] = [];
    let currentFile: WorkspaceDiffFile | null = null;
    let oldLine = 1;
    let newLine = 1;
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of raw.split('\n')) {
      if (line.startsWith('diff --git ')) {
        if (currentFile) files.push(currentFile);
        const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        const path = match?.[2] ?? line.slice('diff --git '.length);
        currentFile = {
          path,
          status: 'modified',
          additions: 0,
          deletions: 0,
          lines: [],
        };
        continue;
      }
      if (!currentFile) continue;
      if (line.startsWith('new file mode')) {
        currentFile.status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        currentFile.status = 'deleted';
        continue;
      }
      if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
        currentFile.status = 'renamed';
        continue;
      }
      if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        continue;
      }
      if (line.startsWith('@@')) {
        const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        oldLine = hunkMatch ? Number(hunkMatch[1]) : 1;
        newLine = hunkMatch ? Number(hunkMatch[2]) : 1;
        currentFile.lines.push({
          type: 'hunk',
          oldLine: null,
          newLine: null,
          content: line,
        });
        continue;
      }
      if (currentFile.lines.length >= 2000) continue;

      if (line.startsWith('+')) {
        currentFile.additions++;
        totalAdditions++;
        currentFile.lines.push({
          type: 'add',
          oldLine: null,
          newLine: newLine++,
          content: line.slice(1),
        });
      } else if (line.startsWith('-')) {
        currentFile.deletions++;
        totalDeletions++;
        currentFile.lines.push({
          type: 'del',
          oldLine: oldLine++,
          newLine: null,
          content: line.slice(1),
        });
      } else if (line.startsWith(' ')) {
        const dl: DiffLine = {
          type: 'context',
          oldLine: oldLine++,
          newLine: newLine++,
          content: line.slice(1),
        };
        currentFile.lines.push(dl);
      }
    }

    if (currentFile) files.push(currentFile);
    return {
      workspace: root,
      gitAvailable: true,
      files,
      totalAdditions,
      totalDeletions,
    };
  } catch {
    return {
      workspace: root,
      gitAvailable: false,
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
  }
}

/** Committed history as conversation messages, keeping tool calls and tool results. */
function committedMessages(record: import('@hannes/contracts').SessionRecord): Message[] {
  if(record.recovery)return record.recovery.messages;
  return record.messages.filter(m => m.state === 'committed').map(({ revision: _revision, state: _state, ...message }) => message);
}

/** Why a read needs approval, in words the permission dialog can show. */
/** `$ cmd` (plus `in dir` when not the root) for a session command grant. */
function commandGrantLabel(target: string, workspace: WorkspaceRoot): string {
  try { const { exec, cwd } = JSON.parse(target) as { exec: string; cwd: string }; const dir = workspace.relativeOf(cwd); return `$ ${exec}${dir === '.' ? '' : ` (in ${dir})`}`; } catch { return '$ (command)'; }
}

const APPROVAL_REASONS: Record<string, string> = {
  'secret-file': 'This file usually holds secrets (keys, passwords, tokens).',
  'process-execute': 'Runs a shell command in a read-only sandbox: no writes, no network, project files only.',
};

export function startup(directory = process.env.HANNES_HOME ?? join(homedir(), '.hannes'), services: { vault?: CredentialVault; fetch?: typeof fetch; subscriptions?: SubscriptionHostOptions; commands?: (workspaceRoot: string, stateDirectory: string) => CommandRuntime } = {}) {
  const commandRuntimes = new Set<CommandRuntime>();
  let commandsClosed = false;
  let commandShutdown: Promise<void> | undefined;
  const shutdownCommands = () => {
    if (commandShutdown) return commandShutdown;
    commandsClosed = true;
    const owned = [...commandRuntimes];
    return commandShutdown = (async () => {
      try {
        const results = await Promise.allSettled(owned.map(runtime => Promise.resolve().then(() => runtime.shutdown?.())));
        if (results.some(result => result.status === 'rejected')) throw new HannesError('TRANSPORT');
      } finally { for (const runtime of owned) commandRuntimes.delete(runtime); }
    })();
  };
  process.umask(0o077);
  const db = openPrivateDatabase(directory);
  const settings = new SqliteSettings(db);
  const redactor = new Redactor();
  const conversations = new SqliteConversations(db,value=>redactor.text(value));
  const toolAudit = new ToolAuditStore(db);
  const customThemes = new FileCustomThemeStore(directory);
  const vault = services.vault ?? new SecureVault(redactor);
  const oauth = new OpenRouterPKCE(redactor, services.fetch);
  const registry = new ProviderRegistry(settings);
  const integrations = new IntegrationRegistry(registry);
  const accounts = new AccountManager(settings, vault);
  const router = new ModelRouter(settings);
  const policy = new ConfiguredNetworkPolicy();
  const subscriptions = new SubscriptionHost(directory, vault, settings, new RuntimeLeases(db), services.subscriptions);

  const transport = (account: Account) =>
    new ProviderTransport(registry.get(account.providerId), account, vault, {
      authorize(provider, a) {
        // Re-read durable grants before every network operation, so logout in another process fences new requests.
        const fresh = accounts.get(a.id);
        if (
          (fresh.authGeneration ?? 1) !== (a.authGeneration ?? 1) ||
          JSON.stringify(fresh.credential) !== JSON.stringify(a.credential) ||
          JSON.stringify(registry.get(provider.id)) !== JSON.stringify(provider)
        ) {
          throw new HannesError('POLICY');
        }
        policy.authorize(provider, fresh);
      },
    }, services.fetch);

  const catalog = (account: Account) => new ModelCatalog(settings, transport(account));

  const resolveAccount = (id?: string) => {
    const selected = id ?? settings.read().activeAccountId;
    if (!selected) throw new HannesError('AUTH');
    return accounts.get(selected);
  };

  const createConversationForSelection = (selection: { accountId: string; modelId: string }, existingSession?: { id: string; messages: Message[] }, tools?: ToolPort, workspaceRoot?: string, projectContext?: ProjectContextPort, approve?: RuntimeApprover, delegated: () => boolean = () => false, budget: () => TurnBudget | undefined = () => undefined, analysisOnly:()=>boolean=()=>false) => {
    const account = accounts.get(selection.accountId);
    if (account.status === 'logged-out') throw new HannesError('AUTH');
    const info = catalog(account).cached().find(m => m.id === selection.modelId);
    if (!info) throw new HannesError('NOT_FOUND');
    // Only direct APIs and the explicitly authorized Codex dynamic read bridge receive tools (ADR 0018).
    const runtime = !!registry.get(account.providerId).runtime;
    const codexReads = registry.get(account.providerId).runtime === 'codex';
    // Re-read the catalog each turn so a model marked 'unsupported' stops receiving tools at once.
    const modelTools: ToolPort | undefined = tools && (!runtime || codexReads) ? {
      // A delegated runtime uses its own tools; Hannes tools are not offered alongside them (ADR 0029).
      descriptors: () => runtime && delegated() ? [] : catalog(account).cached().find(m => m.id === selection.modelId)?.capabilities.tools === 'unsupported' ? [] : tools.descriptors(),
      invoke: (call, signal) => tools.invoke(call, signal),
    } : undefined;
    return new Conversation(
      selection,
      redactModel(registry.get(account.providerId).runtime
        ? new SubscriptionAdapter(selection.modelId, (request, signal, executeTool) => subscriptions.stream(registry.get(account.providerId), account, request, signal, executeTool, workspaceRoot,
            // Native runtime tools only after folder consent AND an explicit delegation opt-in (ADR 0029).
            workspaceRoot && delegated() && tools?.descriptors().length ? workspaceRoot : undefined, approve), codexReads)
        : new ProviderAdapter(transport(account), selection.modelId, info), redactor),
      conversations,
      existingSession,
      modelTools,
      runtime ? undefined : () => catalog(account).markToolsUnsupported(selection.modelId),
      projectContext,
      // ADR 0030: the user's optional work budget and the model's reported context window.
      { budget, analysisOnly, contextLimit: () => catalog(account).cached().find(m => m.id === selection.modelId)?.contextLimit ?? null, outputLimit:()=>catalog(account).cached().find(m=>m.id===selection.modelId)?.outputLimit??null },
    );
  };

  const conversation = (project?: string) => {
    const selection = router.resolve(project);
    return createConversationForSelection(selection);
  };

  const resumeConversation = (id: string) => {
    const record = conversations.get(id); if (!record) throw new HannesError('NOT_FOUND');
    return createConversationForSelection(record.selection, { id, messages: committedMessages(record) });
  };

  const discoverModels = async (account: Account, signal?: AbortSignal) => {
    const provider = registry.get(account.providerId);
    if (!provider.runtime) return catalog(account).discover(signal);
    const observed = new Map(catalog(account).cached().map(model => [model.id, model]));
    const models = (await subscriptions.models(provider, account, signal)).map(model => {
      const previous = observed.get(model.id);
      if (model.contextLimit == null && previous?.metadataSource?.endsWith(':observed-context') && previous.contextLimit) {
        return { ...model, contextLimit: previous.contextLimit, metadataSource: previous.metadataSource, metadataFetchedAt: previous.metadataFetchedAt };
      }
      return model;
    });
    settings.update(state => {
      const fresh = state.accounts.find(a => a.id === account.id);
      if (!fresh || fresh.status === 'logged-out' || fresh.authGeneration !== account.authGeneration) throw new HannesError('POLICY');
      state.catalogs = state.catalogs.filter(c => c.accountId !== account.id);
      state.catalogs.push({ accountId: account.id, providerFingerprint: JSON.stringify(provider), fetchedAt: new Date().toISOString(), models });
    });
    return { models, stale: false };
  };

  const validateAccount = async (account: Account, signal?: AbortSignal, generate = false) => {
    const p = registry.get(account.providerId);
    try {
      // OpenRouter's /models is public and cannot prove that an API key is valid.
      const currentKey = p.id === 'openrouter' && p.baseURL === 'https://openrouter.ai/api/v1';
      if (currentKey) {
        const info = await transport(account).json('key', signal);
        if (!info || typeof info !== 'object' || !('data' in info) || !info.data || typeof info.data !== 'object') throw new HannesError('PROTOCOL');
      }
      // An explicit generation probe validates the pinned model without replacing
      // richer cached metadata with a less complete model-list response.
      const cached = generate ? catalog(account).cached() : [];
      const res = cached.length ? { models: cached, stale: false } : await discoverModels(account, signal);
      if (res.stale) throw new HannesError('TRANSPORT');
      const modelId = account.defaultModel ?? res.models[0]?.id;
      if ((generate || (p.catalog === 'manual' && !p.runtime)) && !modelId) throw new HannesError('NOT_FOUND');
      if ((generate || (p.catalog === 'manual' && !p.runtime)) && modelId) {
        await (p.runtime ? new SubscriptionAdapter(modelId, (request, turnSignal) => subscriptions.stream(p, account, request, turnSignal)) : new ProviderAdapter(transport(account), modelId)).generate({ requestId: crypto.randomUUID(), modelId,
          messages: [{ role: 'user', content: 'Reply with OK.' }], maxOutputTokens: 16, tools: [] }, signal);
      }
      if (signal?.aborted) throw new HannesError('CANCELLED');
      accounts.validation(account.id, true, account);
      return { accountId: account.id, providerId: p.id, connection: 'validated', models: res.models.length,
        validation: generate || (p.catalog === 'manual' && !p.runtime) ? 'generation' : currentKey ? 'authenticated-key-and-model-discovery' : p.runtime ? 'subscription-runtime-model-discovery' : 'model-discovery',
        checkedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HannesError && ['AUTH', 'FORBIDDEN'].includes(error.code)) accounts.validation(account.id, false, account);
      throw error;
    }
  };

  const createFutrynClient = (workspaceRoot = resolve('.'), contextOptions: ProjectContextOptions = {}): FutrynClient => {
    const envBudget = process.env.HANNES_PROJECT_CONTEXT_MAX_BYTES;
    if (contextOptions.maxBytes === undefined && envBudget !== undefined && !/^\d+$/.test(envBudget)) throw new HannesError('INVALID_INPUT');
    const options = {...contextOptions,maxBytes:contextOptions.maxBytes ?? (envBudget === undefined ? 32768 : Number(envBudget))};
    if (![options.maxBytes,options.maxFileBytes ?? 16384].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 65536)) throw new HannesError('INVALID_INPUT');
    let projectReport: ProjectContextReport | null = null;
    let contextLoader: ProjectContextLoader | undefined;
    let commandRuntime: CommandRuntime | undefined;
    const commands = () => {
      if (commandsClosed) throw new HannesError('CANCELLED');
      if (!commandRuntime) {
        commandRuntime = (services.commands ?? ((root, state) => platformCommandRuntime({workspaceRoot:root,stateDirectory:state,extraExecutables:['rg']})))(workspaceTree().root,realpathSync.native(resolve(directory)));
        commandRuntimes.add(commandRuntime);
      }
      return commandRuntime;
    };
    const activeConvMap = new Map<string, Conversation>();
    // Read-only workspace tools (ADR 0017). Offered only while the client allows them, i.e. after
    // the TUI obtained folder consent; approvals go through the client's permission dialog.
    let client: FutrynClient | undefined;
    let dispatcher: ToolDispatcher | undefined;
    let workspace: WorkspaceRoot | undefined;
    const grants = new SessionGrants();
    const workspaceTree = () => workspace ??= new WorkspaceRoot(workspaceRoot);
    const tools = () => dispatcher ??= new ToolDispatcher({
      workspace: workspaceTree(),
      grants,
      stateDirectory: realpathSync.native(resolve(directory)),
      // Sandboxed exec_command (ADR 0022): Seatbelt on macOS; other platforms fail closed.
      commands: commands(),
      redact: (text,incomplete) => incomplete ? redactor.stream().push(text) : redactor.text(text),
      audit: record => toolAudit.append(record),
      approve: (request, signal) => client
        ? client.requestPermission(request.capability === 'fs.write'
          ? {capability:'fs.write',action:'Apply verified workspace patch',target:request.target,reason:'Review the exact file changes before applying.',riskLevel:'high',scopeKey:request.scopeKey,diffPreview:request.diffPreview}
          : request.capability === 'process.execute'
          // The action names directory and sandbox, so a "session" answer is bound to all three.
          ? { capability: request.capability, action: `Run in ${(request.workdir ?? '.').slice(0,80)} · ${request.sandbox ?? 'sandbox'}`, target: request.target, reason: APPROVAL_REASONS[request.reason] ?? request.reason, riskLevel: 'high', scopeKey: request.scopeKey }
          : { capability: request.capability, action: `${request.tool} ${request.target}`, target: request.target, reason: APPROVAL_REASONS[request.reason] ?? request.reason, riskLevel: 'medium' }, signal)
        : Promise.resolve('deny'),
    });
    /** Native runtime tools ask through the same prompt and permission mode as Hannes tools (ADR 0027). */
    const RUNTIME_CAPABILITY = { secret: 'fs.read', edit: 'fs.write', execute: 'process.execute', network: 'network.connect', other: 'extension.service' } as const;
    const runtimeApprover: RuntimeApprover = async (request, signal) => {
      if (!client?.toolsEnabled()) return false;
      const decision = await client.requestPermission({ capability: RUNTIME_CAPABILITY[request.kind], kind: request.kind, action: `${request.runtime}: ${request.label}`.slice(0, 200), target: request.label.slice(0, 1024) || request.kind, reason: `The ${request.runtime} runtime wants to ${request.kind === 'secret' ? 'read a sensitive file' : request.kind === 'edit' ? 'change files' : request.kind === 'execute' ? 'run a command' : request.kind === 'network' ? 'use the network' : 'use a tool'} in this project.`, riskLevel: request.kind === 'execute' || request.kind === 'edit' ? 'high' : 'medium', scopeKey: `runtime:${request.runtime}:${request.kind}:${request.fingerprint}`, ruleTarget: request.ruleTarget }, signal);
      return decision !== 'deny';
    };
    const toolPort: ToolPort = {
      descriptors: () => (client?.toolsEnabled() ? tools().descriptors() : []),
      invoke: async (call, signal): Promise<ToolResult> => client?.toolsEnabled()
        ? tools().invoke(call, signal)
        : { callId: call.id, name: call.name, status: 'denied', code: 'TOOLS_DISABLED', content: 'Workspace tools are not enabled for this session.' },
    };

    const projectContext: ProjectContextPort = {load: async signal => {
      if (!client?.toolsEnabled()) return null;
      contextLoader ??= new ProjectContextLoader(workspaceTree(),{read:(path,budget,readSignal) => {
        if (!client?.toolsEnabled()) return Promise.resolve({status:'denied',code:'WORKSPACE_NOT_APPROVED'});
        return tools().readInstruction(path,budget,readSignal);
      }},options);
      const snapshot = await contextLoader.load(signal);
      if (!client.toolsEnabled()) return null;
      const {content: _content,...report} = snapshot; projectReport = report;
      return snapshot;
    }};

    client = new FutrynClient({
      availableTools: () => client?.toolsEnabled() ? tools().descriptors().map(d => d.name) : [],
      getProjectContext: () => client?.toolsEnabled() && projectReport ? structuredClone(projectReport) : null,
      toolGrants: { list: () => grants.list().map(grant => grant.capability === 'process.execute' ? commandGrantLabel(grant.target, workspaceTree()) : grant.capability === 'fs.write' ? 'Exact patch '+grant.target.slice(6,18) : workspaceTree().relativeOf(grant.target)), clear: () => grants.clear() },
      workspace: resolve(workspaceRoot),
      settings,
      listIntegrations: () => integrations.list().map(integration => ({ ...integration,
        methods: integration.methods.map(method => {
          const provider = integrations.get(method.providerId ?? integration.provider.id).provider;
          return provider.runtime ? { ...method, available: subscriptions.available(provider), diagnostic: subscriptions.available(provider) ? undefined : `Install the official ${provider.runtime} runtime on PATH, then retry. No credentials were read or imported.` } : method;
        }),
      })),
      beginProviderAuth: async (providerId, methodId, signal) => {
        const integration = integrations.get(providerId);
        if (integration?.provider.runtime) return subscriptions.begin(integration.provider, methodId === 'subscription-device', signal);
        if (!integration?.methods.some(m => m.id === 'openrouter-oauth')) throw new HannesError('UNSUPPORTED');
        return oauth.begin();
      },
      completeProviderAuth: async (providerId, challengeId, code, signal) => {
        const integration = integrations.get(providerId);
        if (!integration?.methods.some(m => m.id === 'openrouter-oauth')) throw new HannesError('UNSUPPORTED');
        return oauth.complete(challengeId, code, signal);
      },
      providerAuthProgress: id => subscriptions.progress(id),
      completeSubscriptionAuth: (providerId, id, signal) => subscriptions.complete(registry.get(providerId), id, signal),
      discardSubscriptionCredential: ref => vault.delete(ref),
      cancelProviderAuth: id => { oauth.cancel(id); return subscriptions.cancel(id); },
      listProviders: () => registry.list(),
      listProviderPresets: () => [...providerPresets],
      addProvider: p => registry.add({ ...p, baseURL: validateEndpoint(p.baseURL) }),
      removeProvider: id => registry.remove(id),
      listAccounts: () => settings.read().accounts,
      getAccount: idOrAlias => accounts.get(idOrAlias),
      addAccount: (providerId, alias, credential, secret) =>
        accounts.add(providerId, alias, credential, secret),
      reauthenticateAccount: (id, credential, secret) =>
        accounts.reauthenticate(id, credential, secret),
      useAccount: idOrAlias => accounts.use(idOrAlias),
      renameAccount: (idOrAlias, newAlias) => {
        const target = accounts.get(idOrAlias);
        accounts.rename(target.id, newAlias);
        return accounts.get(target.id);
      },
      logoutAccount: async (idOrAlias, remove) => {
        const target = accounts.get(idOrAlias);
        try { await accounts.logout(target.id, remove); } finally { await subscriptions.revoke(target); }
      },
      validateAccount,
      fetchAccountLimits: (account, signal) => {
        const provider = registry.get(account.providerId);
        // Only OpenRouter's official endpoint has a documented key-credit API; others report nothing.
        if (provider.id !== 'openrouter' || provider.baseURL !== 'https://openrouter.ai/api/v1') return null;
        return transport(account).json('key', signal).then(body => {
          const { items, freeTier } = parseOpenRouterKeyLimits(body);
          return { items, note: freeTier ? 'Free-tier key' : undefined };
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
      listSessions: () => conversations.list(),
      getSession: id => conversations.get(id),
      deleteSession: id => {
        activeConvMap.delete(id);
        return conversations.delete(id);
      },
      forkSession: (id, selection) => {
        // Validate the target account/model before creating any durable copy.
        createConversationForSelection(selection, { id, messages: [] });
        const record = conversations.fork(id, selection);
        const messages = committedMessages(record);
        const conv = createConversationForSelection(selection, { id: record.id, messages }, toolPort, resolve(workspaceRoot), projectContext, runtimeApprover, () => client?.delegatedAgent() ?? false, () => client?.turnBudget(),()=>['plan','review'].includes(client?.mode()??'chat'));
        activeConvMap.set(conv.id, conv);
        return { id: conv.id, selection, messages };
      },
      startSession: project => {
        const conv = createConversationForSelection(router.resolve(project), undefined, toolPort, resolve(workspaceRoot), projectContext, runtimeApprover, () => client?.delegatedAgent() ?? false, () => client?.turnBudget(),()=>['plan','review'].includes(client?.mode()??'chat'));
        const selection = router.resolve(project);
        activeConvMap.set(conv.id, conv);
        return { id: conv.id, selection, messages: [] };
      },
      resumeSession: id => {
        const record = conversations.get(id);
        if (!record) throw new HannesError('NOT_FOUND');
        const committed = committedMessages(record);
        const conv = createConversationForSelection(record.selection, {
          id: record.id,
          messages: committed,
        }, toolPort, resolve(workspaceRoot), projectContext, runtimeApprover, () => client?.delegatedAgent() ?? false, () => client?.turnBudget(),()=>['plan','review'].includes(client?.mode()??'chat'));
        activeConvMap.set(conv.id, conv);
        return {
          id: conv.id,
          selection: record.selection,
          messages: committed,
        };
      },
      sendTurn: async function* (sessionId, content, signal, maxOutputTokens = 4096, maxEstimatedCostUSD, reasoningEffort) {
        let conv = activeConvMap.get(sessionId);
        if (!conv) {
          const record = conversations.get(sessionId);
          if (!record) throw new HannesError('NOT_FOUND');
          const committed = committedMessages(record);
          conv = createConversationForSelection(record.selection, {
            id: record.id,
            messages: committed,
          }, toolPort, resolve(workspaceRoot), projectContext, runtimeApprover, () => client?.delegatedAgent() ?? false, () => client?.turnBudget(),()=>['plan','review'].includes(client?.mode()??'chat'));
          activeConvMap.set(conv.id, conv);
        }
        yield* conv.send(content, signal, maxOutputTokens, maxEstimatedCostUSD, reasoningEffort);
      },
      loadCustomThemes: () => customThemes.loadAll(),
      saveCustomTheme: manifest => customThemes.save(manifest),
      removeCustomTheme: id => customThemes.remove(id),
      listWorkspaceFiles: query => scanWorkspaceFiles(workspaceRoot, query),
      getWorkspaceDiff: () => computeWorkspaceGitDiff(workspaceRoot),
      sanitizeText: text => terminalText(redactor.text(text)),
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
    subscriptions,
    shutdownCommands,
  };
}

export type Application = ReturnType<typeof startup>;
