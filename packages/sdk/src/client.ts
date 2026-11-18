import {summarizeUsage} from './telemetry';
import {quotaItems, type AccountLimits, type FetchAccountLimits} from './limits';
import {createHash} from 'node:crypto';
import {
  FutrynError,
  appearanceSchema,
  defaultAppearance,
  partialAppearanceSchema,
  permissionPromptResolutionSchema,
  permissionPromptRequestSchema,
  type Account,
  type CommandOutputChunk,
  type ToolResult,
  type ProjectContextReport,
  type Integration,
  type ProviderAuthChallenge,
  type ProviderAuthProgress,
  type AppearanceConfig,
  type CredentialRef,
  type Message,
  type ModelEvent,
  type InteractionEvent,
  type ModelInfo,
  type PartialAppearanceConfig,
  type PermissionPromptRequest,
  type PermissionPromptResolution,
  type PermissionResolutionScope,
  type PermissionMode,
  type PermissionKind,
  type PlanState,
  type PendingQuestion,
  type UserAnswers,
  type UserInputOutcome,
  type UserQuestion,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  APPROVAL_POLICY_FOR_MODE,
  COMMAND_RULE_TOOLS,
  PERMISSION_PRESETS,
  SANDBOX_MODES,
  permissionPresetFor,
  type PermissionPreset,
  type PermissionPresetId,
  type SandboxModeSetting,
  turnBudgetSchema,
  type TurnBudget,
  executionBackendFor,
  permissionModeDecision,
  permissionRuleDecision,
  permissionRuleSchema,
  type CompactionOutcome,
  type PermissionRuleEffect,
  type PermissionRuleSet,
  type PermissionRuleTool,
  type Provider,
  type Selection,
  type SessionRecord,
  type SessionSummary,
  type SettingsStore,
  type SteerOutcome,
  type ThemeManifest,
  type Usage,
  type WorkspaceDiffFile,
  type WorkspaceDiffReport,
} from '@futryn/contracts';

export type AgentMode = 'chat' | 'plan' | 'review';

export type ReactiveAgentEventKind =
  | 'idle'
  | 'thinking'
  | 'waiting'
  | 'reasoning'
  | 'streaming'
  | 'tool'
  | 'permission'
  | 'error'
  | 'done'
  /** Wave 1 notifications (contract 1.19); they never replace the current activity state. */
  | 'plan.updated'
  | 'question.asked'
  | 'question.answered';

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

export interface TerminalRuntimeReport {
  label: string;
  available: boolean;
  reason?: string;
  sandbox: SandboxModeSetting | 'unavailable';
  escalation: 'on-request' | 'never';
  limitations: string[];
}

export interface FutrynBackendPorts {
  workspace: string;
  terminalRuntime?(): TerminalRuntimeReport;
  /** Names of the Futryn tools actually offered now (folder consent + runtime availability). */
  availableTools?(): string[];
  /** `!command` shell mode (ADR 0034): the same exec_command dispatcher, approval and sandbox as model calls. */
  runShellCommand?(
    command: string,
    signal?: AbortSignal,
    onOutput?: (chunk: CommandOutputChunk) => void,
    context?: {sessionId: string; callId: string},
  ): Promise<ToolResult>;
  getProjectContext?(): ProjectContextReport | null;
  /**
   * Mode every session starts in (ADR 0040; `FUTRYN_APPROVAL_POLICY`). Defaults to `auto`
   * (Codex `on-request` in the workspace-write sandbox).
   */
  permissionMode?: PermissionMode;
  /**
   * Sandbox every session starts in (ADR 0055; `FUTRYN_SANDBOX_MODE`, config `sandbox_mode`).
   * Defaults to `workspace-write`. The session can change it with a preset; it is never persisted.
   */
  sandboxMode?: SandboxModeSetting;
  /** Sandboxed commands get network without asking (`FUTRYN_SANDBOX_NETWORK`, config `network_access`). */
  sandboxNetwork?: boolean;
  /** Durable plan of a session (ADR 0042). */
  getPlan?(sessionId: string): PlanState | null;
  settings: SettingsStore;
  listIntegrations?(): Integration[];
  beginProviderAuth?(providerId: string, methodId?: string, signal?: AbortSignal): Promise<ProviderAuthChallenge>;
  /** Finish an OAuth sign-in that runs a local callback; resolves to the secret the keyring stores (ADR 0047). */
  completeOAuthSignIn?(providerId: string, challengeId: string, signal?: AbortSignal): Promise<string>;
  completeProviderAuth?(providerId: string, challengeId: string, code: string, signal?: AbortSignal): Promise<string>;
  cancelProviderAuth?(challengeId: string): void | Promise<void>;
  providerAuthProgress?(challengeId: string): ProviderAuthProgress;
  listProviders(): Provider[];
  listProviderPresets(): Provider[];
  addProvider(provider: Provider): Provider;
  removeProvider(id: string): void;
  /** Problems found in the user-level host config (ADR 0046); empty when it is fine or absent. */
  hostConfigDiagnostics?(): string[];
  /** Why a custom provider would be refused by the host config rules, or null when it is fine. */
  validateHostProvider?(provider: Provider): string | null;
  listAccounts(): Account[];
  getAccount(idOrAlias: string): Account;
  addAccount(providerId: string, alias: string, credential: CredentialRef, secret?: string): Promise<Account>;
  reauthenticateAccount(id: string, credential: CredentialRef, secret?: string): Promise<Account>;
  useAccount(idOrAlias: string): Account;
  renameAccount(idOrAlias: string, newAlias: string): Account;
  logoutAccount(idOrAlias: string, remove?: boolean): Promise<void>;
  validateAccount(
    account: Account,
    signal?: AbortSignal,
    generate?: boolean,
  ): Promise<{models: number; validation: string}>;
  /** Optional: session-scoped tool grants ('Allow for session'), as workspace-relative targets. */
  toolGrants?: {list(): string[]; clear(): void};
  /** Optional: live balance/quota from providers that expose one (e.g. OpenRouter key credit). */
  fetchAccountLimits?: FetchAccountLimits;
  discoverModels(
    account: Account,
    signal?: AbortSignal,
  ): Promise<{models: ModelInfo[]; stale: boolean; warning?: string}>;
  cachedModels(account: Account): ModelInfo[];
  addManualModel(account: Account, modelId: string): ModelInfo;
  selectModel(account: Account, model: ModelInfo, project?: string): Selection;
  resolveSelection(project?: string): Selection | null;
  listSessions(): SessionSummary[];
  getSession(id: string): SessionRecord | undefined;
  deleteSession(id: string): boolean;
  forkSession?(id: string, selection: Selection): {id: string; selection: Selection; messages: Message[]};
  startSession(project?: string): {id: string; selection: Selection; messages: Message[]};
  resumeSession(id: string): {id: string; selection: Selection; messages: Message[]};
  sendTurn(
    sessionId: string,
    content: string,
    signal?: AbortSignal,
    maxOutputTokens?: number,
    maxEstimatedCostUSD?: number,
    reasoningEffort?: string,
    queuedInputId?: string,
  ): AsyncIterable<ModelEvent>;
  /** Compact the idle conversation `sessionId` with its current model (ADR 0054). Absent when unsupported. */
  compactSession?(
    sessionId: string,
    instructions: string | undefined,
    signal?: AbortSignal,
  ): Promise<CompactionOutcome>;
  /** Steer the active turn of `sessionId` (ADR 0033). Absent when the backend cannot steer. */
  steerTurn?(sessionId: string, content: string, expectedTurnId?: string): SteerOutcome;
  /** Accepted instructions of `sessionId` that no turn processed yet (durable; they open its next turn). */
  queuedInput?(sessionId: string): readonly {steerId: string; content: string}[];
  /** Finishing-turn input is durable before the SDK reports it accepted. */
  enqueueNextTurn?(sessionId: string, content: string): {id: string; content: string};
  listNextTurn?(sessionId: string): readonly {id: string; content: string}[];
  loadCustomThemes(): {themes: ThemeManifest[]; errors: {file: string; message: string}[]};
  saveCustomTheme(manifest: ThemeManifest): ThemeManifest;
  removeCustomTheme(id: string): boolean;
  listWorkspaceFiles(query?: string): string[];
  getWorkspaceDiff(): WorkspaceDiffReport;
  refreshWorkspaceDiff?(): Promise<WorkspaceDiffReport>;
  /** True only when the read policy lets this workspace path's content reach the model without approval. */
  readAllowedWithoutApproval?(relativePath: string): boolean;
  sanitizeText(text: string): string;
}

/** The committed history of a stored session: the journal reconstruction when present. */
function committedSessionMessages(stored: SessionRecord): Message[] {
  if (stored.recovery?.messages) return stored.recovery.messages;
  return stored.messages
    .filter(m => m.state === 'committed')
    .map(({role, content, toolCalls, toolCallId, toolName, attachments}) => ({
      role,
      content,
      toolCalls,
      toolCallId,
      toolName,
      ...(attachments ? {attachments} : {}),
    }));
}

