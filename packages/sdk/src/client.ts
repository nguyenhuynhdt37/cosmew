import { summarizeUsage } from './telemetry';
import { quotaItems, type AccountLimits, type FetchAccountLimits } from './limits';
import { createHash } from 'node:crypto';
import {
  HannesError,
  appearanceSchema,
  defaultAppearance,
  partialAppearanceSchema,
  permissionPromptResolutionSchema,
  permissionPromptRequestSchema,
  type Account,
  type ProjectContextReport,
  type Integration,
  type ProviderAuthChallenge,
  type ProviderAuthProgress,
  type AppearanceConfig,
  type CredentialRef,
  type Message,
  type ModelEvent,
  type ModelInfo,
  type PartialAppearanceConfig,
  type PermissionPromptRequest,
  type PermissionPromptResolution,
  type PermissionResolutionScope,
  type Provider,
  type Selection,
  type SessionRecord,
  type SessionSummary,
  type SettingsStore,
  type ThemeManifest,
  type Usage,
  type WorkspaceDiffReport,
} from '@hannes/contracts';

export type AgentMode = 'chat' | 'plan' | 'review';

export type ReactiveAgentEventKind = 'idle' | 'thinking' | 'waiting' | 'reasoning' | 'streaming' | 'tool' | 'permission' | 'error' | 'done';

export interface ReactiveAgentEvent {
  seq: number;
  kind: ReactiveAgentEventKind;
  detail?: string;
  timestamp: number;
}

export interface BackendCapabilitiesReport {
  providerAuth: 'implemented';
  streamingChat: 'implemented';
  sessionPersistence: 'implemented';
  themesAndWallpapers: 'implemented';
  workspaceDiff: 'implemented';
  permissionDialog: 'implemented';
  generalToolsExecution: 'not-implemented';
  mcpIntegration: 'not-implemented';
  pluginHost: 'not-implemented';
  delegatedSubagents: 'not-implemented';
}

export interface ConnectAccountInput {
  providerId: string;
  alias: string;
  credential: CredentialRef;
  secret?: string;
  manualModelId?: string;
  reauthenticateAccountId?: string;
  validate?: boolean;
  authChallengeId?: string;
  authorizationCode?: string;
}

export interface FutrynBackendPorts {
  workspace: string;
  getProjectContext?(): ProjectContextReport | null;
  settings: SettingsStore;
  listIntegrations?(): Integration[];
  beginProviderAuth?(providerId: string, methodId?: string, signal?: AbortSignal): Promise<ProviderAuthChallenge>;
  completeProviderAuth?(providerId: string, challengeId: string, code: string, signal?: AbortSignal): Promise<string>;
  cancelProviderAuth?(challengeId: string): void | Promise<void>;
  providerAuthProgress?(challengeId: string): ProviderAuthProgress;
  completeSubscriptionAuth?(providerId: string, challengeId: string, signal?: AbortSignal): Promise<CredentialRef>;
  discardSubscriptionCredential?(ref: CredentialRef): Promise<void>;
  listProviders(): Provider[];
  listProviderPresets(): Provider[];
  addProvider(provider: Provider): Provider;
  removeProvider(id: string): void;
  listAccounts(): Account[];
  getAccount(idOrAlias: string): Account;
  addAccount(providerId: string, alias: string, credential: CredentialRef, secret?: string): Promise<Account>;
  reauthenticateAccount(id: string, credential: CredentialRef, secret?: string): Promise<Account>;
  useAccount(idOrAlias: string): Account;
  renameAccount(idOrAlias: string, newAlias: string): Account;
  logoutAccount(idOrAlias: string, remove?: boolean): Promise<void>;
  validateAccount(account: Account, signal?: AbortSignal, generate?: boolean): Promise<{ models: number; validation: string }>;
  /** Optional: session-scoped tool grants ('Allow for session'), as workspace-relative targets. */
  toolGrants?: { list(): string[]; clear(): void };
  /** Optional: live balance/quota from providers that expose one (e.g. OpenRouter key credit). */
  fetchAccountLimits?: FetchAccountLimits;
  discoverModels(account: Account, signal?: AbortSignal): Promise<{ models: ModelInfo[]; stale: boolean; warning?: string }>;
  cachedModels(account: Account): ModelInfo[];
  addManualModel(account: Account, modelId: string): ModelInfo;
  selectModel(account: Account, model: ModelInfo, project?: string): Selection;
  resolveSelection(project?: string): Selection | null;
  listSessions(): SessionSummary[];
  getSession(id: string): SessionRecord | undefined;
  deleteSession(id: string): boolean;
  forkSession?(id: string, selection: Selection): { id: string; selection: Selection; messages: Message[] };
  startSession(project?: string): { id: string; selection: Selection; messages: Message[] };
  resumeSession(id: string): { id: string; selection: Selection; messages: Message[] };
  sendTurn(
    sessionId: string,
    content: string,
    signal?: AbortSignal,
    maxOutputTokens?: number,
    maxEstimatedCostUSD?: number,
    reasoningEffort?: string,
  ): AsyncIterable<ModelEvent>;
  loadCustomThemes(): { themes: ThemeManifest[]; errors: { file: string; message: string }[] };
  saveCustomTheme(manifest: ThemeManifest): ThemeManifest;
  removeCustomTheme(id: string): boolean;
  listWorkspaceFiles(query?: string): string[];
  getWorkspaceDiff(): WorkspaceDiffReport;
  sanitizeText(text: string): string;
}

