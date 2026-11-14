import { createHash } from 'node:crypto';
import {
  HannesError,
  appearanceSchema,
  defaultAppearance,
  partialAppearanceSchema,
  permissionPromptResolutionSchema,
  permissionPromptRequestSchema,
  type Account,
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

export type ReactiveAgentEventKind = 'idle' | 'thinking' | 'streaming' | 'tool' | 'permission' | 'error' | 'done';

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
  discoverModels(account: Account, signal?: AbortSignal): Promise<{ models: ModelInfo[]; stale: boolean; warning?: string }>;
  cachedModels(account: Account): ModelInfo[];
  addManualModel(account: Account, modelId: string): ModelInfo;
  selectModel(account: Account, model: ModelInfo, project?: string): Selection;
  resolveSelection(project?: string): Selection | null;
  listSessions(): SessionSummary[];
  getSession(id: string): SessionRecord | undefined;
  deleteSession(id: string): boolean;
  startSession(project?: string): { id: string; selection: Selection; messages: Message[] };
  resumeSession(id: string): { id: string; selection: Selection; messages: Message[] };
  sendTurn(
    sessionId: string,
    content: string,
    signal?: AbortSignal,
    maxOutputTokens?: number,
    maxEstimatedCostUSD?: number,
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
  private eventSeq = 0;
  private latestEvent: ReactiveAgentEvent = { seq: 0, kind: 'idle', timestamp: Date.now() };
  private readonly eventListeners = new Set<(event: ReactiveAgentEvent) => void>();
  private readonly permissions = new Map<string, PermissionPromptRequest>();
  private readonly sessionGrants = new Set<string>();
  private readonly permissionWaiters = new Map<string, (resolution: PermissionPromptResolution) => void>();

  constructor(private readonly ports: FutrynBackendPorts) {}

  private clearSessionAuthorization(): void {
    this.sessionGrants.clear();
    for (const request of this.permissions.values()) {
      if (request.status === 'pending') request.status = 'denied';
    }
  }

  workspace(): string {
    return this.ports.workspace;
  }

  mode(): AgentMode {
    return this.currentMode;
  }

  setMode(mode: AgentMode): AgentMode {
    this.currentMode = mode;
    return this.currentMode;
  }

  cycleMode(): AgentMode {
    const order: AgentMode[] = ['chat', 'plan', 'review'];
    const idx = order.indexOf(this.currentMode);
    this.currentMode = order[(idx + 1) % order.length]!;
    return this.currentMode;
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
    const selection = this.ports.resolveSelection(project);
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
      activeSessionId: this.currentSession?.id ?? null,
      messageCount: this.currentSession?.messages.length ?? 0,
      lastUsage: this.lastUsage,
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
    return this.ports.addProvider(provider);
  }

  removeProvider(id: string): void {
    this.ports.removeProvider(id);
  }

  listAccounts(): Account[] {
    return this.ports.listAccounts();
  }

  async connectAccount(input: ConnectAccountInput, signal?: AbortSignal): Promise<Account> {
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
      this.ports.useAccount(refreshed.id);
      const models = this.ports.cachedModels(refreshed);
      const chosen = models.find(m => m.id === (input.manualModelId ?? refreshed.defaultModel)) ?? models[0];
      if (chosen) this.ports.selectModel(refreshed, chosen);
      this.clearSessionAuthorization();
      this.currentSession = null;
      return this.ports.getAccount(refreshed.id);
    } catch (error) {
      // A failed or cancelled login cannot leave a usable credential behind.
      // Failed cleanup is surfaced so the account remains retryable via /logout.
      if (account) await this.ports.logoutAccount(account.id, !input.reauthenticateAccountId);
      else if (runtimeCredential) await this.ports.discardSubscriptionCredential?.(runtimeCredential);
      throw error;
    }
  }

  async diagnose(signal?: AbortSignal): Promise<string> {
    const account = this.status().activeAccount;
    if (!account) return 'No active account. Use /login. Runtime and private settings loaded.';
    const result = await this.ports.validateAccount(account, signal);
    return `Connected: ${account.alias}; ${result.models} models; validated via ${result.validation}. Runtime and private settings loaded.`;
  }

  useAccount(idOrAlias: string): Account {
    const account = this.ports.useAccount(idOrAlias);
    this.clearSessionAuthorization();
    this.currentSession = null;
    return account;
  }

  renameAccount(idOrAlias: string, newAlias: string): Account {
    return this.ports.renameAccount(idOrAlias, newAlias);
  }

  async logoutAccount(idOrAlias: string, remove = false): Promise<void> {
    const target = this.ports.getAccount(idOrAlias);
    if (this.currentSession?.selection.accountId === target.id) {
      this.clearSessionAuthorization();
      this.currentSession = null;
    }
    await this.ports.logoutAccount(target.id, remove);
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
    return this.ports.addManualModel(account, modelId);
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
    const selection = this.ports.selectModel(account, model, options?.projectScoped ? this.ports.workspace : undefined);
    // Conversation adapters and durable selections are pinned. Starting fresh
    // avoids advertising one model while the backend still invokes another.
    if (previousSelection && (previousSelection.accountId !== selection.accountId || previousSelection.modelId !== selection.modelId)) {
      this.clearSessionAuthorization();
      this.currentSession = null;
    }
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
    this.clearSessionAuthorization();
    this.currentSession = this.ports.startSession(projectScoped ? this.ports.workspace : undefined);
    this.lastUsage = null;
    return {
      id: this.currentSession.id,
      selection: { ...this.currentSession.selection },
      messages: [...this.currentSession.messages],
    };
  }

  resumeSession(id: string): { id: string; selection: Selection; messages: Message[] } {
    this.clearSessionAuthorization();
    this.currentSession = this.ports.resumeSession(id);
    return {
      id: this.currentSession.id,
      selection: { ...this.currentSession.selection },
      messages: [...this.currentSession.messages],
    };
  }

  deleteSession(id: string): boolean {
    if (this.currentSession?.id === id) {
      this.currentSession = null;
    }
    return this.ports.deleteSession(id);
  }

  clearSessionView(): void {
    this.clearSessionAuthorization();
    this.currentSession = null;
    this.lastUsage = null;
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
    if (!this.currentSession) {
      this.currentSession = this.ports.startSession(options?.projectScoped ? this.ports.workspace : undefined);
    }
    const session = this.currentSession;
    this.emitReactiveEvent('thinking', 'Preparing request');
    let assistantText = '';
    try {
      for await (const event of this.ports.sendTurn(
        session.id,
        trimmed,
        options?.signal,
        options?.maxOutputTokens,
        options?.maxEstimatedCostUSD,
      )) {
        if (event.type === 'started') {
          this.emitReactiveEvent('streaming', event.requestId);
        } else if (event.type === 'textDelta') {
          assistantText += event.text;
          this.emitReactiveEvent('streaming');
        } else if (event.type === 'toolCallComplete') {
          this.emitReactiveEvent('tool', event.call.name);
        } else if (event.type === 'completed') {
          this.lastUsage = event.usage;
          session.messages.push(
            { role: 'user', content: trimmed },
            { role: 'assistant', content: assistantText },
          );
          this.emitReactiveEvent('done', event.finishReason);
        }
        yield event;
      }
    } catch (err) {
      this.emitReactiveEvent('error', err instanceof HannesError ? err.code : 'ERROR');
      throw err;
    }
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