export class FutrynClient {
  private currentSession: {id: string; selection: Selection; messages: Message[]} | null = null;
  private currentMode: AgentMode = 'chat';
  /** Session permission mode (ADR 0027/0040); never persisted, every session starts in the configured mode. */
  private permissionModeValue: PermissionMode;
  /** Session sandbox (ADR 0055): changed only by a preset/`setSandboxMode`, reset with the session. */
  private sandboxModeValue: SandboxModeSetting;
  /** Optional per-turn work budget (ADR 0030); undefined means no limit. Session-only. */
  private turnBudgetValue: TurnBudget | undefined;
  private lastUsage: Usage | null = null;
  /** Status is read on every UI frame; explicit usage reports remain fresh reads. */
  private statusUsage: ReturnType<FutrynClient['usage']> | null = null;
  private sending = false;
  /** Turn identity of the running send, used to reject stale steering (Codex expected_turn_id). */
  private activeTurnId: string | undefined;
  /** Messages submitted while a turn was finishing (Codex start_or_steer → next turn), in order. */
  private readonly claimedNextTurn = new Map<string, {id: string; content: string}>();
  private streamingText = '';
  private streamingSteps: Message[] = [];
  /** Live limit results by account id, from the last refreshLimits(). */
  private liveLimits = new Map<string, AccountLimits>();
  private limitsRefresh: Promise<void> | null = null;
  private limitsPending = new Set<string>();
  private eventSeq = 0;
  private latestEvent: ReactiveAgentEvent = {seq: 0, kind: 'idle', timestamp: Date.now()};
  private readonly eventListeners = new Set<(event: ReactiveAgentEvent) => void>();
  private readonly interactionListeners = new Set<(event: InteractionEvent) => void>();
  private readonly permissions = new Map<string, PermissionPromptRequest>();
  private readonly sessionGrants = new Set<string>();
  private readonly permissionWaiters = new Map<string, (resolution: PermissionPromptResolution) => void>();
  /** Workspace tools are offered only after the UI obtained folder consent (ADR 0014/0017). */
  private toolsAllowed = false;

  constructor(private readonly ports: FutrynBackendPorts) {
    this.turnBudgetValue = ports.settings.read().agentPreferences?.turnBudget;
    this.permissionModeValue = this.initialPermissionMode();
    this.sandboxModeValue = this.initialSandboxMode();
  }

  /** The configured starting sandbox (ADR 0055); `workspace-write` unless configured otherwise. */
  initialSandboxMode(): SandboxModeSetting {
    const mode = this.ports.sandboxMode;
    return mode && SANDBOX_MODES.includes(mode) ? mode : 'workspace-write';
  }

  /** The configured starting mode (ADR 0040); `auto` = Codex on-request unless configured otherwise. */
  initialPermissionMode(): PermissionMode {
    const mode = this.ports.permissionMode;
    return mode && PERMISSION_MODES.includes(mode) ? mode : DEFAULT_PERMISSION_MODE;
  }

  /** Identity of the running turn, if any; turn-scoped grants (request_permissions "once") bind to it. */
  currentTurnId(): string | undefined {
    return this.sending ? this.activeTurnId : undefined;
  }

  /** User preferences constrain work, never authorize tools or restore session grants. */
  defaultTurnBudget(): {value: TurnBudget | undefined; source: 'default' | 'user'} {
    const value = this.ports.settings.read().agentPreferences?.turnBudget;
    return {value: value ? {...value} : undefined, source: value ? 'user' : 'default'};
  }

  /** Persist an explicitly chosen budget and apply it to subsequent turns of this client. */
  setDefaultTurnBudget(budget: TurnBudget | null): void {
    if (this.sending) throw new FutrynError('POLICY');
    const parsed = budget === null ? undefined : turnBudgetSchema.safeParse(budget);
    if (parsed && !parsed.success) throw new FutrynError('INVALID_INPUT');
    const value = parsed?.success && Object.keys(parsed.data).length ? parsed.data : undefined;
    this.ports.settings.update(settings => {
      settings.agentPreferences ??= {};
      if (value) settings.agentPreferences.turnBudget = value;
      else delete settings.agentPreferences.turnBudget;
    });
    this.turnBudgetValue = value;
    this.notifyStateChange();
  }

  /** Source of an effective appearance field; workspace overrides outrank user preferences. */
  appearanceSource(key: keyof AppearanceConfig): 'default' | 'user' | 'workspace' {
    const state = this.ports.settings.read();
    if (state.projectAppearances?.[this.ports.workspace]?.[key] !== undefined) return 'workspace';
    return state.appearance ? 'user' : 'default';
  }

  private clearSessionAuthorization(): void {
    this.permissionModeValue = this.initialPermissionMode();
    this.sandboxModeValue = this.initialSandboxMode();
    this.sessionGrants.clear();
    this.ports.toolGrants?.clear();
    this.denyPendingPermissions();
  }

  /** A policy change makes every unresolved authorization prompt stale, never an approval. */
  private denyPendingPermissions(): void {
    for (const request of this.permissions.values()) {
      if (request.status === 'pending') {
        request.status = 'denied';
        // Wake any tool call waiting on this prompt; a cleared session never grants.
        const waiter = this.permissionWaiters.get(request.approvalId);
        this.permissionWaiters.delete(request.approvalId);
        waiter?.({
          approvalId: request.approvalId,
          scopeHash: request.scopeHash,
          decision: 'deny',
          resolvedAt: new Date().toISOString(),
        });
      }
    }
  }

  /** Allow or withhold workspace tools for this client (the TUI enables them after folder consent). */
  setToolsEnabled(enabled: boolean): void {
    this.toolsAllowed = enabled;
    this.notifyStateChange();
  }

  toolsEnabled(): boolean {
    return this.toolsAllowed;
  }

  /** Files the user allowed tools to read for the rest of this session. */
  listToolGrants(): string[] {
    return this.ports.toolGrants?.list() ?? [];
  }

  /** Revoke every session tool grant; the next read asks again. */
  revokeToolGrants(): void {
    // Both stores: the dispatcher's grants and the prompt cache that answers 'session' without
    // asking. Clearing only the first let a revoked file or command be re-granted silently.
    this.ports.toolGrants?.clear();
    this.sessionGrants.clear();
    this.notifyStateChange();
  }

  /** Last authorized instruction snapshot metadata; instruction contents are not exposed here. */
  projectContext(): ProjectContextReport | null {
    return this.ports.getProjectContext?.() ?? null;
  }

  workspace(): string {
    return this.ports.workspace;
  }

  mode(): AgentMode {
    return this.currentMode;
  }

  setMode(mode: AgentMode): AgentMode {
    if (!['chat', 'plan', 'review'].includes(mode)) throw new FutrynError('INVALID_INPUT');
    if (this.sending) throw new FutrynError('POLICY');
    if (this.currentSession) this.rememberSessionMode(this.currentSession.id, mode);
    this.currentMode = mode;
    this.notifyStateChange();
    return this.currentMode;
  }

  /** Modes restrict behavior; unlike session grants, they are safe to restore with a session. */
  private rememberSessionMode(sessionId: string, mode: AgentMode): void {
    this.ports.settings.update(settings => {
      settings.sessionModes ??= {};
      settings.sessionModes[sessionId] = mode;
    });
  }

  permissionMode(): PermissionMode {
    return this.permissionModeValue;
  }
  /** The user's work budget for each turn, or undefined when no limit is set. */
  turnBudget(): TurnBudget | undefined {
    return this.turnBudgetValue ? {...this.turnBudgetValue} : undefined;
  }
  setTurnBudget(budget: TurnBudget | null): TurnBudget | undefined {
    if (budget === null) this.turnBudgetValue = undefined;
    else {
      const parsed = turnBudgetSchema.safeParse(budget);
      if (!parsed.success) throw new FutrynError('INVALID_INPUT');
      this.turnBudgetValue = Object.keys(parsed.data).length ? parsed.data : undefined;
    }
    this.notifyStateChange();
    return this.turnBudget();
  }
  setPermissionMode(mode: PermissionMode): PermissionMode {
    if (!PERMISSION_MODES.includes(mode)) throw new FutrynError('INVALID_INPUT');
    this.permissionModeValue = mode;
    this.notifyStateChange();
    return mode;
  }