export class FutrynClient {
  private currentSession: { id: string; selection: Selection; messages: Message[] } | null = null;
  private currentMode: AgentMode = 'chat';
  private lastUsage: Usage | null = null;
  private sending = false;
  private streamingText = '';
  private streamingSteps: Message[] = [];
  /** Live limit results by account id, from the last refreshLimits(). */
  private liveLimits = new Map<string, AccountLimits>();
  private limitsRefresh: Promise<void> | null = null;
  private limitsPending = new Set<string>();
  private eventSeq = 0;
  private latestEvent: ReactiveAgentEvent = { seq: 0, kind: 'idle', timestamp: Date.now() };
  private readonly eventListeners = new Set<(event: ReactiveAgentEvent) => void>();
  private readonly permissions = new Map<string, PermissionPromptRequest>();
  private readonly sessionGrants = new Set<string>();
  private readonly permissionWaiters = new Map<string, (resolution: PermissionPromptResolution) => void>();
  /** Workspace tools are offered only after the UI obtained folder consent (ADR 0014/0017). */
  private toolsAllowed = false;

  constructor(private readonly ports: FutrynBackendPorts) {}

  private clearSessionAuthorization(): void {
    this.sessionGrants.clear();
    this.ports.toolGrants?.clear();
    for (const request of this.permissions.values()) {
      if (request.status === 'pending') {
        request.status = 'denied';
        // Wake any tool call waiting on this prompt; a cleared session never grants.
        const waiter = this.permissionWaiters.get(request.approvalId);
        this.permissionWaiters.delete(request.approvalId);
        waiter?.({ approvalId: request.approvalId, scopeHash: request.scopeHash, decision: 'deny', resolvedAt: new Date().toISOString() });
      }
    }
  }

  /** Allow or withhold workspace tools for this client (the TUI enables them after folder consent). */
  setToolsEnabled(enabled: boolean): void { this.toolsAllowed = enabled; this.notifyStateChange(); }

  toolsEnabled(): boolean { return this.toolsAllowed; }

  /** Files the user allowed tools to read for the rest of this session. */
  listToolGrants(): string[] { return this.ports.toolGrants?.list() ?? []; }

  /** Revoke every session tool grant; the next read asks again. */
  revokeToolGrants(): void { this.ports.toolGrants?.clear(); this.notifyStateChange(); }

  /** Last authorized instruction snapshot metadata; instruction contents are not exposed here. */
  projectContext(): ProjectContextReport | null { return this.ports.getProjectContext?.() ?? null; }

  workspace(): string {
    return this.ports.workspace;
  }

  mode(): AgentMode {
    return this.currentMode;
  }

  setMode(mode: AgentMode): AgentMode {
    this.currentMode = mode;
    this.notifyStateChange();
    return this.currentMode;
  }

  cycleMode(): AgentMode {
    const order: AgentMode[] = ['chat', 'plan', 'review'];
    const idx = order.indexOf(this.currentMode);
    return this.setMode(order[(idx + 1) % order.length]!);
  }

  capabilities(): BackendCapabilitiesReport {
    return {
      providerAuth: 'implemented',
      streamingChat: 'implemented',
      sessionPersistence: 'implemented',
      themesAndWallpapers: 'implemented',
      workspaceDiff: 'implemented',
      permissionDialog: 'implemented',
      generalToolsExecution: 'not-implemented',
      mcpIntegration: 'not-implemented',
      pluginHost: 'not-implemented',
      delegatedSubagents: 'not-implemented',
    };
  }

