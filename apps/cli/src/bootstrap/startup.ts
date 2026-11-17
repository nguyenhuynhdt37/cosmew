import {runUserShellCommand} from './user-shell';
import {realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {
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
  type ProjectContextReport,
  type Selection,
  type SessionRecord,
  type ToolPort,
  type ToolResult,
  type TurnBudget,
  analysisCapability,
  type PlanState,
} from '@futryn/contracts';
import {Conversation} from '@futryn/core';
import {ToolDispatcher, type CommandRuntime} from '@futryn/tools';
import {ProjectContextLoader, WorkspaceDenied, WorkspaceRoot, nestedLabel} from '@futryn/workspace';
import {
  AccountManager,
  IntegrationRegistry,
  ModelCatalog,
  ModelRouter,
  ProviderAdapter,
  ProviderRegistry,
  ProviderTransport,
  SubscriptionAdapter,
  parseOpenRouterKeyLimits,
  providerPresets,
} from '@futryn/models';
import {
  FileCustomThemeStore,
  RuntimeLeases,
  SqliteConversations,
  SqliteSettings,
  ToolAuditStore,
  openPrivateDatabase,
} from '@futryn/persistence';
import {FutrynClient, type TerminalRuntimeReport} from '@futryn/sdk';
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
import {SubscriptionHost, type RuntimeApprover, type SubscriptionHostOptions} from '../subscriptions/host';
import {grantLabel, runtimeApprover, toolPermissionRequest} from './approvals';
import {CommandRuntimes, createCommandRuntime, permissionModeFromEnv, sandboxSettingsFromEnv} from './commands';
import {defaultStateDirectory} from './paths';
import {refreshWorkspaceGitDiff, scanWorkspaceFiles} from './workspace-info';

export {computeWorkspaceGitDiff, scanWorkspaceFiles} from './workspace-info';
export {approvalPolicyFromEnv, permissionModeFromEnv, sandboxSettingsFromEnv} from './commands';

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
  approve?: RuntimeApprover;
  /** The user opted this session into the runtime's own loop and tools (ADR 0029). */
  delegated?: () => boolean;
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
    subscriptions?: SubscriptionHostOptions;
    commands?: (workspaceRoot: string, stateDirectory: string) => CommandRuntime;
  } = {},
) {
  const commandRuntimes = new CommandRuntimes();
  process.umask(0o077);
  const db = openPrivateDatabase(directory);
  const settings = new SqliteSettings(db);
  const redactor = new Redactor();
  const conversations = new SqliteConversations(db, value => redactor.text(value));
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

  /**
   * Tools the model may see. Only direct APIs and the authorized Codex dynamic read bridge receive
   * Futryn tools (ADR 0018); a delegated runtime uses its own tools instead (ADR 0029).
   */
  const modelTools = (account: Account, modelId: string, wiring: ConversationWiring): ToolPort | undefined => {
    const {tools, delegated = () => false} = wiring;
    const runtime = registry.get(account.providerId).runtime;
    if (!tools || (runtime && runtime !== 'codex')) return undefined;
    return {
      descriptors: () => {
        if (runtime && delegated()) return [];
        if (cachedModel(account, modelId)?.capabilities.tools === 'unsupported') return [];
        return tools.descriptors();
      },
      invoke: (call, signal, onOutput) => tools.invoke(call, signal, onOutput),
    };
  };

  /** The model port: a direct provider adapter, or a subscription runtime (Codex, Copilot, …). */
  const modelPort = (account: Account, selection: Selection, info: ModelInfo, wiring: ConversationWiring) => {
    const provider = registry.get(account.providerId);
    if (!provider.runtime) return new ProviderAdapter(transport(account), selection.modelId, info);
    const {tools, workspaceRoot, approve, delegated = () => false} = wiring;
    return new SubscriptionAdapter(
      selection.modelId,
      (request, signal, executeTool) =>
        subscriptions.stream(
          registry.get(account.providerId),
          account,
          request,
          signal,
          executeTool,
          workspaceRoot,
          // Native runtime tools only after folder consent AND an explicit delegation opt-in (ADR 0029).
          workspaceRoot && delegated() && tools?.descriptors().length ? workspaceRoot : undefined,
          approve,
        ),
      provider.runtime === 'codex',
    );
  };

  const createConversationForSelection = (
    selection: Selection,
    existingSession?: {id: string; messages: Message[]},
    wiring: ConversationWiring = {},
  ) => {
    const account = accounts.get(selection.accountId);
    if (account.status === 'logged-out') throw new FutrynError('AUTH');
    const info = cachedModel(account, selection.modelId);
    if (!info) throw new FutrynError('NOT_FOUND');
    const isRuntime = !!registry.get(account.providerId).runtime;

    const baseModel: ModelPort = modelPort(account, selection, info, wiring);
    const prepare = (request: ModelRequest): ModelRequest => ({
      ...request,
      ...([request.instructions, wiring.modeInstructions?.()].filter(Boolean).length
        ? {instructions: [request.instructions, wiring.modeInstructions?.()].filter(Boolean).join('\n\n')}
        : {}),
    });
    const guidedModel: ModelPort = {
      inlineTools: baseModel.inlineTools,
      stream: (request, signal, executeTool) => baseModel.stream(prepare(request), signal, executeTool),
      generate: (request, signal) => baseModel.generate(prepare(request), signal),
    };
    return new Conversation(
      selection,
      redactModel(guidedModel, redactor),
      conversations,
      existingSession,
      modelTools(account, selection.modelId, wiring),
      isRuntime ? undefined : () => catalog(account).markToolsUnsupported(selection.modelId),
      wiring.projectContext,
      // ADR 0030: the user's optional work budget and the model's reported context window.
      {
        budget: wiring.budget ?? (() => undefined),
        analysisOnly: wiring.analysisOnly ?? (() => false),
        contextLimit: () => cachedModel(account, selection.modelId)?.contextLimit ?? null,
        outputLimit: () => cachedModel(account, selection.modelId)?.outputLimit ?? null,
      },
    );
  };

  const conversation = (project?: string) => createConversationForSelection(router.resolve(project));

  const resumeConversation = (id: string) => {
    const record = conversations.get(id);
    if (!record) throw new FutrynError('NOT_FOUND');
    return createConversationForSelection(record.selection, {id, messages: committedMessages(record)});
  };

  const discoverModels = async (account: Account, signal?: AbortSignal) => {
    const provider = registry.get(account.providerId);
    if (!provider.runtime) return catalog(account).discover(signal);

    // Runtimes may not report a context window; keep one observed earlier for the same model.
    const observed = new Map(
      catalog(account)
        .cached()
        .map(model => [model.id, model]),
    );
    const models = (await subscriptions.models(provider, account, signal)).map(model => {
      const previous = observed.get(model.id);
      const keepObserved =
        model.contextLimit == null && previous?.metadataSource?.endsWith(':observed-context') && previous.contextLimit;
      if (!keepObserved || !previous) return model;
      return {
        ...model,
        contextLimit: previous.contextLimit,
        metadataSource: previous.metadataSource,
        metadataFetchedAt: previous.metadataFetchedAt,
      };
    });
    settings.update(state => {
      const fresh = state.accounts.find(a => a.id === account.id);
      if (!fresh || fresh.status === 'logged-out' || fresh.authGeneration !== account.authGeneration) {
        throw new FutrynError('POLICY');
      }
      state.catalogs = state.catalogs.filter(c => c.accountId !== account.id);
      state.catalogs.push({
        accountId: account.id,
        providerFingerprint: JSON.stringify(provider),
        fetchedAt: new Date().toISOString(),
        models,
      });
    });
    return {models, stale: false};
  };

  const validateAccount = async (account: Account, signal?: AbortSignal, generate = false) => {
    const provider = registry.get(account.providerId);
    // OpenRouter's /models is public and cannot prove that an API key is valid; its /key endpoint can.
    const checksKey = provider.id === 'openrouter' && provider.baseURL === OPENROUTER_API;
    // Manual catalogs (no model list) can only be validated by generating.
    const generates = generate || (provider.catalog === 'manual' && !provider.runtime);
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
      if (generates && modelId) await generateProbe(account, provider, modelId, signal);
      if (signal?.aborted) throw new FutrynError('CANCELLED');

      accounts.validation(account.id, true, account);
      let validation = 'model-discovery';
      if (generates) validation = 'generation';
      else if (checksKey) validation = 'authenticated-key-and-model-discovery';
      else if (provider.runtime) validation = 'subscription-runtime-model-discovery';
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
  const generateProbe = async (
    account: Account,
    provider: ReturnType<typeof registry.get>,
    modelId: string,
    signal?: AbortSignal,
  ) => {
    const adapter = provider.runtime
      ? new SubscriptionAdapter(modelId, (request, turnSignal) =>
          subscriptions.stream(provider, account, request, turnSignal),
        )
      : new ProviderAdapter(transport(account), modelId);
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
    const sandboxSettings = sandboxSettingsFromEnv();
    const grants = new SessionGrants();
    const activeConversations = new Map<string, Conversation>();
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

    // Everything below is created lazily, on first use after folder consent.
    const workspaceTree = () => (workspace ??= new WorkspaceRoot(workspaceRoot));

    const commands = () => {
      if (commandRuntimes.closed) throw new FutrynError('CANCELLED');
      if (!commandRuntime) {
        commandRuntime = (services.commands ?? createCommandRuntime)(workspaceTree().root, stateDirectory);
        commandRuntimes.add(commandRuntime);
      }
      return commandRuntime;
    };

    // Workspace tools (ADR 0017+): offered only while the client allows them, i.e. after the TUI
    // obtained folder consent; approvals go through the client's permission dialog.
    const tools = () =>
      (dispatcher ??= new ToolDispatcher({
        workspace: workspaceTree(),
        grants,
        stateDirectory,
        commands: commands(),
        sandbox: () => sandboxSettings,
        turnId: () => client?.currentTurnId(),
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
        return room > 200 ? {...result, content: result.content + note.slice(0, room)} : result;
      } catch (error) {
        if (signal?.aborted) throw error;
        return result;
      }
    };

    const toolPort: ToolPort = {
      descriptors: () => (toolsEnabled() ? tools().descriptors() : []),
      invoke: async (call, signal, onOutput): Promise<ToolResult> => {
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
          const result = await tools().invoke(call, signal, onOutput);
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

    /** Every session of this client is wired the same way. */
    const wiring: ConversationWiring = {
      tools: toolPort,
      workspaceRoot: resolve(workspaceRoot),
      projectContext,
      approve: runtimeApprover(() => client),
      delegated: () => client?.delegatedAgent() ?? false,
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
      permissionMode: permissionModeFromEnv(),
      getPlan: id => {
        if (!plans.has(id)) plans.set(id, conversations.loadPlan(id));
        return plans.get(id) ?? null;
      },
      toolGrants: {
        list: () => grants.list().map(grant => grantLabel(grant, workspaceTree())),
        clear: () => grants.clear(),
      },
      workspace: resolve(workspaceRoot),
      terminalRuntime: () => {
        if (terminalReport) return terminalReport;
        const runtime = commands();
        const availability = runtime.availability();
        return (terminalReport = {
          label: runtime.label,
          available: availability.ok,
          ...(!availability.ok ? {reason: availability.reason} : {}),
          sandbox: availability.ok ? sandboxSettings.mode : 'unavailable',
          escalation: sandboxSettings.escalation,
          limitations: runtime.id.startsWith('native-macos')
            ? [
                'Detached setsid descendants may survive; termination can be unconfirmed.',
                'Secret files are readable unless FUTRYN_SANDBOX_HIDE_SECRETS=1.',
              ]
            : runtime.id.startsWith('native-linux')
              ? ['Linux bubblewrap has not received live platform acceptance.']
              : [],
        });
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
      listIntegrations: () =>
        integrations.list().map(integration => ({
          ...integration,
          methods: integration.methods.map(method => {
            const provider = integrations.get(method.providerId ?? integration.provider.id).provider;
            if (!provider.runtime) return method;
            const available = subscriptions.available(provider);
            return {
              ...method,
              available,
              diagnostic: available
                ? undefined
                : `Install the official ${provider.runtime} runtime on PATH, then retry. No credentials were read or imported.`,
            };
          }),
        })),
      beginProviderAuth: async (providerId, methodId, signal) => {
        const integration = integrations.get(providerId);
        if (integration?.provider.runtime) {
          return subscriptions.begin(integration.provider, methodId === 'subscription-device', signal);
        }
        if (!integration?.methods.some(m => m.id === 'openrouter-oauth')) throw new FutrynError('UNSUPPORTED');
        return oauth.begin();
      },
      completeProviderAuth: async (providerId, challengeId, code, signal) => {
        const integration = integrations.get(providerId);
        if (!integration?.methods.some(m => m.id === 'openrouter-oauth')) throw new FutrynError('UNSUPPORTED');
        return oauth.complete(challengeId, code, signal);
      },
      providerAuthProgress: id => subscriptions.progress(id),
      completeSubscriptionAuth: (providerId, id, signal) =>
        subscriptions.complete(registry.get(providerId), id, signal),
      discardSubscriptionCredential: ref => vault.delete(ref),
      cancelProviderAuth: id => {
        oauth.cancel(id);
        return subscriptions.cancel(id);
      },
      listProviders: () => registry.list(),
      listProviderPresets: () => [...providerPresets],
      addProvider: p => registry.add({...p, baseURL: validateEndpoint(p.baseURL)}),
      removeProvider: id => registry.remove(id),

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
        const target = accounts.get(idOrAlias);
        try {
          await accounts.logout(target.id, remove);
        } finally {
          await subscriptions.revoke(target);
        }
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
        yield* conv.send(content, signal, maxOutputTokens, maxEstimatedCostUSD, reasoningEffort, queuedInputId);
      },
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
    subscriptions,
    shutdownCommands: () => commandRuntimes.shutdown(),
  };
}

export type Application = ReturnType<typeof startup>;