  /** The session sandbox (ADR 0055): the preset's sandbox, or the configured one at session start. */
  sandboxMode(): SandboxModeSetting {
    return this.sandboxModeValue;
  }
  setSandboxMode(mode: SandboxModeSetting): SandboxModeSetting {
    if (!SANDBOX_MODES.includes(mode)) throw new FutrynError('INVALID_INPUT');
    if (mode !== this.sandboxModeValue) {
      // Session grants were answered under the old sandbox; none may outlive a mode change.
      this.denyPendingPermissions();
      this.revokeToolGrants();
    }
    this.sandboxModeValue = mode;
    this.notifyStateChange();
    return mode;
  }
  /**
   * What the command dispatcher reads for every call: the session sandbox, whether escalating is
   * still possible (`never` refuses it), and whether the user's config gives sandboxed commands
   * network. Reading it here makes a preset change take effect on the next call (ADR 0055).
   */
  sandboxConfig(): {mode: SandboxModeSetting; escalation: 'on-request' | 'never'; network: boolean} {
    return {
      mode: this.sandboxModeValue,
      escalation: APPROVAL_POLICY_FOR_MODE[this.permissionModeValue] === 'never' ? 'never' : 'on-request',
      network: this.ports.sandboxNetwork === true,
    };
  }
  /** Read Only / Auto / Full Access (Codex approval presets), or `custom` for any other pair. */
  permissionPreset(): PermissionPresetId | 'custom' {
    return permissionPresetFor(this.sandboxModeValue, this.permissionModeValue);
  }
  /** Apply a Codex preset: its sandbox and approval policy together. Never persisted; a new session resets it. */
  setPermissionPreset(id: PermissionPresetId): PermissionPreset {
    const preset = PERMISSION_PRESETS.find(entry => entry.id === id);
    if (!preset) throw new FutrynError('INVALID_INPUT');
    this.sandboxModeValue = preset.sandbox;
    this.permissionModeValue = preset.mode;
    // A stricter preset leaves no stale prompt answerable, and no session grant (an unsandboxed
    // escalation or network approved for the session) usable, under the looser one.
    this.denyPendingPermissions();
    this.revokeToolGrants();
    this.notifyStateChange();
    return preset;
  }
  /** Rules saved for this workspace (ADR 0028). */
  permissionRules(): PermissionRuleSet {
    const saved = this.ports.settings.read().projectPermissionRules?.[this.ports.workspace];
    return {allow: [...(saved?.allow ?? [])], ask: [...(saved?.ask ?? [])], deny: [...(saved?.deny ?? [])]};
  }
  addPermissionRule(effect: PermissionRuleEffect, rule: string): PermissionRuleSet {
    const parsed = permissionRuleSchema.safeParse(rule.trim());
    if (!parsed.success) throw new FutrynError('INVALID_INPUT');
    this.ports.settings.update(settings => {
      const all = (settings.projectPermissionRules ??= {});
      const set = (all[this.ports.workspace] ??= {allow: [], ask: [], deny: []});
      // One rule lives in one list; adding it elsewhere moves it.
      for (const key of ['allow', 'ask', 'deny'] as const) set[key] = set[key].filter(entry => entry !== parsed.data);
      if (set[effect].length >= 200) throw new FutrynError('POLICY');
      set[effect].push(parsed.data);
    });
    // Tightening policy invalidates old prompts and session grants. Adding Allow is a relaxation
    // (including the `always` prompt answer), so active prompts and session grants stay intact.
    if (effect !== 'allow') {
      this.denyPendingPermissions();
      this.revokeToolGrants();
    }
    return this.permissionRules();
  }
  removePermissionRule(effect: PermissionRuleEffect, rule: string): PermissionRuleSet {
    this.ports.settings.update(settings => {
      const set = settings.projectPermissionRules?.[this.ports.workspace];
      if (set) set[effect] = set[effect].filter(entry => entry !== rule);
    });
    if (effect === 'allow') this.denyPendingPermissions();
    this.revokeToolGrants();
    return this.permissionRules();
  }

  /** Rule paths are workspace-relative; runtimes may report absolute ones. */
  private workspaceRelative(target: string): string {
    const root = this.ports.workspace.replace(/\/+$/, '');
    return target
      .split(', ')
      .map(path => (path.startsWith(root + '/') ? path.slice(root.length + 1) : path))
      .join(', ');
  }

  /** Shift+Tab: Read Only → Auto → Full Access → Read Only. A custom pair starts the cycle at Auto. */
  cyclePermissionPreset(): PermissionPreset {
    const current = this.permissionPreset();
    const order = PERMISSION_PRESETS.map(preset => preset.id);
    const next = current === 'custom' ? 'auto' : order[(order.indexOf(current) + 1) % order.length]!;
    return this.setPermissionPreset(next);
  }

  cycleMode(): AgentMode {
    const order: AgentMode[] = ['chat', 'plan', 'review'];
    const idx = order.indexOf(this.currentMode);
    return this.setMode(order[(idx + 1) % order.length]!);
  }

  /** Futryn tools offered right now; exec_command appears only when its OS containment is proven. */
  /**
   * Run a user-typed `!command` through the workspace exec_command tool. There is no second shell
   * path: without folder consent, a backend or an available sandbox, nothing runs.
   */
  async runShellCommand(
    command: string,
    options: {signal?: AbortSignal; onOutput?: (chunk: CommandOutputChunk) => void; callId?: string} = {},
  ): Promise<ToolResult> {
    if (this.currentMode !== 'chat' || this.sending) throw new FutrynError('POLICY');
    if (!this.toolsAllowed || !this.ports.runShellCommand) throw new FutrynError('UNSUPPORTED');
    if (!command.trim()) throw new FutrynError('INVALID_INPUT');
    if (!this.currentSession) {
      const session = this.ports.startSession();
      this.rememberSessionMode(session.id, this.currentMode);
      this.currentSession = session;
    }
    const session = this.currentSession;
    this.sending = true;
    try {
      return await this.ports.runShellCommand(command, options.signal, options.onOutput, {
        sessionId: session.id,
        callId: options.callId ?? `shell-${crypto.randomUUID()}`,
      });
    } finally {
      this.sending = false;
      const stored = this.ports.getSession(session.id);
      if (stored) session.messages = committedSessionMessages(stored);
      this.notifyStateChange();
    }
  }
  /**
   * Futryn tools the selected backend really offers the model: none unless folder consent holds, the
   * backend runs Futryn tools (Futryn agent or Codex bridge) and the model supports tools.
   */
  availableTools(): string[] {
    if (!this.toolsReachModel()) return [];
    try {
      return this.ports.availableTools?.() ?? [];
    } catch {
      return [];
    }
  }

  /** Same condition the status reports: consent + a backend that runs Futryn tools + a tools-capable model. */
  private toolsReachModel(): boolean {
    try {
      return this.status().toolsEnabled;
    } catch {
      return false;
    }
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
    if (kind !== 'streaming' && kind !== 'reasoning' && kind !== 'tool') this.statusUsage = null;
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

  /**
   * A notification for observers that does not change the activity state shown by the UI
   * (`latestEvent` keeps the running kind): plan and question events (ADR 0042).
   */
  private notify(kind: ReactiveAgentEventKind, detail?: string): void {
    const event: ReactiveAgentEvent = {
      seq: ++this.eventSeq,
      kind,
      detail: detail ? this.ports.sanitizeText(detail) : undefined,
      timestamp: Date.now(),
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Ignore observer errors
      }
    }
    this.notifyStateChange();
  }

  /** The active session's plan (`update_plan`, ADR 0042), or null. */
  plan(): PlanState | null {
    const id = this.currentSession?.id;
    return id ? (this.ports.getPlan?.(id) ?? null) : null;
  }

  // ---- request_user_input (ADR 0042) -------------------------------------------------------
  private readonly questions = new Map<
    string,
    {request: PendingQuestion; settle: (outcome: UserInputOutcome) => void}
  >();
  private userInputAvailable = false;

  /** An interactive UI is attached and can answer questions (the TUI sets it; `exec` never does). */
  setUserInputAvailable(available: boolean): void {
    this.userInputAvailable = available;
    if (!available) for (const id of [...this.questions.keys()]) this.settleQuestion(id, {kind: 'dismissed'});
  }

  /** True while an interactive UI can answer questions. */
  userInputReady(): boolean {
    return this.userInputAvailable;
  }

  listPendingQuestions(): PendingQuestion[] {
    return [...this.questions.values()].map(entry => structuredClone(entry.request));
  }