  emitReactiveEvent(kind: ReactiveAgentEventKind, detail?: string): ReactiveAgentEvent {
    const event: ReactiveAgentEvent = {
      seq: ++this.eventSeq,
      kind,
      detail: detail ? this.ports.sanitizeText(detail) : undefined,
      timestamp: Date.now(),
    };
    this.latestEvent = event;
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Ignore observer errors
      }
    }
    return event;
  }

  private notifyStateChange(): void {
    this.emitReactiveEvent(this.sending ? this.latestEvent.kind : 'idle');
  }

  currentReactiveEvent(): ReactiveAgentEvent {
    return this.latestEvent;
  }

  onReactiveEvent(listener: (event: ReactiveAgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  status(projectScoped = false) {
    const project = projectScoped ? this.ports.workspace : undefined;
    const state = this.ports.settings.read();
    const selection = this.currentSession?.selection ?? this.ports.resolveSelection(project);
    const activeAccount = selection
      ? state.accounts.find(a => a.id === selection.accountId) ?? null
      : state.activeAccountId
        ? state.accounts.find(a => a.id === state.activeAccountId) ?? null
        : null;
    const activeProvider = activeAccount
      ? state.providers.find(p => p.id === activeAccount.providerId) ?? null
      : null;
    let activeModel: ModelInfo | null = null;
    if (activeAccount && selection) {
      try {
        activeModel = this.ports.cachedModels(activeAccount).find(m => m.id === selection.modelId) ?? null;
      } catch {
        activeModel = null;
      }
    }
    return {
      workspace: this.ports.workspace,
      mode: this.currentMode,
      providers: state.providers,
      accounts: state.accounts,
      activeAccount,
      activeProvider,
      selection,
      activeModel,
      workspaceReadStatus: !this.toolsAllowed ? 'disabled' : !activeModel || (activeProvider?.runtime && activeProvider.runtime !== 'codex') || activeModel.capabilities.tools === 'unsupported' ? 'unavailable' : 'read-only',
      activeSessionId: this.currentSession?.id ?? null,
      messageCount: this.currentSession?.messages.length ?? 0,
      lastUsage: this.usage().last?.usage ?? this.lastUsage,
      usage: this.usage(),
      reasoningEffort: activeAccount && activeModel ? this.effort(activeAccount.id, activeModel) : null,
      phase: this.latestEvent.kind,
      pendingPermissions: this.listPendingPermissions().length,
      capabilities: this.capabilities(),
    };
  }

  // Providers, Accounts & Models
  async beginProviderAuth(providerId: string, methodId?: string, signal?: AbortSignal): Promise<ProviderAuthChallenge> {
    if (!this.ports.beginProviderAuth) throw new HannesError('UNSUPPORTED');
    return this.ports.beginProviderAuth(providerId, methodId, signal);
  }

  async cancelProviderAuth(challengeId: string): Promise<void> { await this.ports.cancelProviderAuth?.(challengeId); }
  providerAuthProgress(challengeId: string): ProviderAuthProgress {
    if (!this.ports.providerAuthProgress) throw new HannesError('UNSUPPORTED');
    return this.ports.providerAuthProgress(challengeId);
  }

  listIntegrations(): Integration[] {
    return this.ports.listIntegrations?.() ?? [];
  }

  listProviders(): Provider[] {
    return this.ports.listProviders();
  }

  listProviderPresets(): Provider[] {
    return this.ports.listProviderPresets();
  }

  addProvider(provider: Provider): Provider {
    const added = this.ports.addProvider(provider); this.notifyStateChange(); return added;
  }

  removeProvider(id: string): void {
    this.ports.removeProvider(id); this.notifyStateChange();
  }

  listAccounts(): Account[] {
    return this.ports.listAccounts();
  }

  async connectAccount(input: ConnectAccountInput, signal?: AbortSignal): Promise<Account> {
    if (this.sending) throw new HannesError('POLICY');
    const existingProvider = this.ports.listProviders().find(p => p.id === input.providerId);
    if (!existingProvider) {
      const preset = this.ports.listProviderPresets().find(p => p.id === input.providerId);
      if (!preset) throw new HannesError('NOT_FOUND');
      this.ports.addProvider(preset);
    }
    if (signal?.aborted) throw new HannesError('CANCELLED');
    let account: Account | undefined;
    let runtimeCredential: CredentialRef | undefined;
    try {
      let credential = input.credential;
      let secret = input.secret;
      if (input.authChallengeId && this.ports.listProviders().find(p => p.id === input.providerId)?.runtime) {
        if (!this.ports.completeSubscriptionAuth) throw new HannesError('UNSUPPORTED');
        credential = runtimeCredential = await this.ports.completeSubscriptionAuth(input.providerId, input.authChallengeId, signal);
      } else if (input.authChallengeId) {
        if (!this.ports.completeProviderAuth || !input.authorizationCode || input.credential.kind !== 'keyring') throw new HannesError('UNSUPPORTED');
        secret = await this.ports.completeProviderAuth(input.providerId, input.authChallengeId, input.authorizationCode, signal);
      }
      if (input.reauthenticateAccountId && this.ports.getAccount(input.reauthenticateAccountId).providerId !== input.providerId) throw new HannesError('POLICY');
      account = input.reauthenticateAccountId
        ? await this.ports.reauthenticateAccount(input.reauthenticateAccountId, credential, secret)
        : await this.ports.addAccount(input.providerId, input.alias, credential, secret);
      if (signal?.aborted) throw new HannesError('CANCELLED');
      if (input.manualModelId) this.ports.addManualModel(account, input.manualModelId);
      if (input.validate !== false) await this.ports.validateAccount(this.ports.getAccount(account.id), signal);
      if (signal?.aborted) throw new HannesError('CANCELLED');
      const refreshed = this.ports.getAccount(account.id);
      // Reconnecting a switch target must retain the source chat until explicit continuation.
      if (input.reauthenticateAccountId && this.currentSession && this.currentSession.selection.accountId !== refreshed.id) { this.notifyStateChange(); return refreshed; }
      this.ports.useAccount(refreshed.id);
      const models = this.ports.cachedModels(refreshed);
      const chosen = models.find(m => m.id === (input.manualModelId ?? refreshed.defaultModel)) ?? models[0];
      if (chosen) this.ports.selectModel(refreshed, chosen);
      this.clearSessionAuthorization();
      this.currentSession = null; this.lastUsage = null;
      this.notifyStateChange();
      return this.ports.getAccount(refreshed.id);
    } catch (error) {
      // A failed or cancelled login cannot leave a usable credential behind.
      // Failed cleanup is surfaced so the account remains retryable via /logout.
      if (account) await this.ports.logoutAccount(account.id, !input.reauthenticateAccountId);
      else if (runtimeCredential) await this.ports.discardSubscriptionCredential?.(runtimeCredential);
      if (account && this.currentSession?.selection.accountId === account.id) {
        this.clearSessionAuthorization(); this.currentSession = null; this.lastUsage = null;
      }
      this.notifyStateChange();
      throw error;
    }
  }

  async diagnose(signal?: AbortSignal, generate = false): Promise<string> {
    const status = this.status(); const account = status.activeAccount;
    if (!account) return 'No active account. Use /login. Runtime and private settings loaded.';
    const target = generate && status.selection?.accountId === account.id ? { ...account, defaultModel: status.selection.modelId } : account;
    const result = await this.ports.validateAccount(target, signal, generate);
    this.notifyStateChange();
    return `Connected: ${account.alias}; ${result.models} models; validated via ${result.validation}. Runtime and private settings loaded.`;
  }

  useAccount(idOrAlias: string): Account {
    const target = this.ports.getAccount(idOrAlias);
    if (target.status === 'logged-out') throw new HannesError('AUTH');
    if (this.status().activeAccount?.id === target.id) return target;
    if (this.sending) throw new HannesError('POLICY');
    const account = this.ports.useAccount(idOrAlias);
    this.clearSessionAuthorization();
    this.currentSession = null; this.lastUsage = null;
    this.notifyStateChange();
    return account;
  }

  renameAccount(idOrAlias: string, newAlias: string): Account {
    const renamed = this.ports.renameAccount(idOrAlias, newAlias); this.notifyStateChange(); return renamed;
  }

  async logoutAccount(idOrAlias: string, remove = true): Promise<void> {
    const target = this.ports.getAccount(idOrAlias);
    if (this.currentSession?.selection.accountId === target.id) {
      this.clearSessionAuthorization();
      this.currentSession = null; this.lastUsage = null;
    }
    try { await this.ports.logoutAccount(target.id, remove); } finally { this.notifyStateChange(); }
  }

  async discoverModels(options?: { accountId?: string; offline?: boolean; query?: string; capability?: keyof ModelInfo['capabilities']; signal?: AbortSignal }) {
    const state = this.ports.settings.read();
    const accountId = options?.accountId ?? state.activeAccountId;
    if (!accountId) throw new HannesError('AUTH');
    const account = this.ports.getAccount(accountId);
    const base = options?.offline
      ? { models: this.ports.cachedModels(account), stale: true, warning: 'Offline cache; availability unverified.' }
      : await this.ports.discoverModels(account, options?.signal);
    let models = base.models;
    if (options?.query?.trim()) {
      const q = options.query.trim().toLowerCase();
      models = models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    }
    if (options?.capability) {
      const cap = options.capability;
      models = models.filter(m => m.capabilities[cap] === 'supported');
    }
    this.notifyStateChange();
    return { ...base, models, account };
  }

  cachedModels(accountId?: string): ModelInfo[] {
    const state = this.ports.settings.read();
    const targetId = accountId ?? state.activeAccountId;
    if (!targetId) return [];
    try {
      const account = this.ports.getAccount(targetId);
      return this.ports.cachedModels(account);
    } catch {
      return [];
    }
  }

  addManualModel(modelId: string, accountId?: string): ModelInfo {
    const state = this.ports.settings.read();
    const targetId = accountId ?? state.activeAccountId;
    if (!targetId) throw new HannesError('AUTH');
    const account = this.ports.getAccount(targetId);
    const model = this.ports.addManualModel(account, modelId); this.notifyStateChange(); return model;
  }

  selectModel(modelId: string, options?: { accountId?: string; projectScoped?: boolean }): Selection {
    const state = this.ports.settings.read();
    const targetId = options?.accountId ?? state.activeAccountId;
    if (!targetId) throw new HannesError('AUTH');
    const account = this.ports.getAccount(targetId);
    const models = this.ports.cachedModels(account);
    const model = models.find(m => m.id === modelId);
    if (!model) throw new HannesError('NOT_FOUND');
    const previousSelection = this.currentSession?.selection;
    if (this.sending) throw new HannesError('POLICY');
    const selection = this.ports.selectModel(account, model, options?.projectScoped ? this.ports.workspace : undefined);
    // Conversation adapters and durable selections are pinned. Starting fresh
    // avoids advertising one model while the backend still invokes another.
    if (previousSelection && (previousSelection.accountId !== selection.accountId || previousSelection.modelId !== selection.modelId)) {
      this.clearSessionAuthorization();
      this.currentSession = null; this.lastUsage = null;
    }
    this.notifyStateChange();
    return selection;
  }

  // Sessions & Chat
  listSessions(): SessionSummary[] {
    return this.ports.listSessions();
  }

  getSession(id: string): SessionRecord | undefined {
    return this.ports.getSession(id);
  }

  createSession(projectScoped = false): { id: string; selection: Selection; messages: Message[] } {
    if (this.sending) throw new HannesError('POLICY');
    this.clearSessionAuthorization();
    this.currentSession = this.ports.startSession(projectScoped ? this.ports.workspace : undefined);
    this.lastUsage = null;
    this.notifyStateChange();
    return {
      id: this.currentSession.id,
      selection: { ...this.currentSession.selection },
      messages: [...this.currentSession.messages],
    };
  }

  resumeSession(id: string): { id: string; selection: Selection; messages: Message[] } {
    if (this.sending) throw new HannesError('POLICY');
    this.clearSessionAuthorization();
    this.currentSession = this.ports.resumeSession(id);
    this.lastUsage = this.ports.getSession(id)?.turns?.at(-1)?.usage ?? null;
    this.notifyStateChange();
    return {
      id: this.currentSession.id,
      selection: { ...this.currentSession.selection },
      messages: [...this.currentSession.messages],
    };
  }

  deleteSession(id: string): boolean {
    if (this.currentSession?.id === id && this.sending) throw new HannesError('POLICY');
    if (this.currentSession?.id === id) {
      this.currentSession = null; this.lastUsage = null;
    }
    const deleted = this.ports.deleteSession(id); this.notifyStateChange(); return deleted;
  }

  clearSessionView(): void {
    if (this.sending) throw new HannesError('POLICY');
    this.clearSessionAuthorization();
    this.currentSession = null;
    this.lastUsage = null;
    this.notifyStateChange();
  }

  activeSession(): { id: string; selection: Selection; messages: Message[] } | null {
    if (!this.currentSession) return null;
    return {
      id: this.currentSession.id,
      selection: { ...this.currentSession.selection },
      messages: this.currentSession.messages.map(m => ({ ...m })),
    };
  }

  async *sendMessage(
    content: string,
    options?: { signal?: AbortSignal; maxOutputTokens?: number; maxEstimatedCostUSD?: number; projectScoped?: boolean },
  ): AsyncIterable<ModelEvent> {
    const trimmed = content.trim();
    if (!trimmed) throw new HannesError('INVALID_INPUT');
    if (this.sending) throw new HannesError('POLICY');
    if (!this.currentSession) {
      this.currentSession = this.ports.startSession(options?.projectScoped ? this.ports.workspace : undefined);
    }
    const session = this.currentSession;
    this.sending = true; this.streamingText = ''; this.streamingSteps = []; this.lastUsage = null;
    this.emitReactiveEvent('thinking', 'Preparing request');
    let assistantText = '';
    try {
      for await (const event of this.ports.sendTurn(
        session.id,
        trimmed,
        options?.signal,
        options?.maxOutputTokens,
        options?.maxEstimatedCostUSD,
        this.status().reasoningEffort ?? undefined,
      )) {
        if (event.type === 'started') {
          this.emitReactiveEvent('waiting', 'Waiting for provider');
        } else if (event.type === 'textDelta') {
          assistantText += event.text; this.streamingText = assistantText;
          this.emitReactiveEvent('streaming');
        } else if (event.type === 'reasoningDelta') {
          this.emitReactiveEvent('reasoning', 'Provider thinking');
        } else if (event.type === 'context') {
          if (event.context.source !== 'estimate' && event.context.limitTokens != null) {
            // Remember only an observed runtime limit for this exact model/account.
            this.ports.settings.update(settings => {
              if (!settings.accounts.some(account => account.id === session.selection.accountId && account.status !== 'logged-out')) return;
              const model = settings.catalogs.find(cache => cache.accountId === session.selection.accountId)?.models.find(model => model.id === session.selection.modelId);
              if (model && (model.contextLimit == null || model.metadataSource?.endsWith(':observed-context'))) { model.contextLimit = event.context.limitTokens; model.metadataSource = `${event.context.source}:observed-context`; model.metadataFetchedAt = event.context.measuredAt; }
            });
          }
          this.notifyStateChange();
        } else if (event.type === 'usage') {
          this.lastUsage = event.usage; this.notifyStateChange();
        } else if (event.type === 'toolCallComplete') {
          this.streamingSteps.push({role: 'assistant', content: '', toolCalls: [event.call]});
          this.emitReactiveEvent('tool', event.call.name);
        } else if (event.type === 'toolResult') {
          this.streamingSteps.push({role: 'tool', content: event.result.content, toolCallId: event.result.callId, toolName: event.result.name});
          this.notifyStateChange();
        } else if (event.type === 'completed') {
          this.lastUsage = event.usage; this.streamingText = ''; this.streamingSteps = [];
          const stored = this.ports.getSession(session.id);
          if (stored) session.messages = stored.messages.filter(m => m.state === 'committed').map(({role, content, toolCalls, toolCallId, toolName}) => ({role, content, toolCalls, toolCallId, toolName}));
          else session.messages.push({role: 'user', content: trimmed}, {role: 'assistant', content: assistantText});
          this.emitReactiveEvent('done', event.finishReason);
        }
        yield event;
      }
    } catch (err) {
      this.emitReactiveEvent('error', err instanceof HannesError ? err.code : 'ERROR');
      throw err;
    } finally { this.sending = false; this.streamingText = ''; this.streamingSteps = []; }
  }

  usage() {
    const record = this.currentSession ? this.ports.getSession(this.currentSession.id) : undefined;
    const turns = record?.turns ?? [];
    const completed = turns.filter(t => t.outcome === 'completed').length;
    return summarizeUsage(turns, Math.max(0, (record?.messages.filter(m => m.role === 'user' && m.state === 'committed').length ?? 0) - completed));
  }

  /**
   * Limits for every connected account, from what is already known: the last live fetch, or the
   * plan snapshot a subscription runtime attached to its latest reply. Sends no request.
   */
  limits(): AccountLimits[] {
    const providers = new Map(this.ports.listProviders().map(p => [p.id, p]));
    const sessions = this.ports.listSessions();
    return this.ports.listAccounts().filter(account => account.status !== 'logged-out').map(account => {
      const providerName = providers.get(account.providerId)?.name ?? account.providerId;
      const base = { accountId: account.id, alias: account.alias, providerId: account.providerId, providerName };
      const live = this.liveLimits.get(account.id);
      const checking = this.limitsPending.has(account.id) || undefined;
      if (live && (live.items.length || live.error)) return { ...live, checking };
      for (const summary of sessions.filter(s => s.selection.accountId === account.id).slice(0, 20)) {
        const turn = this.ports.getSession(summary.id)?.turns?.filter(t => t.accountId === account.id && t.usage?.quota?.length).at(-1);
        const quota = turn?.usage?.quota;
        if (quota?.length) return { ...base, source: 'last-turn' as const, observedAt: quota[0]!.observedAt, items: quotaItems(quota), checking };
      }
      return { ...base, source: 'unavailable' as const, observedAt: live?.observedAt ?? null, items: [], note: live?.note, checking };
    });
  }

  /** Ask providers that have a balance/quota API for fresh numbers. Concurrent calls share one refresh. */
  refreshLimits(signal?: AbortSignal): Promise<void> {
    const fetchLimits = this.ports.fetchAccountLimits;
    if (!fetchLimits) return Promise.resolve();
    this.limitsRefresh ??= (async () => {
      const providers = new Map(this.ports.listProviders().map(p => [p.id, p]));
      await Promise.allSettled(this.ports.listAccounts().filter(account => account.status !== 'logged-out').map(async account => {
        const base = { accountId: account.id, alias: account.alias, providerId: account.providerId, providerName: providers.get(account.providerId)?.name ?? account.providerId };
        const request = fetchLimits(account, signal);
        if (!request) { this.liveLimits.delete(account.id); return; }
        this.limitsPending.add(account.id);
        try {
          const result = await request;
          this.liveLimits.set(account.id, { ...base, source: 'live', observedAt: new Date().toISOString(), items: result.items, note: result.note });
        } catch (error) {
          this.liveLimits.set(account.id, { ...base, source: 'live', observedAt: new Date().toISOString(), items: [], error: error instanceof HannesError ? error.code : 'PROTOCOL' });
        } finally { this.limitsPending.delete(account.id); }
      }));
      this.notifyStateChange();
    })().finally(() => { this.limitsRefresh = null; });
    return this.limitsRefresh;
  }

  context(draft = '') {
    const status = this.status();
    const history = this.currentSession?.messages ?? [];
    const record = this.currentSession ? this.ports.getSession(this.currentSession.id) : undefined;
    const pending = this.sending ? record?.messages.filter(message => message.state === 'pending').at(-1) : undefined;
    const trimmedDraft = draft.trim();
    const requestDraft = /^[\/!]/.test(trimmedDraft) ? '' : trimmedDraft;
    const components = [...history, ...(pending ? [{role: pending.role, content: pending.content}] : []), ...(pending ? this.streamingSteps : []), ...(pending && this.streamingText ? [{ role: 'assistant', content: this.streamingText }] : []), ...(requestDraft ? [{ role: 'user', content: requestDraft }] : [])];
    const bytes = new TextEncoder().encode(JSON.stringify(components)).length;
    const instructionBytes = this.projectContext()?.usedBytes ?? 0;
    const messageCount = components.length + (instructionBytes ? 1 : 0);
    const estimate = messageCount ? Math.ceil((bytes + instructionBytes) / 4) + messageCount * 16 + 64 : 0;
    const runtime = !!status.activeProvider?.runtime;
    const latest = this.usage().last;
    const observation = record?.turns?.findLast(turn => turn.context && turn.context.source !== 'estimate');
    const last = observation?.context ?? null;
    const limit = last?.limitTokens ?? status.activeModel?.contextLimit ?? null;
    const reserve = Math.min(4096, status.activeModel?.outputLimit ?? 4096);
    return { estimateTokens: estimate, estimateMethod: 'UTF-8 bytes / 4 + message overhead; no exact tokenizer',
      limitTokens: limit, outputReserve: runtime ? null : reserve, outputLimit: status.activeModel?.outputLimit ?? null, runtimeHiddenContext: runtime,
      estimatedPercent: limit && !runtime ? Math.round(estimate / limit * 1000) / 10 : null,
      measuredCurrentHistory: observation?.requestId === latest?.requestId && !requestDraft.trim() && (!this.sending || latest?.outcome === 'pending') && last?.usedTokens != null && last.limitTokens != null,
      lastMeasured: last, metadataSource: status.activeModel?.metadataSource ?? null,
      metadataAt: status.activeModel?.metadataFetchedAt ?? null, projectInstructionBytes: instructionBytes, messages: messageCount };
  }

  private effort(accountId: string, model: ModelInfo): string | null {
    const stored = this.ports.settings.read().reasoningPreferences?.[accountId + ':' + model.id];
    return stored && model.reasoningEfforts?.includes(stored) ? stored : model.defaultReasoningEffort ?? null;
  }
  setReasoningEffort(value: string): void {
    if (this.sending) throw new HannesError('POLICY');
    const status = this.status(); const model = status.activeModel; const account = status.activeAccount;
    if (!model || !account || !model.reasoningEfforts?.length) throw new HannesError('UNSUPPORTED');
    if (value !== 'default' && !model.reasoningEfforts.includes(value)) throw new HannesError('INVALID_INPUT');
    this.ports.settings.update(settings => {
      settings.reasoningPreferences ??= {};
      const key = account.id + ':' + model.id;
      if (value === 'default') delete settings.reasoningPreferences[key]; else settings.reasoningPreferences[key] = value;
    });
    this.notifyStateChange();
  }

  async switchAccount(reference: string, continueHistory = false, modelId?: string, signal?: AbortSignal): Promise<Account> {
    if (this.sending) throw new HannesError('POLICY');
    const accounts = this.listAccounts();
    const target = /^\d+$/.test(reference) ? accounts[Number(reference) - 1] : accounts.find(a => a.id === reference || a.alias === reference);
    if (!target) throw new HannesError('NOT_FOUND');
    if (target.status === 'logged-out') throw new HannesError('AUTH');
    const source = this.currentSession;
    const current = source?.selection ?? this.status().selection;
    if ((current?.accountId ?? this.status().activeAccount?.id) === target.id && (!modelId || current?.modelId === modelId)) return target;
    if (signal?.aborted) throw new HannesError('CANCELLED');
    const initialActiveId = this.status().activeAccount?.id;
    const initialSelection = JSON.stringify(this.status().selection);
    const catalog = await this.ports.discoverModels(target, signal);
    if (this.sending || this.currentSession !== source || this.status().activeAccount?.id !== initialActiveId || JSON.stringify(this.status().selection) !== initialSelection) throw new HannesError('POLICY');
    if (signal?.aborted) throw new HannesError('CANCELLED');
    if (catalog.stale) throw new HannesError('TRANSPORT');
    const previousId = source?.selection.modelId ?? this.status().selection?.modelId;
    const model = modelId ? catalog.models.find(m => m.id === modelId) : catalog.models.find(m => m.id === previousId) ?? catalog.models.find(m => m.id === target.defaultModel) ?? (!source ? catalog.models[0] : undefined);
    if (!model) throw new HannesError('NOT_FOUND');
    const selection = { accountId: target.id, modelId: model.id };
    if (continueHistory && source?.messages.length && !this.ports.forkSession) throw new HannesError('UNSUPPORTED');
    const fork = continueHistory && source?.messages.length ? this.ports.forkSession!(source.id, selection) : null;
    try { this.ports.selectModel(target, model); }
    catch (error) { if (fork) this.ports.deleteSession(fork.id); throw error; }
    this.clearSessionAuthorization(); this.currentSession = fork; this.lastUsage = null;
    this.emitReactiveEvent('idle', 'Account switched');
    return target;
  }

  // Appearance & Custom Themes
  getAppearance(projectScoped = true): AppearanceConfig {
    const state = this.ports.settings.read();
    const base = state.appearance ?? defaultAppearance();
    if (!projectScoped) return appearanceSchema.parse(base);
    const projectOverride = state.projectAppearances?.[this.ports.workspace];
    if (!projectOverride) return appearanceSchema.parse(base);
    return appearanceSchema.parse({
      ...base,
      ...(projectOverride.theme !== undefined ? { theme: projectOverride.theme } : {}),
      ...(projectOverride.mode !== undefined ? { mode: projectOverride.mode } : {}),
      ...(projectOverride.wallpaper !== undefined ? { wallpaper: projectOverride.wallpaper } : {}),
      ...(projectOverride.syntaxHighlighting !== undefined ? { syntaxHighlighting: projectOverride.syntaxHighlighting } : {}),
      ...(projectOverride.sidebar !== undefined ? { sidebar: projectOverride.sidebar } : {}),
      animations: {
        ...base.animations,
        ...(projectOverride.animations ?? {}),
      },
    });
  }

  updateAppearance(patch: PartialAppearanceConfig, scope: 'global' | 'project' = 'global'): AppearanceConfig {
    const validatedPatch = partialAppearanceSchema.parse(patch);
    this.ports.settings.update(s => {
      const currentGlobal = s.appearance ?? defaultAppearance();
      if (scope === 'global') {
        s.appearance = appearanceSchema.parse({
          ...currentGlobal,
          ...(validatedPatch.theme !== undefined ? { theme: validatedPatch.theme } : {}),
          ...(validatedPatch.mode !== undefined ? { mode: validatedPatch.mode } : {}),
          ...(validatedPatch.wallpaper !== undefined ? { wallpaper: validatedPatch.wallpaper } : {}),
          ...(validatedPatch.syntaxHighlighting !== undefined ? { syntaxHighlighting: validatedPatch.syntaxHighlighting } : {}),
          ...(validatedPatch.sidebar !== undefined ? { sidebar: validatedPatch.sidebar } : {}),
          animations: {
            ...currentGlobal.animations,
            ...(validatedPatch.animations ?? {}),
          },
        });
        // If project also had an override for the same keys, keep global authoritative unless project was explicitly targeted
        if (s.projectAppearances?.[this.ports.workspace]) {
          const proj = s.projectAppearances[this.ports.workspace]!;
          if (validatedPatch.theme !== undefined) delete proj.theme;
          if (validatedPatch.mode !== undefined) delete proj.mode;
          if (validatedPatch.wallpaper !== undefined) delete proj.wallpaper;
          if (validatedPatch.syntaxHighlighting !== undefined) delete proj.syntaxHighlighting;
          if (validatedPatch.sidebar !== undefined) delete proj.sidebar;
          if (validatedPatch.animations !== undefined) delete proj.animations;
        }
      } else {
        s.projectAppearances = s.projectAppearances ?? {};
        const prevProj = s.projectAppearances[this.ports.workspace] ?? {};
        s.projectAppearances[this.ports.workspace] = partialAppearanceSchema.parse({
          ...prevProj,
          ...validatedPatch,
          animations: validatedPatch.animations
            ? { ...(prevProj.animations ?? {}), ...validatedPatch.animations }
            : prevProj.animations,
        });
      }
    });
    this.notifyStateChange();
    return this.getAppearance(true);
  }

  loadCustomThemes(): { themes: ThemeManifest[]; errors: { file: string; message: string }[] } {
    return this.ports.loadCustomThemes();
  }

  saveCustomTheme(manifest: ThemeManifest): ThemeManifest {
    return this.ports.saveCustomTheme(manifest);
  }

  removeCustomTheme(id: string): boolean {
    return this.ports.removeCustomTheme(id);
  }

  // Workspace Files & Diff
  listWorkspaceFiles(query?: string): string[] {
    return this.ports.listWorkspaceFiles(query);
  }

  getWorkspaceDiff(): WorkspaceDiffReport {
    return this.ports.getWorkspaceDiff();
  }

  // Permission Dialog & Policy Gate
  listPermissions(): PermissionPromptRequest[] {
    const now = Date.now();
    for (const req of this.permissions.values()) {
      if (req.status === 'pending' && Date.parse(req.expiresAt) <= now) {
        req.status = 'expired';
      }
    }
    return [...this.permissions.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  listPendingPermissions(): PermissionPromptRequest[] {
    return this.listPermissions().filter(p => p.status === 'pending');
  }

  enqueuePermissionRequest(input: {
    capability: PermissionPromptRequest['capability'];
    action: string;
    target: string;
    riskLevel?: PermissionPromptRequest['riskLevel'];
    reason: string;
    diffPreview?: string;
    ttlMs?: number;
  }): PermissionPromptRequest {
    const now = new Date();
    const expires = new Date(now.getTime() + (input.ttlMs ?? 300_000));
    const scopeHash = createHash('sha256').update(JSON.stringify([input.capability, input.action, input.target])).digest('hex');
    const req = permissionPromptRequestSchema.parse({
      approvalId: crypto.randomUUID(),
      capability: input.capability,
      action: this.ports.sanitizeText(input.action),
      target: this.ports.sanitizeText(input.target),
      riskLevel: input.riskLevel ?? 'medium',
      reason: this.ports.sanitizeText(input.reason),
      scopeHash: scopeHash.length >= 8 ? scopeHash : scopeHash.padEnd(8, '_'),
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      diffPreview: input.diffPreview ? this.ports.sanitizeText(input.diffPreview) : undefined,
      status: this.sessionGrants.has(scopeHash) ? 'approved_session' : 'pending',
    });
    this.permissions.set(req.approvalId, req);
    if (req.status === 'pending') {
      this.emitReactiveEvent('permission', `${req.action} → ${req.target}`);
    }
    return req;
  }

  resolvePermission(approvalId: string, scopeHash: string, decision: PermissionResolutionScope): PermissionPromptResolution {
    const req = this.permissions.get(approvalId);
    if (!req) throw new HannesError('NOT_FOUND');
    if (req.scopeHash !== scopeHash) throw new HannesError('POLICY');
    if (req.status !== 'pending') throw new HannesError('POLICY');
    if (Date.parse(req.expiresAt) <= Date.now()) {
      req.status = 'expired';
      throw new HannesError('POLICY');
    }
    req.status = decision === 'once' ? 'approved_once' : decision === 'session' ? 'approved_session' : 'denied';
    if (decision === 'session') {
      this.sessionGrants.add(req.scopeHash);
    }
    const resolution = permissionPromptResolutionSchema.parse({
      approvalId,
      scopeHash,
      decision,
      resolvedAt: new Date().toISOString(),
    });
    const waiter = this.permissionWaiters.get(approvalId);
    if (waiter) {
      this.permissionWaiters.delete(approvalId);
      waiter(resolution);
    }
    this.emitReactiveEvent(decision === 'deny' ? 'error' : 'done', `Permission ${req.status}`);
    return resolution;
  }

  /**
   * Ask the user and wait. Resolves 'deny' when the prompt is dismissed, expires, the session is
   * cleared or `signal` aborts, so a waiting tool call can never hang or be granted by accident.
   */
  requestPermission(input: { capability: PermissionPromptRequest['capability']; action: string; target: string; reason: string; riskLevel?: PermissionPromptRequest['riskLevel'] }, signal?: AbortSignal): Promise<PermissionResolutionScope> {
    if (signal?.aborted) return Promise.resolve('deny');
    const request = this.enqueuePermissionRequest(input);
    if (request.status === 'approved_session') return Promise.resolve('session');
    return new Promise(resolve => {
      const settle = (decision: PermissionResolutionScope) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(decision); };
      const expire = () => {
        if (request.status === 'pending') request.status = 'expired';
        this.permissionWaiters.delete(request.approvalId);
        this.notifyStateChange();
        settle('deny');
      };
      const onAbort = () => { if (request.status === 'pending') this.dismissPermissionDialog(request.approvalId); else expire(); };
      const timer = setTimeout(expire, Math.max(0, Date.parse(request.expiresAt) - Date.now()));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.permissionWaiters.set(request.approvalId, resolution => settle(resolution.decision));
    });
  }

  /**
   * Dismissing a permission dialog without explicit approval ALWAYS denies or leaves pending safely;
   * closing a dialog never grants permission.
   */
  dismissPermissionDialog(approvalId: string): PermissionPromptResolution {
    const req = this.permissions.get(approvalId);
    if (!req) throw new HannesError('NOT_FOUND');
    if (req.status === 'pending') {
      return this.resolvePermission(approvalId, req.scopeHash, 'deny');
    }
    return {
      approvalId: req.approvalId,
      scopeHash: req.scopeHash,
      decision: 'deny',
      resolvedAt: new Date().toISOString(),
    };
  }
}

export { FutrynClient as HannesClient };