  /**
   * Ask the user and wait. Without a UI it resolves `unavailable` at once; an aborted turn removes
   * the question and rejects with CANCELLED. Answers are text for the model and never grant anything.
   */
  askUser(questions: UserQuestion[], signal?: AbortSignal): Promise<UserInputOutcome> {
    if (!this.userInputAvailable)
      return Promise.resolve({kind: 'unavailable', reason: 'no interactive user is attached (non-interactive run)'});
    if (signal?.aborted) return Promise.reject(new FutrynError('CANCELLED'));
    const questionId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.questions.delete(questionId);
        this.notifyStateChange();
        reject(new FutrynError('CANCELLED'));
      };
      signal?.addEventListener('abort', onAbort, {once: true});
      this.questions.set(questionId, {
        request: {
          questionId,
          questions: questions.map(question => ({
            ...question,
            header: this.ports.sanitizeText(question.header),
            question: this.ports.sanitizeText(question.question),
            options: question.options.map(option => ({
              label: this.ports.sanitizeText(option.label),
              description: this.ports.sanitizeText(option.description),
            })),
          })),
          createdAt: new Date().toISOString(),
        },
        settle: outcome => {
          signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
      });
      this.notify('question.asked', questions.map(q => q.header).join(', '));
      const request = this.questions.get(questionId)?.request;
      if (request) this.emitInteraction({type: 'question.asked', request});
    });
  }

  /** Answer by question id; every question needs at least one answer (a label or free text). */
  answerQuestion(questionId: string, answers: UserAnswers): void {
    const entry = this.questions.get(questionId);
    if (!entry) throw new FutrynError('NOT_FOUND');
    const clean: UserAnswers = {};
    for (const question of entry.request.questions) {
      const given = answers[question.id]?.answers
        ?.map(answer =>
          String(answer)
            .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
            .trim()
            .slice(0, 2000),
        )
        .filter(Boolean);
      if (!given?.length || (!question.multiple && given.length > 1)) throw new FutrynError('INVALID_INPUT');
      clean[question.id] = {answers: given};
    }
    this.settleQuestion(questionId, {kind: 'answered', answers: clean});
  }

  /** Closing the dialog is an answer too (OpenCode): the model continues without one. */
  dismissQuestion(questionId: string): void {
    if (!this.questions.has(questionId)) throw new FutrynError('NOT_FOUND');
    this.settleQuestion(questionId, {kind: 'dismissed'});
  }

  private settleQuestion(questionId: string, outcome: UserInputOutcome): void {
    const entry = this.questions.get(questionId);
    if (!entry) return;
    this.questions.delete(questionId);
    entry.settle(outcome);
    this.notify('question.answered', outcome.kind);
  }

  /** Called by the composition root after `update_plan` stored a new plan. */
  planUpdated(): void {
    this.notify('plan.updated');
  }

  private notifyStateChange(): void {
    this.statusUsage = null;
    this.guardElevation();
    this.emitReactiveEvent(this.sending ? this.latestEvent.kind : 'idle');
  }

  /** Account the elevated state (mode, session grants) was granted under (ADR 0029). */
  private elevatedFor: string | null | undefined;
  private guarding = false;
  private currentAccountId(): string | null {
    try {
      return (this.currentSession?.selection ?? this.ports.resolveSelection(undefined))?.accountId ?? null;
    } catch {
      return null;
    }
  }
  /** Switching account or provider drops elevated state: it never carries over to another backend. */
  private guardElevation(): void {
    if (this.guarding) return;
    const account = this.currentAccountId();
    const elevated =
      this.permissionModeValue !== this.initialPermissionMode() ||
      this.sandboxModeValue !== this.initialSandboxMode() ||
      this.listToolGrants().length > 0 ||
      this.sessionGrants.size > 0;
    if (!elevated) {
      this.elevatedFor = undefined;
      return;
    }
    if (this.elevatedFor === undefined) {
      this.elevatedFor = account;
      return;
    }
    if (this.elevatedFor === account) return;
    this.guarding = true;
    try {
      this.permissionModeValue = this.initialPermissionMode();
      this.sandboxModeValue = this.initialSandboxMode();
      this.ports.toolGrants?.clear();
      this.sessionGrants.clear();
      this.elevatedFor = undefined;
      this.emitReactiveEvent('done', 'Provider changed: permission mode reset to default, session grants revoked.');
    } finally {
      this.guarding = false;
    }
  }

  currentReactiveEvent(): ReactiveAgentEvent {
    return this.latestEvent;
  }

  onReactiveEvent(listener: (event: ReactiveAgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Subscribe before sending. Permission callbacks may resolve immediately; observers grant nothing. */
  onInteractionEvent(listener: (event: InteractionEvent) => void): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  private emitInteraction(event: InteractionEvent): void {
    for (const listener of this.interactionListeners) {
      try {
        listener(structuredClone(event));
      } catch {
        // Observer failure must not change authorization or interrupt other observers.
      }
    }
  }

  private effectiveTerminalRuntime(): TerminalRuntimeReport {
    const unavailable: TerminalRuntimeReport = {
      label: 'Unavailable',
      available: false,
      sandbox: 'unavailable',
      escalation: 'never',
      limitations: [],
    };
    if (!this.toolsAllowed) return {...unavailable, label: 'Disabled', reason: 'Folder consent required.'};
    try {
      return this.ports.terminalRuntime?.() ?? {...unavailable, reason: 'Runtime details unavailable.'};
    } catch {
      return {...unavailable, reason: 'Runtime inspection failed; execution remains unavailable.'};
    }
  }

  status(projectScoped = false) {
    const project = projectScoped ? this.ports.workspace : undefined;
    const state = this.ports.settings.read();
    const selection = this.currentSession?.selection ?? this.ports.resolveSelection(project);
    const activeAccount = selection
      ? (state.accounts.find(a => a.id === selection.accountId) ?? null)
      : state.activeAccountId
        ? (state.accounts.find(a => a.id === state.activeAccountId) ?? null)
        : null;
    const activeProvider = activeAccount
      ? (state.providers.find(p => p.id === activeAccount.providerId) ?? null)
      : null;
    let activeModel: ModelInfo | null = null;
    if (activeAccount && selection) {
      try {
        activeModel = this.ports.cachedModels(activeAccount).find(m => m.id === selection.modelId) ?? null;
      } catch {
        activeModel = null;
      }
    }
    const usage = (this.statusUsage ??= this.usage());
    const executionBackend = activeProvider ? executionBackendFor({toolsEnabled: this.toolsAllowed}) : null;
    const workspaceReadStatus = !this.toolsAllowed
      ? 'disabled'
      : !activeModel || executionBackend?.kind !== 'hannes' || activeModel.capabilities.tools === 'unsupported'
        ? 'unavailable'
        : 'read-only';
    return {
      workspace: this.ports.workspace,
      mode: this.currentMode,
      permissionMode: this.permissionModeValue,
      approvalPolicy: APPROVAL_POLICY_FOR_MODE[this.permissionModeValue],
      /** Session sandbox, preset and whether sandboxed commands get network by configuration (ADR 0055). */
      sandboxMode: this.sandboxModeValue,
      permissionPreset: this.permissionPreset(),
      sandboxNetwork: this.ports.sandboxNetwork === true && this.sandboxModeValue === 'workspace-write',
      executionBackend,
      /** Futryn tools reach the model: folder consent AND a backend that runs them AND a capable model. */
      toolsEnabled: workspaceReadStatus === 'read-only',
      providers: state.providers,
      accounts: state.accounts,
      activeAccount,
      activeProvider,
      selection,
      activeModel,
      workspaceReadStatus,
      activeSessionId: this.currentSession?.id ?? null,
      messageCount: this.currentSession?.messages.length ?? 0,
      lastUsage: usage.last?.usage ?? this.lastUsage,
      usage,
      reasoningEffort: activeAccount && activeModel ? this.effort(activeAccount.id, activeModel) : null,
      phase: this.latestEvent.kind,
      pendingPermissions: this.listPendingPermissions().length,
      terminalRuntime: this.effectiveTerminalRuntime(),
      capabilities: this.capabilities(),
    };
  }

  // Providers, Accounts & Models
  async beginProviderAuth(providerId: string, methodId?: string, signal?: AbortSignal): Promise<ProviderAuthChallenge> {
    if (!this.ports.beginProviderAuth) throw new FutrynError('UNSUPPORTED');
    return this.ports.beginProviderAuth(providerId, methodId, signal);
  }

  async cancelProviderAuth(challengeId: string): Promise<void> {
    await this.ports.cancelProviderAuth?.(challengeId);
  }
  providerAuthProgress(challengeId: string): ProviderAuthProgress {
    if (!this.ports.providerAuthProgress) throw new FutrynError('UNSUPPORTED');
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
    const added = this.ports.addProvider(provider);
    this.notifyStateChange();
    return added;
  }

  /** Null when the host config would accept this custom provider; otherwise the reason (ADR 0046). */
  validateCustomProvider(provider: Provider): string | null {
    return this.ports.validateHostProvider?.(provider) ?? null;
  }

  removeProvider(id: string): void {
    this.ports.removeProvider(id);
    this.notifyStateChange();
  }

  listAccounts(): Account[] {
    return this.ports.listAccounts();
  }

  async connectAccount(input: ConnectAccountInput, signal?: AbortSignal): Promise<Account> {
    if (this.sending) throw new FutrynError('POLICY');
    const existingProvider = this.ports.listProviders().find(p => p.id === input.providerId);
    if (!existingProvider) {
      const preset = this.ports.listProviderPresets().find(p => p.id === input.providerId);
      if (!preset) throw new FutrynError('NOT_FOUND');
      this.ports.addProvider(preset);
    }
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    let account: Account | undefined;
    try {
      let credential = input.credential;
      let secret = input.secret;
      if (input.authChallengeId && this.ports.listProviders().find(p => p.id === input.providerId)?.auth === 'oauth') {
        if (!this.ports.completeOAuthSignIn || input.credential.kind !== 'keyring')
          throw new FutrynError('UNSUPPORTED');
        secret = await this.ports.completeOAuthSignIn(input.providerId, input.authChallengeId, signal);
      } else if (input.authChallengeId) {
        if (!this.ports.completeProviderAuth || !input.authorizationCode || input.credential.kind !== 'keyring')
          throw new FutrynError('UNSUPPORTED');
        secret = await this.ports.completeProviderAuth(
          input.providerId,
          input.authChallengeId,
          input.authorizationCode,
          signal,
        );
      }
      if (
        input.reauthenticateAccountId &&
        this.ports.getAccount(input.reauthenticateAccountId).providerId !== input.providerId
      )
        throw new FutrynError('POLICY');
      account = input.reauthenticateAccountId
        ? await this.ports.reauthenticateAccount(input.reauthenticateAccountId, credential, secret)
        : await this.ports.addAccount(input.providerId, input.alias, credential, secret);
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      if (input.manualModelId) this.ports.addManualModel(account, input.manualModelId);
      if (input.validate !== false) await this.ports.validateAccount(this.ports.getAccount(account.id), signal);
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      const refreshed = this.ports.getAccount(account.id);
      // Reconnecting a switch target must retain the source chat until explicit continuation.
      if (
        input.reauthenticateAccountId &&
        this.currentSession &&
        this.currentSession.selection.accountId !== refreshed.id
      ) {
        this.notifyStateChange();
        return refreshed;
      }
      this.ports.useAccount(refreshed.id);
      const models = this.ports.cachedModels(refreshed);
      const chosen = models.find(m => m.id === (input.manualModelId ?? refreshed.defaultModel)) ?? models[0];
      if (chosen) this.ports.selectModel(refreshed, chosen);
      this.clearSessionAuthorization();
      this.currentSession = null;
      this.lastUsage = null;
      this.notifyStateChange();
      return this.ports.getAccount(refreshed.id);
    } catch (error) {
      // A failed or cancelled login cannot leave a usable credential behind.
      // Failed cleanup is surfaced so the account remains retryable via /logout.
      if (account) await this.ports.logoutAccount(account.id, !input.reauthenticateAccountId);
      if (account && this.currentSession?.selection.accountId === account.id) {
        this.clearSessionAuthorization();
        this.currentSession = null;
        this.lastUsage = null;
      }
      this.notifyStateChange();
      throw error;
    }
  }

  async diagnose(signal?: AbortSignal, generate = false): Promise<string> {
    const status = this.status();
    const account = status.activeAccount;
    let configProblems = '';
    try {
      const problems = this.ports.hostConfigDiagnostics?.() ?? [];
      if (problems.length) configProblems = `\nHost config problems (~/.futryn/config.toml): ${problems.join('; ')}`;
    } catch {
      /* diagnostics must never break /doctor */
    }
    if (!account) return `No active account. Use /login. Runtime and private settings loaded.${configProblems}`;
    const target =
      generate && status.selection?.accountId === account.id
        ? {...account, defaultModel: status.selection.modelId}
        : account;
    const result = await this.ports.validateAccount(target, signal, generate);
    this.notifyStateChange();
    return `Connected: ${account.alias}; ${result.models} models; validated via ${result.validation}. Runtime and private settings loaded.${configProblems}`;
  }

  useAccount(idOrAlias: string): Account {
    const target = this.ports.getAccount(idOrAlias);
    if (target.status === 'logged-out') throw new FutrynError('AUTH');
    if (this.status().activeAccount?.id === target.id) return target;
    if (this.sending) throw new FutrynError('POLICY');
    const account = this.ports.useAccount(idOrAlias);
    this.clearSessionAuthorization();
    this.currentSession = null;
    this.lastUsage = null;
    this.notifyStateChange();
    return account;
  }

  renameAccount(idOrAlias: string, newAlias: string): Account {
    const renamed = this.ports.renameAccount(idOrAlias, newAlias);
    this.notifyStateChange();
    return renamed;
  }

  async logoutAccount(idOrAlias: string, remove = true): Promise<void> {
    const target = this.ports.getAccount(idOrAlias);
    if (this.currentSession?.selection.accountId === target.id) {
      this.clearSessionAuthorization();
      this.currentSession = null;
      this.lastUsage = null;
    }
    try {
      await this.ports.logoutAccount(target.id, remove);
    } finally {
      this.notifyStateChange();
    }
  }

  async discoverModels(options?: {
    accountId?: string;
    offline?: boolean;
    query?: string;
    capability?: keyof ModelInfo['capabilities'];
    signal?: AbortSignal;
  }) {
    const state = this.ports.settings.read();
    const accountId = options?.accountId ?? state.activeAccountId;
    if (!accountId) throw new FutrynError('AUTH');
    const account = this.ports.getAccount(accountId);
    const base = options?.offline
      ? {models: this.ports.cachedModels(account), stale: true, warning: 'Offline cache; availability unverified.'}
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
    return {...base, models, account};
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
    if (!targetId) throw new FutrynError('AUTH');
    const account = this.ports.getAccount(targetId);
    const model = this.ports.addManualModel(account, modelId);
    this.notifyStateChange();
    return model;
  }

  selectModel(modelId: string, options?: {accountId?: string; projectScoped?: boolean}): Selection {
    const state = this.ports.settings.read();
    const targetId = options?.accountId ?? state.activeAccountId;
    if (!targetId) throw new FutrynError('AUTH');
    const account = this.ports.getAccount(targetId);
    const models = this.ports.cachedModels(account);
    const model = models.find(m => m.id === modelId);
    if (!model) throw new FutrynError('NOT_FOUND');
    const previousSelection = this.currentSession?.selection;
    if (this.sending) throw new FutrynError('POLICY');
    const selection = this.ports.selectModel(account, model, options?.projectScoped ? this.ports.workspace : undefined);
    // Conversation adapters and durable selections are pinned. Starting fresh
    // avoids advertising one model while the backend still invokes another.
    if (
      previousSelection &&
      (previousSelection.accountId !== selection.accountId || previousSelection.modelId !== selection.modelId)
    ) {
      this.clearSessionAuthorization();
      this.currentSession = null;
      this.lastUsage = null;
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

  createSession(projectScoped = false): {id: string; selection: Selection; messages: Message[]} {
    if (this.sending) throw new FutrynError('POLICY');
    const session = this.ports.startSession(projectScoped ? this.ports.workspace : undefined);
    this.rememberSessionMode(session.id, this.currentMode);
    this.clearSessionAuthorization();
    this.currentSession = session;
    this.lastUsage = null;
    this.notifyStateChange();
    return {
      id: this.currentSession.id,
      selection: {...this.currentSession.selection},
      messages: [...this.currentSession.messages],
    };
  }

  resumeSession(id: string): {id: string; selection: Selection; messages: Message[]} {
    if (this.sending) throw new FutrynError('POLICY');
    const mode = this.ports.settings.read().sessionModes?.[id] ?? 'chat';
    const stored = this.ports.getSession(id);
    const session = this.ports.resumeSession(id);
    if (this.currentSession) this.claimedNextTurn.delete(this.currentSession.id);
    this.clearSessionAuthorization();
    this.currentSession = session;
    this.currentMode = mode;
    this.lastUsage = stored?.turns?.at(-1)?.usage ?? null;
    this.notifyStateChange();
    return {
      id: this.currentSession.id,
      selection: {...this.currentSession.selection},
      messages: [...this.currentSession.messages],
    };
  }

  /** Copy committed conversation history; the persistence port never replays tools or grants. */
  forkSession(id = this.currentSession?.id): {id: string; selection: Selection; messages: Message[]} {
    if (this.sending) throw new FutrynError('POLICY');
    if (!this.ports.forkSession) throw new FutrynError('UNSUPPORTED');
    if (!id) throw new FutrynError('NOT_FOUND');
    const source = this.ports.getSession(id);
    if (!source) throw new FutrynError('NOT_FOUND');
    // Validate/create the copy first, so an invalid target leaves the active conversation intact.
    const mode =
      id === this.currentSession?.id ? this.currentMode : (this.ports.settings.read().sessionModes?.[id] ?? 'chat');
    const fork = this.ports.forkSession(id, source.selection);
    this.rememberSessionMode(fork.id, mode);
    this.clearSessionAuthorization();
    this.currentSession = fork;
    this.currentMode = mode;
    this.lastUsage = null;
    this.notifyStateChange();
    return {id: fork.id, selection: {...fork.selection}, messages: fork.messages.map(message => ({...message}))};
  }

  deleteSession(id: string): boolean {
    if (this.currentSession?.id === id && this.sending) throw new FutrynError('POLICY');
    const deleted = this.ports.deleteSession(id);
    if (!deleted) return false;
    this.claimedNextTurn.delete(id);
    if (this.currentSession?.id === id) {
      this.clearSessionAuthorization();
      this.currentSession = null;
      this.lastUsage = null;
    }
    try {
      this.ports.settings.update(settings => {
        delete settings.sessionModes?.[id];
      });
    } finally {
      this.notifyStateChange();
    }
    return true;
  }

  clearSessionView(): void {
    if (this.sending) throw new FutrynError('POLICY');
    if (this.currentSession) this.claimedNextTurn.delete(this.currentSession.id);
    this.clearSessionAuthorization();
    this.currentSession = null;
    this.lastUsage = null;
    this.notifyStateChange();
  }

  activeSession(): {id: string; selection: Selection; messages: Message[]} | null {
    if (!this.currentSession) return null;
    return {
      id: this.currentSession.id,
      selection: {...this.currentSession.selection},
      messages: this.currentSession.messages.map(m => ({...m})),
    };
  }

  async *sendMessage(
    content: string,
    options?: {signal?: AbortSignal; maxOutputTokens?: number; maxEstimatedCostUSD?: number; projectScoped?: boolean},
  ): AsyncIterable<ModelEvent> {
    const trimmed = content.trim();
    if (!trimmed) throw new FutrynError('INVALID_INPUT');
    if (this.sending) throw new FutrynError('POLICY');
    if (!this.currentSession) {
      const session = this.ports.startSession(options?.projectScoped ? this.ports.workspace : undefined);
      this.rememberSessionMode(session.id, this.currentMode);
      this.currentSession = session;
    }
    const session = this.currentSession;
    const claimed = this.claimedNextTurn.get(session.id);
    const queuedInputId = claimed?.content === trimmed ? claimed.id : undefined;
    this.sending = true;
    this.streamingText = '';
    this.streamingSteps = [];
    this.lastUsage = null;
    this.activeTurnId = undefined;
    this.emitReactiveEvent('thinking', 'Preparing request');
    let assistantText = '';
    let responseStart = 0;
    try {
      for await (const event of this.ports.sendTurn(
        session.id,
        trimmed,
        options?.signal,
        options?.maxOutputTokens,
        options?.maxEstimatedCostUSD,
        this.status().reasoningEffort ?? undefined,
        queuedInputId,
      )) {
        switch (event.type) {
          case 'started':
            this.activeTurnId ??= event.requestId;
            responseStart = assistantText.length;
            this.emitReactiveEvent('waiting', 'Waiting for provider');
            break;
          case 'textDelta':
            assistantText += event.text;
            this.streamingText = assistantText;
            this.emitReactiveEvent('streaming');
            break;
          case 'reasoningDelta':
            this.emitReactiveEvent('reasoning', 'Provider thinking');
            break;
          case 'context':
            this.rememberObservedContext(session.selection, event.context);
            this.notifyStateChange();
            break;
          case 'usage':
            this.lastUsage = event.usage;
            this.notifyStateChange();
            break;
          case 'toolCallComplete':
            this.streamingSteps.push({role: 'assistant', content: '', toolCalls: [event.call]});
            this.emitReactiveEvent('tool', event.call.name);
            break;
          case 'toolResult':
            this.streamingSteps.push({
              role: 'tool',
              content: event.result.content,
              toolCallId: event.result.callId,
              toolName: event.result.name,
            });
            this.notifyStateChange();
            break;
          case 'responseDiscarded':
            // Provisional text of a retried or preempted response is void (ADR 0033).
            assistantText = assistantText.slice(0, responseStart);
            this.streamingText = assistantText;
            this.notifyStateChange();
            break;
          case 'inputDeferred':
            this.emitReactiveEvent(
              'thinking',
              `${event.steerIds.length} accepted instruction(s) deferred to the next turn (${event.reason})`,
            );
            break;
          case 'steered':
            // The steering message became model-visible here; text before it belongs to the earlier response.
            if (assistantText) this.streamingSteps.push({role: 'assistant', content: assistantText});
            this.streamingSteps.push({role: 'user', content: event.content});
            assistantText = '';
            this.streamingText = '';
            this.notifyStateChange();
            break;
          case 'completed': {
            this.lastUsage = event.usage;
            this.streamingText = '';
            this.streamingSteps = [];
            const stored = this.ports.getSession(session.id);
            if (stored) session.messages = committedSessionMessages(stored);
            else session.messages.push({role: 'user', content: trimmed}, {role: 'assistant', content: assistantText});
            this.emitReactiveEvent('done', event.finishReason);
            break;
          }
        }
        yield event;
      }
    } catch (err) {
      const stored = this.ports.getSession(session.id);
      if (stored?.recovery) session.messages = stored.recovery.messages;
      this.emitReactiveEvent('error', err instanceof FutrynError ? err.code : 'ERROR');
      throw err;
    } finally {
      // Reservations are transient; the inbox row is acknowledged atomically by the backend.
      // If acceptance failed, the durable row remains available for a later explicit retry.
      this.claimedNextTurn.delete(session.id);
      this.sending = false;
      this.statusUsage = null;
      this.activeTurnId = undefined;
      this.streamingText = '';
      this.streamingSteps = [];
    }
  }

  /** Remember a context window the runtime actually reported, for this exact account and model only. */
  private rememberObservedContext(
    selection: Selection,
    context: Extract<ModelEvent, {type: 'context'}>['context'],
  ): void {
    if (context.source === 'estimate' || context.limitTokens == null) return;
    this.ports.settings.update(settings => {
      const signedIn = settings.accounts.some(a => a.id === selection.accountId && a.status !== 'logged-out');
      if (!signedIn) return;
      const model = settings.catalogs
        .find(cache => cache.accountId === selection.accountId)
        ?.models.find(m => m.id === selection.modelId);
      // Never override a limit the provider's catalog reported; only refresh earlier observations.
      if (model && (model.contextLimit == null || model.metadataSource?.endsWith(':observed-context'))) {
        model.contextLimit = context.limitTokens;
        model.metadataSource = `${context.source}:observed-context`;
        model.metadataFetchedAt = context.measuredAt;
      }
    });
  }

  /**
   * Codex-style steering (ADR 0033): add an instruction to the turn that is running now instead of
   * starting an unrelated one. Accepted input is journaled before this returns and reaches the model
   * before its next request. It is plain user text: it never changes mode, grants or approvals.
   * `no_active_turn` means the turn already finished (or is finishing); send it as a new message.
   */
  /**
   * Input typed while the agent is busy (Codex `start_or_steer`): join the running turn when it still
   * accepts steering; when it is finishing, keep the message in order for the next turn instead of
   * losing it. Callers send queued messages with `takeQueuedMessage` once the turn has ended.
   */
  submitWhileBusy(
    content: string,
  ):
    | {disposition: 'steered'; steerId: string}
    | {disposition: 'queued'; position: number}
    | {disposition: 'rejected'; reason: 'not_steerable' | 'empty_input' | 'idle' | 'queue_unavailable'} {
    const trimmed = content.trim();
    if (!trimmed) return {disposition: 'rejected', reason: 'empty_input'};
    if (!this.sending || !this.currentSession) return {disposition: 'rejected', reason: 'idle'};
    const outcome = this.steerMessage(trimmed);
    if (outcome.accepted) return {disposition: 'steered', steerId: outcome.steerId};
    if (outcome.reason === 'no_active_turn' || outcome.reason === 'turn_mismatch') {
      if (!this.ports.enqueueNextTurn || !this.ports.listNextTurn)
        return {disposition: 'rejected', reason: 'queue_unavailable'};
      this.ports.enqueueNextTurn(this.currentSession.id, trimmed);
      this.notifyStateChange();
      return {disposition: 'queued', position: this.queuedMessages().length};
    }
    return {disposition: 'rejected', reason: outcome.reason};
  }
  /** Reserve the next message for this session; deletion happens only with durable user acceptance. */
  takeQueuedMessage(): string | undefined {
    const id = this.currentSession?.id;
    if (this.sending || !id || this.claimedNextTurn.has(id)) return undefined;
    const next = this.ports.listNextTurn?.(id)[0];
    if (!next) return undefined;
    this.claimedNextTurn.set(id, next);
    this.notifyStateChange();
    return next.content;
  }
  queuedMessages(): readonly string[] {
    return this.currentSession
      ? (this.ports.listNextTurn?.(this.currentSession.id) ?? []).map(input => input.content)
      : [];
  }
  /** Accepted instructions the last turn could not process; the next sent message delivers them first. */
  queuedInput(): readonly {steerId: string; content: string}[] {
    return this.currentSession ? (this.ports.queuedInput?.(this.currentSession.id) ?? []) : [];
  }

  steerMessage(content: string): SteerOutcome {
    const trimmed = content.trim();
    if (!trimmed) return {accepted: false, reason: 'empty_input'};
    if (!this.sending || !this.currentSession) return {accepted: false, reason: 'no_active_turn'};
    // Codex steer_input refuses Review tasks; Futryn's review mode is the same non-steerable kind.
    if (this.mode() === 'review' || !this.ports.steerTurn) return {accepted: false, reason: 'not_steerable'};
    const outcome = this.ports.steerTurn(this.currentSession.id, trimmed, this.activeTurnId);
    this.emitReactiveEvent(
      'thinking',
      outcome.accepted ? 'Steering queued for the next model request' : `Steering not accepted: ${outcome.reason}`,
    );
    return outcome;
  }

  /**
   * `/compact [instructions]` (ADR 0054): replace older model-visible history by a model-written
   * handoff summary plus recent user messages. Idle only: a running turn owns its context, so this
   * throws `POLICY` while a turn runs. The model call is billed and counted in session usage; a failed
   * summary falls back to the extractive checkpoint; cancellation changes nothing. Durable history is
   * never modified.
   */
  async compact(instructions?: string, options?: {signal?: AbortSignal}): Promise<CompactionOutcome> {
    if (this.sending) throw new FutrynError('POLICY');
    if (!this.ports.compactSession) throw new FutrynError('UNSUPPORTED');
    const session = this.currentSession;
    if (!session) return {compacted: false, tokensBefore: 0, tokensAfter: 0, usage: null, reason: 'empty'};
    this.sending = true; // blocks sendMessage and session changes while the checkpoint is written
    this.emitReactiveEvent('thinking', 'Compacting context');
    try {
      const outcome = await this.ports.compactSession(session.id, instructions?.trim() || undefined, options?.signal);
      if (outcome.usage) this.lastUsage = outcome.usage;
      return outcome;
    } finally {
      this.sending = false;
      this.statusUsage = null;
      this.emitReactiveEvent('idle');
      this.notifyStateChange();
    }
  }

  usage() {
    const record = this.currentSession ? this.ports.getSession(this.currentSession.id) : undefined;
    const turns = record?.turns ?? [];
    const completed = turns.filter(t => t.outcome === 'completed').length;
    // Steering delivered inside a turn is a user message of that turn, not another turn.
    const steered =
      record?.recovery?.turns.reduce(
        (n, turn) => n + turn.events.filter(e => e.data.type === 'user.steered').length,
        0,
      ) ?? 0;
    return summarizeUsage(
      turns,
      Math.max(
        0,
        (record?.messages.filter(m => m.role === 'user' && m.state === 'committed').length ?? 0) - completed - steered,
      ),
    );
  }

  /**
   * Limits for every connected account, from what is already known: the last live fetch or the
   * plan snapshot attached to the latest reply. Sends no request.
   */
  limits(): AccountLimits[] {
    const providers = new Map(this.ports.listProviders().map(p => [p.id, p]));
    const sessions = this.ports.listSessions();
    return this.ports
      .listAccounts()
      .filter(account => account.status !== 'logged-out')
      .map(account => {
        const providerName = providers.get(account.providerId)?.name ?? account.providerId;
        const base = {accountId: account.id, alias: account.alias, providerId: account.providerId, providerName};
        const live = this.liveLimits.get(account.id);
        const checking = this.limitsPending.has(account.id) || undefined;
        if (live && (live.items.length || live.error)) return {...live, checking};
        for (const summary of sessions.filter(s => s.selection.accountId === account.id).slice(0, 20)) {
          const turn = this.ports
            .getSession(summary.id)
            ?.turns?.filter(t => t.accountId === account.id && t.usage?.quota?.length)
            .at(-1);
          const quota = turn?.usage?.quota;
          if (quota?.length)
            return {
              ...base,
              source: 'last-turn' as const,
              observedAt: quota[0]!.observedAt,
              items: quotaItems(quota),
              checking,
            };
        }
        return {
          ...base,
          source: 'unavailable' as const,
          observedAt: live?.observedAt ?? null,
          items: [],
          note: live?.note,
          checking,
        };
      });
  }

  /** Ask providers that have a balance/quota API for fresh numbers. Concurrent calls share one refresh. */
  refreshLimits(signal?: AbortSignal): Promise<void> {
    const fetchLimits = this.ports.fetchAccountLimits;
    if (!fetchLimits) return Promise.resolve();
    this.limitsRefresh ??= (async () => {
      const providers = new Map(this.ports.listProviders().map(p => [p.id, p]));
      await Promise.allSettled(
        this.ports
          .listAccounts()
          .filter(account => account.status !== 'logged-out')
          .map(async account => {
            const base = {
              accountId: account.id,
              alias: account.alias,
              providerId: account.providerId,
              providerName: providers.get(account.providerId)?.name ?? account.providerId,
            };
            const request = fetchLimits(account, signal);
            if (!request) {
              this.liveLimits.delete(account.id);
              return;
            }
            this.limitsPending.add(account.id);
            try {
              const result = await request;
              this.liveLimits.set(account.id, {
                ...base,
                source: 'live',
                observedAt: new Date().toISOString(),
                items: result.items,
                note: result.note,
              });
            } catch (error) {
              this.liveLimits.set(account.id, {
                ...base,
                source: 'live',
                observedAt: new Date().toISOString(),
                items: [],
                error: error instanceof FutrynError ? error.code : 'PROTOCOL',
              });
            } finally {
              this.limitsPending.delete(account.id);
            }
          }),
      );
      this.notifyStateChange();
    })().finally(() => {
      this.limitsRefresh = null;
    });
    return this.limitsRefresh;
  }

  context(draft = '') {
    const status = this.status();
    const history = this.currentSession?.messages ?? [];
    const record = this.currentSession ? this.ports.getSession(this.currentSession.id) : undefined;
    const pending = this.sending ? record?.messages.filter(message => message.state === 'pending').at(-1) : undefined;
    const trimmedDraft = draft.trim();
    const requestDraft = /^[\/!]/.test(trimmedDraft) ? '' : trimmedDraft;
    const components = [
      ...history,
      ...(pending ? [{role: pending.role, content: pending.content}] : []),
      ...(pending ? this.streamingSteps : []),
      ...(pending && this.streamingText ? [{role: 'assistant', content: this.streamingText}] : []),
      ...(requestDraft ? [{role: 'user', content: requestDraft}] : []),
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(components)).length;
    const instructionBytes = this.projectContext()?.usedBytes ?? 0;
    const messageCount = components.length + (instructionBytes ? 1 : 0);
    const estimate = messageCount ? Math.ceil((bytes + instructionBytes) / 4) + messageCount * 16 + 64 : 0;
    const latest = this.usage().last;
    const observation = record?.turns?.findLast(turn => turn.context && turn.context.source !== 'estimate');
    const last = observation?.context ?? null;
    const limit = last?.limitTokens ?? status.activeModel?.contextLimit ?? null;
    const reserve = Math.min(4096, status.activeModel?.outputLimit ?? 4096);
    return {
      estimateTokens: estimate,
      estimateMethod: 'UTF-8 bytes / 4 + message overhead; no exact tokenizer',
      limitTokens: limit,
      outputReserve: reserve,
      outputLimit: status.activeModel?.outputLimit ?? null,
      estimatedPercent: limit ? Math.round((estimate / limit) * 1000) / 10 : null,
      measuredCurrentHistory:
        observation?.requestId === latest?.requestId &&
        !requestDraft.trim() &&
        (!this.sending || latest?.outcome === 'pending') &&
        last?.usedTokens != null &&
        last.limitTokens != null,
      lastMeasured: last,
      metadataSource: status.activeModel?.metadataSource ?? null,
      metadataAt: status.activeModel?.metadataFetchedAt ?? null,
      projectInstructionBytes: instructionBytes,
      messages: messageCount,
    };
  }

  private effort(accountId: string, model: ModelInfo): string | null {
    const stored = this.ports.settings.read().reasoningPreferences?.[accountId + ':' + model.id];
    return stored && model.reasoningEfforts?.includes(stored) ? stored : (model.defaultReasoningEffort ?? null);
  }
  setReasoningEffort(value: string): void {
    if (this.sending) throw new FutrynError('POLICY');
    const status = this.status();
    const model = status.activeModel;
    const account = status.activeAccount;
    if (!model || !account || !model.reasoningEfforts?.length) throw new FutrynError('UNSUPPORTED');
    if (value !== 'default' && !model.reasoningEfforts.includes(value)) throw new FutrynError('INVALID_INPUT');
    this.ports.settings.update(settings => {
      settings.reasoningPreferences ??= {};
      const key = account.id + ':' + model.id;
      if (value === 'default') delete settings.reasoningPreferences[key];
      else settings.reasoningPreferences[key] = value;
    });
    this.notifyStateChange();
  }

  async switchAccount(
    reference: string,
    continueHistory = false,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<Account> {
    if (this.sending) throw new FutrynError('POLICY');
    const accounts = this.listAccounts();
    const target = /^\d+$/.test(reference)
      ? accounts[Number(reference) - 1]
      : accounts.find(a => a.id === reference || a.alias === reference);
    if (!target) throw new FutrynError('NOT_FOUND');
    if (target.status === 'logged-out') throw new FutrynError('AUTH');
    const source = this.currentSession;
    const current = source?.selection ?? this.status().selection;
    if (
      (current?.accountId ?? this.status().activeAccount?.id) === target.id &&
      (!modelId || current?.modelId === modelId)
    )
      return target;
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    const initialActiveId = this.status().activeAccount?.id;
    const initialSelection = JSON.stringify(this.status().selection);
    const catalog = await this.ports.discoverModels(target, signal);
    if (
      this.sending ||
      this.currentSession !== source ||
      this.status().activeAccount?.id !== initialActiveId ||
      JSON.stringify(this.status().selection) !== initialSelection
    )
      throw new FutrynError('POLICY');
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    if (catalog.stale) throw new FutrynError('TRANSPORT');
    const previousId = source?.selection.modelId ?? this.status().selection?.modelId;
    const model = modelId
      ? catalog.models.find(m => m.id === modelId)
      : (catalog.models.find(m => m.id === previousId) ??
        catalog.models.find(m => m.id === target.defaultModel) ??
        (!source ? catalog.models[0] : undefined));
    if (!model) throw new FutrynError('NOT_FOUND');
    const selection = {accountId: target.id, modelId: model.id};
    if (continueHistory && source?.messages.length && !this.ports.forkSession) throw new FutrynError('UNSUPPORTED');
    const fork = continueHistory && source?.messages.length ? this.ports.forkSession!(source.id, selection) : null;
    try {
      if (fork) this.rememberSessionMode(fork.id, this.currentMode);
      this.ports.selectModel(target, model);
    } catch (error) {
      if (fork) {
        this.ports.deleteSession(fork.id);
        this.ports.settings.update(settings => {
          delete settings.sessionModes?.[fork.id];
        });
      }
      throw error;
    }
    this.clearSessionAuthorization();
    this.currentSession = fork;
    this.lastUsage = null;
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
      ...(projectOverride.theme !== undefined ? {theme: projectOverride.theme} : {}),
      ...(projectOverride.mode !== undefined ? {mode: projectOverride.mode} : {}),
      ...(projectOverride.wallpaper !== undefined ? {wallpaper: projectOverride.wallpaper} : {}),
      ...(projectOverride.syntaxHighlighting !== undefined
        ? {syntaxHighlighting: projectOverride.syntaxHighlighting}
        : {}),
      ...(projectOverride.sidebar !== undefined ? {sidebar: projectOverride.sidebar} : {}),
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
          ...(validatedPatch.theme !== undefined ? {theme: validatedPatch.theme} : {}),
          ...(validatedPatch.mode !== undefined ? {mode: validatedPatch.mode} : {}),
          ...(validatedPatch.wallpaper !== undefined ? {wallpaper: validatedPatch.wallpaper} : {}),
          ...(validatedPatch.syntaxHighlighting !== undefined
            ? {syntaxHighlighting: validatedPatch.syntaxHighlighting}
            : {}),
          ...(validatedPatch.sidebar !== undefined ? {sidebar: validatedPatch.sidebar} : {}),
          animations: {
            ...currentGlobal.animations,
            ...(validatedPatch.animations ?? {}),
          },
        });
        // Explicit workspace overrides retain precedence over user defaults.
      } else {
        s.projectAppearances = s.projectAppearances ?? {};
        const prevProj = s.projectAppearances[this.ports.workspace] ?? {};
        s.projectAppearances[this.ports.workspace] = partialAppearanceSchema.parse({
          ...prevProj,
          ...validatedPatch,
          animations: validatedPatch.animations
            ? {...(prevProj.animations ?? {}), ...validatedPatch.animations}
            : prevProj.animations,
        });
      }
    });
    this.notifyStateChange();
    return this.getAppearance(true);
  }

  loadCustomThemes(): {themes: ThemeManifest[]; errors: {file: string; message: string}[]} {
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
    if (!this.toolsAllowed)
      return {
        workspace: this.workspace(),
        gitAvailable: false,
        state: 'denied',
        message: 'Folder consent required.',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };
    return this.ports.getWorkspaceDiff();
  }

  async refreshWorkspaceDiff(): Promise<WorkspaceDiffReport> {
    if (!this.toolsAllowed) return this.getWorkspaceDiff();
    return this.ports.refreshWorkspaceDiff ? this.ports.refreshWorkspaceDiff() : this.ports.getWorkspaceDiff();
  }

  /**
   * Diff files as `/review` may send them to the model. Content of a file the read policy would deny
   * or ask about (secrets, Git internals, Futryn state) is withheld so review never bypasses the
   * permission engine; the model can still request it through the read tool's approval flow.
   * Without a policy port every file's content is withheld.
   */
  reviewEvidence(files: readonly WorkspaceDiffFile[]): (WorkspaceDiffFile & {contentWithheld?: true})[] {
    const allowed = (path: string) => this.ports.readAllowedWithoutApproval?.(path) ?? false;
    return files.map(file =>
      allowed(file.path) && (!file.oldPath || allowed(file.oldPath))
        ? file
        : {...file, lines: [], contentWithheld: true as const},
    );
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
    scopeKey?: string;
    /** Approvals this prompt offers (Codex `available_decisions`); default once + session. */
    decisions?: PermissionPromptRequest['decisions'];
    /** The project Allow rule `always` saves; without it `always` is not offered. */
    alwaysRule?: string;
  }): PermissionPromptRequest {
    const now = new Date();
    const rule =
      input.alwaysRule && permissionRuleSchema.safeParse(input.alwaysRule).success ? input.alwaysRule : undefined;
    const offered = (input.decisions ?? ['once', 'session']).filter(decision => decision !== 'always' || rule);
    const expires = new Date(now.getTime() + (input.ttlMs ?? 300_000));
    const scopeHash = createHash('sha256')
      .update(
        JSON.stringify([input.capability, input.action, input.target, ...(input.scopeKey ? [input.scopeKey] : [])]),
      )
      .digest('hex');
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
      decisions: offered.length ? offered : ['once'],
      ...(rule && offered.includes('always') ? {alwaysRule: this.ports.sanitizeText(rule)} : {}),
      status: this.sessionGrants.has(scopeHash) && offered.includes('session') ? 'approved_session' : 'pending',
    });
    this.permissions.set(req.approvalId, req);
    if (req.status === 'pending') {
      // Defer notification until requestPermission has installed its waiter. A subscriber may
      // synchronously resolve the request (headless consumers have no polling timer).
      queueMicrotask(() => {
        if (req.status !== 'pending') return;
        this.emitReactiveEvent('permission', `${req.action} → ${req.target}`);
        if (req.status === 'pending') this.emitInteraction({type: 'permission.requested', request: req});
      });
    }
    return req;
  }

  resolvePermission(
    approvalId: string,
    scopeHash: string,
    decision: PermissionResolutionScope,
  ): PermissionPromptResolution {
    const req = this.permissions.get(approvalId);
    if (!req) throw new FutrynError('NOT_FOUND');
    if (req.scopeHash !== scopeHash) throw new FutrynError('POLICY');
    if (req.status !== 'pending') throw new FutrynError('POLICY');
    if (Date.parse(req.expiresAt) <= Date.now()) {
      req.status = 'expired';
      throw new FutrynError('POLICY');
    }
    // Only what the prompt offered can be answered (Codex `available_decisions`).
    if (decision !== 'deny' && !req.decisions.includes(decision)) throw new FutrynError('POLICY');
    if (decision === 'always') {
      // Persist the project Allow rule first: if it cannot be saved nothing is approved.
      if (!req.alwaysRule) throw new FutrynError('POLICY');
      this.addPermissionRule('allow', req.alwaysRule);
    }
    req.status =
      decision === 'once'
        ? 'approved_once'
        : decision === 'session'
          ? 'approved_session'
          : decision === 'always'
            ? 'approved_always'
            : 'denied';
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
  requestPermission(
    input: {
      capability: PermissionPromptRequest['capability'];
      action: string;
      target: string;
      reason: string;
      riskLevel?: PermissionPromptRequest['riskLevel'];
      scopeKey?: string;
      diffPreview?: string;
      kind?: PermissionKind;
      /** Approvals offered (ADR 0055); default once + session. */
      decisions?: PermissionPromptRequest['decisions'];
      /** The project Allow rule an `always` answer saves. */
      alwaysRule?: string;
      /**
       * Rule namespace whose Allow rules may answer this request: `Network` and `Unsandboxed`
       * for a command that needs network or to leave the sandbox (ADR 0055). `Bash` deny and ask
       * rules judge the same command either way. Defaults to the tool of the capability.
       */
      ruleTool?: PermissionRuleTool;
      /** Exact structured command/path for project rules; null skips rules (display-only request). Defaults to `target`. */
      ruleTarget?: string | null;
      /** Bash: parsed sub-commands for project rules, or null for an unparsed script (ADR 0040). */
      ruleSegments?: string[] | null;
    },
    signal?: AbortSignal,
  ): Promise<PermissionResolutionScope> {
    if (signal?.aborted) return Promise.resolve('deny');
    // The mode answers only what policy left as `ask`; a fs.read that reaches here is a secret file.
    const {kind: explicitKind, ruleTarget, ruleSegments, ruleTool, ...prompt} = input;
    const kind: PermissionKind =
      explicitKind ??
      (
        {'fs.read': 'secret', 'fs.write': 'edit', 'process.execute': 'execute', 'network.connect': 'network'} as Record<
          string,
          PermissionKind
        >
      )[input.capability] ??
      'other';
    // Project rules first (deny > ask > allow), then the session mode.
    const tool: PermissionRuleTool =
      ruleTool ??
      (
        {'process.execute': 'Bash', 'fs.write': 'Edit', 'fs.read': 'Read', 'network.connect': 'WebFetch'} as Record<
          string,
          PermissionRuleTool
        >
      )[input.capability] ??
      'Tool';
    const commandRule = COMMAND_RULE_TOOLS.includes(tool);
    // Allow rules judge only structured targets (a real command or real paths), never display labels.
    const rules = this.permissionRules();
    const target =
      ruleTarget === null || (tool === 'Tool' && ruleTarget === undefined) ? null : (ruleTarget ?? input.target);
    const relative = (value: string) => (tool === 'Read' || tool === 'Edit' ? this.workspaceRelative(value) : value);
    const judge = (set: PermissionRuleSet, ruleToolName: PermissionRuleTool) =>
      permissionRuleDecision(set, {
        tool: ruleToolName,
        target: relative(target!),
        ...(commandRule && ruleSegments !== undefined ? {segments: ruleSegments} : {}),
      });
    let ruled: PermissionRuleEffect | undefined;
    if (target !== null) {
      if (commandRule) {
        // A command run with network or without a sandbox (including under `network_access` or Full
        // Access) is also judged by `Network`/`Unsandboxed` deny and ask rules; only the request's
        // own `tool` namespace can allow it (ADR 0055).
        const restrict: PermissionRuleSet = {allow: [], ask: rules.ask, deny: rules.deny};
        const extras: PermissionRuleTool[] = ['Bash'];
        if (
          tool === 'Network' ||
          this.sandboxModeValue === 'danger-full-access' ||
          (this.ports.sandboxNetwork === true && this.sandboxModeValue === 'workspace-write')
        )
          extras.push('Network');
        if (tool === 'Unsandboxed' || this.sandboxModeValue === 'danger-full-access') extras.push('Unsandboxed');
        const verdicts = [...new Set(extras)].map(name => judge(restrict, name));
        ruled = verdicts.includes('deny')
          ? 'deny'
          : verdicts.includes('ask')
            ? 'ask'
            : judge({allow: rules.allow, ask: [], deny: []}, tool);
      } else ruled = judge(rules, tool);
    }
    if (target === null) {
      // Fail closed: deny/ask rules still apply to the best text we have, and an unverifiable request
      // never slips past a deny/ask rule of its tool through a permissive mode such as bypass.
      ruled =
        permissionRuleDecision({allow: [], ask: rules.ask, deny: rules.deny}, {tool, target: relative(input.target)}) ??
        ([...rules.deny, ...rules.ask].some(rule => rule === tool || rule.startsWith(tool + '(')) ? 'ask' : undefined);
    }
    let decision = ruled ?? permissionModeDecision(this.permissionModeValue, kind, this.sandboxModeValue);
    // Codex `prompt_is_rejected_by_policy`: under `never` an ask rule (or any prompt) is refused, never shown.
    if (decision === 'ask' && APPROVAL_POLICY_FOR_MODE[this.permissionModeValue] === 'never') decision = 'deny';
    if (decision !== 'ask') {
      this.emitReactiveEvent(
        decision === 'allow' ? 'done' : 'error',
        `Permission ${decision === 'allow' ? 'approved' : 'denied'} by ${ruled ? 'project rule' : `${this.permissionModeValue} mode`}: ${input.action}`,
      );
      return Promise.resolve(decision === 'allow' ? 'once' : 'deny');
    }
    input = prompt;
    const request = this.enqueuePermissionRequest(input);
    if (request.status === 'approved_session') return Promise.resolve('session');
    return new Promise(resolve => {
      const settle = (decision: PermissionResolutionScope) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(decision);
      };
      const expire = () => {
        if (request.status === 'pending') request.status = 'expired';
        this.permissionWaiters.delete(request.approvalId);
        this.notifyStateChange();
        settle('deny');
      };
      const onAbort = () => {
        if (request.status === 'pending') this.dismissPermissionDialog(request.approvalId);
        else expire();
      };
      const timer = setTimeout(expire, Math.max(0, Date.parse(request.expiresAt) - Date.now()));
      signal?.addEventListener('abort', onAbort, {once: true});
      this.permissionWaiters.set(request.approvalId, resolution => settle(resolution.decision));
    });
  }

  /**
   * Dismissing a permission dialog without explicit approval ALWAYS denies or leaves pending safely;
   * closing a dialog never grants permission.
   */
  dismissPermissionDialog(approvalId: string): PermissionPromptResolution {
    const req = this.permissions.get(approvalId);
    if (!req) throw new FutrynError('NOT_FOUND');
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

export {FutrynClient as HannesClient};
