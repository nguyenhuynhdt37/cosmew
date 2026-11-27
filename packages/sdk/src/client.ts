import type {SandboxDependenciesReport} from '@cosmew/contracts';
import type {SandboxSettingsPatch} from '@cosmew/contracts';
import {isCodingModel} from '@cosmew/contracts';
import {parseSlashCommand} from './commands';
import {summarizeUsage} from './telemetry';
import {quotaItems, type AccountLimits, type FetchAccountLimits} from './limits';
import {createHash} from 'node:crypto';
import {
  FutrynError,
  ProviderBillingError,
  appearanceSchema,
  defaultAppearance,
  partialAppearanceSchema,
  permissionPromptResolutionSchema,
  permissionPromptRequestSchema,
  type HooksSnapshot,
  type RetractQueuedOptions,
  type QueuedInputEntry,
  type PromptHistoryScope,
  type PromptHistoryEntry,
  type HookRanEvent,
  type McpServersSnapshot,
  type McpManagerSnapshot,
  type McpManagementAction,
  type McpManagementResult,
  type McpConnectionState,
  type McpPromptView,
  type McpPromptResolution,
  type BackgroundTask,
  type BackgroundTaskEvent,
  type Account,
  type CheckpointView,
  type RewindScope,
  type RewindOutcome,
  type Attachment,
  type CommandOutputChunk,
  type ToolResult,
  SKILL_VISIBILITIES,
  type SkillsReport,
  type SkillVisibility,
  type MemoryInfo,
  type MemoryWrite,
  memoryWriteSchema,
  agentMessageInputSchema,
  type ProjectContextReport,
  type RequestContext,
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
  type PlanProposal,
  type PlanApprovalResolution,
  type PlanApprovalOutcome,
  type PendingQuestion,
  type UserAnswers,
  type UserInputOutcome,
  type UserQuestion,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  COMMAND_RULE_TOOLS,
  PERMISSION_MODE_CYCLE,
  PERMISSION_SETTINGS_SCOPES,
  type PermissionSettingsPort,
  type PermissionSettingsScope,
  type PermissionSettingsSnapshot,
  turnBudgetSchema,
  type TurnBudget,
  executionBackendFor,
  permissionModeDecision,
  permissionRuleDecision,
  permissionRuleSchema,
  isSafeAlwaysRule,
  DOMAIN_PATTERN,
  domainAllowed,
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
  type AgentTypesReport,
  type SubagentNotice,
  type SubagentEvent,
  type SubagentPromptAttribution,
  type SubagentSummaryView,
  type ThemeManifest,
  type Usage,
  type UsageBreakdown,
  type WorkspaceDiffFile,
  type WorkspaceDiffReport,
  type WorkspaceDiffOptions,
} from '@cosmew/contracts';

export type ImageAttachmentInput = {mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'} & (
  {data: string; path?: never} | {path: string; data?: never}
);
export interface ImageAttachmentView {
  id: string;
  label: string;
  mediaType: ImageAttachmentInput['mediaType'];
}

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
  | 'plan.proposed'
  | 'plan.resolved'
  | 'question.asked'
  | 'question.answered'
  /** Wave 2 S5a subagent notifications (contract 1.32); they never replace the current activity state. */
  | 'subagent.started'
  | 'subagent.progress'
  | 'subagent.finished'
  | 'task.started'
  | 'task.updated'
  | 'task.finished'
  | 'hook.ran'
  | 'memory.extracted';

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
  generalToolsExecution: 'implemented' | 'not-implemented';
  mcpIntegration: 'partial' | 'not-implemented';
  hooks: 'implemented' | 'not-implemented';
  pluginHost: 'not-implemented';
  delegatedSubagents: 'implemented' | 'not-implemented';
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

export interface QuickConnectProviderInput {
  /** One-line format: `https://host/v1 | api-key | model (optional)`. */
  raw?: string;
  baseURL?: string;
  apiKey?: string;
  modelId?: string;
  alias?: string;
  project?: string;
  /** Choose a model before generation or storage. An empty list allows a manual ID. */
  chooseModel?: (models: readonly ModelInfo[], signal?: AbortSignal) => Promise<string>;
}

export interface QuickConnectProviderResult {
  provider: Provider;
  account: Account;
  model: ModelInfo;
  modelsCount: number;
  protocol: Provider['protocol'];
  catalog: Provider['catalog'];
  reusedProvider: boolean;
  summary: string;
}

export interface TerminalRuntimeReport {
  label: string;
  available: boolean;
  reason?: string;
  /** `enabled`: OS sandbox with the domain-filtering proxy; `disabled`: `sandbox.enabled` is false in settings. */
  sandbox: 'enabled' | 'disabled' | 'unavailable';
  /** `sandbox.allowUnsandboxedCommands` is not false (the `dangerouslyDisableSandbox` escape hatch exists). */
  unsandboxedAllowed: boolean;
  limitations: string[];
}

/** What `/mcp` may show. No command line, environment, URL or headers. */
export interface McpStatusReport {
  configPath: string;
  servers: {name: string; transport: 'stdio' | 'http'; state: McpConnectionState; tools: number; error?: string}[];
  problems: string[];
}

/** Sanitized host management failure; arbitrary transport errors never become UI messages. */
export class McpManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AccountVerification =
  | {ok: true}
  | {ok: false; reason: 'no-account' | 'auth' | 'network' | 'model'}
  | {ok: false; reason: 'billing'; providerHint?: string};

export type EditorMode = 'normal' | 'vim';

export interface AppearanceStore {
  read(): AppearanceConfig;
  write(patch: PartialAppearanceConfig): void;
  notices?(): readonly string[];
  readEditorMode?(): EditorMode;
  writeEditorMode?(mode: EditorMode): void;
  onboardingState?(): {completed: readonly string[]; hasStoredTheme: boolean};
  completeOnboardingStep?(id: string): void;
}

export const DEFAULT_USER_PREFERENCES = Object.freeze({
  autoCompact: true,
  verbose: false,
  showTurnDuration: true,
});

export interface UserPreferences {
  autoCompact: boolean;
  verbose: boolean;
  showTurnDuration: boolean;
}

export interface UserPreferencesStore {
  readPreferences(): UserPreferences;
  writePreferences(patch: Partial<UserPreferences>): void;
}

export interface FutrynBackendPorts {
  /** User-only preferences; embeddings without a store apply changes in memory. */
  userPreferencesStore?: UserPreferencesStore;
  /** Host-owned user appearance storage; absent ports retain legacy embedding behavior. */
  appearanceStore?: AppearanceStore;
  workspace: string;
  createCommandFile?(filename: string, content: string, signal?: AbortSignal): Promise<ToolResult>;
  renameSession?(id: string, title: string): boolean;
  generateSessionTitle?(id: string, signal?: AbortSignal): Promise<string>;
  checkpoints?(sessionId: string): CheckpointView[];
  rewindCheckpoint?(
    sessionId: string,
    id: string,
    scope: RewindScope,
    signal?: AbortSignal,
    instructions?: string,
  ): Promise<RewindOutcome>;
  prepareImage?(input: ImageAttachmentInput): Promise<Attachment>;
  skills?(): SkillsReport;
  reloadSkills?(): SkillsReport;
  saveSkillOverrides?(changes: Readonly<Record<string, SkillVisibility>>): void;
  /** Inspect configured lifecycle hooks (ADR 0120). */
  hooks?(): HooksSnapshot;
  /** Ephemeral side question (`/btw`) using current context without tools or durable history mutation. */
  askSideQuestion?(
    input: {selection: Selection; messages: readonly Message[]; question: string},
    signal?: AbortSignal,
  ): Promise<{text: string; usage?: Usage}>;
  /** Optional post-turn hook for gated host background work such as auto-memory extraction (ADR 0124). */
  afterTurnCompleted?(
    input: {sessionId: string; selection: Selection; messages: readonly Message[]},
    signal?: AbortSignal,
  ): Promise<string[] | void>;
  memories?(): MemoryInfo[];
  memoryDirectory?(): string | null;
  openMemoryDirectory?(): Promise<void>;
  memoryAction?(action: 'read' | 'delete' | 'write', name: string, entry?: MemoryWrite): Promise<ToolResult>;
  terminalRuntime?(): TerminalRuntimeReport;
  sandboxDependencies?(): Promise<SandboxDependenciesReport>;
  /** Names of the Cosmew tools actually offered now (folder consent + runtime availability). */
  availableTools?(): string[];
  /**
   * User MCP servers (ADR 0068). Present when this process can connect `mcp.json`.
   * Absent means the integration is not wired, which status reports as `not-implemented`.
   */
  mcpStatus?(): McpStatusReport;
  mcpManagerSnapshot?(): Promise<McpManagerSnapshot>;
  manageMcp?(action: McpManagementAction, signal?: AbortSignal): Promise<McpManagementResult>;
  searchMcpStatus?(): McpServersSnapshot['servers'];
  /** Discovered prompts exposed by connected user MCP servers (ADR 0121). */
  mcpPrompts?(): McpPromptView[];
  /** Expand a user MCP prompt via `prompts/get` (ADR 0121). */
  getMcpPrompt?(
    qualifiedName: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpPromptResolution>;
  /** `!command` shell mode (ADR 0034): the same exec_command dispatcher, approval and sandbox as model calls. */
  runShellCommand?(
    command: string,
    signal?: AbortSignal,
    onOutput?: (chunk: CommandOutputChunk) => void,
    context?: {sessionId: string; callId: string},
  ): Promise<ToolResult>;
  getProjectContext?(): ProjectContextReport | null;
  previewContext?(
    selection: Selection | null,
    sessionId: string | undefined,
    draft?: Message,
  ): (RequestContext & {prepared?: true}) | undefined;
  /**
   * Mode this launch starts in (`--permission-mode`, `--dangerously-skip-permissions`). Without it
   * `permissions.defaultMode` of the settings applies, else `default` (ADR 0061).
   */
  permissionMode?: PermissionMode;
  /**
   * Claude Code style settings (user, project, local), merged and trust-filtered by the
   * composition root. Without a port the client keeps rules in memory only (tests, embedding).
   */
  permissionSettings?: PermissionSettingsPort;
  /**
   * The domain-filtering proxy asks the user about new network domains; headless runs turn this off
   * together with prompts. Repository settings trust prompts follow the same switch.
   */
  interactivePermissions?: boolean;
  /** Durable plan of a session (ADR 0042). */
  getPlan?(sessionId: string): PlanState | null;
  savePlanProposal?(sessionId: string, proposal: PlanProposal): PlanProposal | void;
  getPlanProposal?(sessionId: string): PlanProposal | null;
  /** Subagents spawned in `sessionId` (Wave 2 S5a), including recovered ones from persistence. */
  subagents?(sessionId?: string): SubagentSummaryView[];
  /** Inspect a specific subagent by its conversation ID. */
  inspectSubagent?(agentId: string): SubagentSummaryView | undefined;
  /** Agent types (built-in + custom definitions) with source and tools (S5b `/agents`). */
  agentTypes?(): AgentTypesReport;
  /** Abort a running subagent on the user's behalf; false when it is not running. */
  stopSubagent?(agentId: string): boolean;
  /** Explicit user follow-up, mediated by agent_message under the owning active parent. */
  sendSubagentMessage?(sessionId: string, agentId: string, message: string, signal?: AbortSignal): Promise<ToolResult>;
  /** Out-of-turn notices of background subagents (S5b); returns the unsubscribe function. */
  observeSubagentNotices?(listener: (notice: SubagentNotice) => void): () => void;
  /** Background child lifecycle independent of the parent's send iterator. */
  observeSubagentEvents?(listener: (notice: {parentSessionId: string; event: SubagentEvent}) => void): () => void;
  backgroundTasks?(sessionId: string): BackgroundTask[];
  stopBackgroundTask?(id: string, sessionId: string): Promise<boolean>;
  backgroundCurrentTask?(sessionId: string): BackgroundTask | undefined;
  observeBackgroundTasks?(listener: (event: BackgroundTaskEvent) => void): () => void;
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
  /** Quick third-party provider login: auto-probe `/models`, wire protocol and metadata, save config + keyring (ADR 0113). */
  quickConnectProvider?(input: QuickConnectProviderInput, signal?: AbortSignal): Promise<QuickConnectProviderResult>;
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
  toolGrants?: {list(): string[]; clear(capability?: string): void};
  /** Optional: live balance/quota from providers that expose one (e.g. OpenRouter key credit). */
  fetchAccountLimits?: FetchAccountLimits;
  /** Quota-bearing sources from this workspace's turn receipts and standalone usage. */
  listQuotaSources?(): Pick<UsageBreakdown, 'accountId' | 'providerId' | 'modelId' | 'quota'>[];
  discoverModels(
    account: Account,
    signal?: AbortSignal,
  ): Promise<{models: ModelInfo[]; stale: boolean; warning?: string}>;
  /** Advisory refresh; undefined when fresh, offline, unavailable or already attempted. */
  refreshModelMetadata?(account: Account, modelId: string): Promise<void> | undefined;
  cachedModels(account: Account): ModelInfo[];
  addManualModel(account: Account, modelId: string): ModelInfo;
  selectModel(account: Account, model: ModelInfo, project?: string): Selection;
  resolveSelection(project?: string): Selection | null;
  listSessions(): SessionSummary[];
  getSession(id: string): SessionRecord | undefined;
  deleteSession(id: string): boolean;
  setSessionSelection?(id: string, selection: Selection): {id: string; selection: Selection; messages: Message[]};
  forkSession?(id: string, selection: Selection): {id: string; selection: Selection; messages: Message[]};
  startSession(project?: string, selection?: Selection): {id: string; selection: Selection; messages: Message[]};
  resumeSession(id: string): {id: string; selection: Selection; messages: Message[]};
  sendTurn(
    sessionId: string,
    content: string,
    signal?: AbortSignal,
    maxOutputTokens?: number,
    maxEstimatedCostUSD?: number,
    reasoningEffort?: string,
    queuedInputId?: string,
    attachments?: Attachment[],
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
  retractQueuedInput?(sessionId: string): string;
  retractQueuedEntries?(
    sessionId: string,
    options: RetractQueuedOptions & {claimedIds?: readonly string[]},
  ): QueuedInputEntry[];
  promptHistory?(input: {
    scope: PromptHistoryScope;
    sessionId?: string;
    workspace: string;
    limit?: number;
  }): PromptHistoryEntry[];
  queueSteeringForNextTurn?(sessionId: string): void;
  queuedInput?(sessionId: string): readonly {steerId: string; content: string}[];
  /** Finishing-turn input is durable before the SDK reports it accepted. */
  enqueueNextTurn?(sessionId: string, content: string): {id: string; content: string};
  listNextTurn?(sessionId: string): readonly {id: string; content: string}[];
  loadCustomThemes(): {themes: ThemeManifest[]; errors: {file: string; message: string}[]};
  saveCustomTheme(manifest: ThemeManifest): ThemeManifest;
  removeCustomTheme(id: string): boolean;
  listWorkspaceFiles(query?: string): string[];
  getWorkspaceDiff(options?: WorkspaceDiffOptions): WorkspaceDiffReport;
  refreshWorkspaceDiff?(options?: WorkspaceDiffOptions): Promise<WorkspaceDiffReport>;
  /** True only when the read policy lets this workspace path's content reach the model without approval. */
  readAllowedWithoutApproval?(relativePath: string): boolean;
  sanitizeText(text: string): string;
}

/** Provider continuation is private model state; UI/session exports receive only visible messages. */
function visibleMessage<T extends Message>(message: T): Omit<T, 'providerReplay'> {
  const {providerReplay: _providerReplay, ...visible} = message;
  return visible;
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
  private imageSequence = 0;
  private imageGeneration = 0;
  private pendingImages: {view: ImageAttachmentView; attachment: Attachment}[] = [];
  private pendingPromptAttachments: Attachment[] = [];

  /** Stage validated MCP prompt media attachments for the immediately following sendMessage. */
  stagePromptAttachments(attachments: readonly Attachment[] | undefined): void {
    this.pendingPromptAttachments = attachments?.length ? attachments.slice(0, 4).map(item => ({...item})) : [];
  }
  clearPromptAttachments(): void {
    this.pendingPromptAttachments.length = 0;
  }

  /** Explicit user images are consumed by the next sendMessage, never inferred from prompt paths. */
  async attachImage(input: ImageAttachmentInput): Promise<ImageAttachmentView> {
    if (this.sending) throw new FutrynError('POLICY');
    if (!this.ports.prepareImage) throw new FutrynError('UNSUPPORTED');
    const generation = this.imageGeneration;
    const attachment = await this.ports.prepareImage(input);
    if (this.sending || generation !== this.imageGeneration) throw new FutrynError('POLICY');
    if (this.pendingImages.length >= 8) throw new FutrynError('INVALID_INPUT');
    const number = ++this.imageSequence;
    const view: ImageAttachmentView = {
      id: crypto.randomUUID(),
      label: `[Image #${number}]`,
      mediaType: attachment.mime as ImageAttachmentInput['mediaType'],
    };
    this.pendingImages.push({view, attachment});
    this.notifyStateChange();
    return {...view};
  }
  imageAttachments(): ImageAttachmentView[] {
    return this.pendingImages.map(i => ({...i.view}));
  }
  removeImageAttachment(id: string): boolean {
    const index = this.pendingImages.findIndex(i => i.view.id === id);
    if (index < 0) return false;
    this.pendingImages.splice(index, 1);
    this.notifyStateChange();
    return true;
  }

  private currentSession: {id: string; selection: Selection; messages: Message[]; title?: string} | null = null;
  private sessionSelection: Selection | null = null;
  private readonly sessionEfforts = new Map<string, string>();
  private readonly transientSessionModes = new Map<string, AgentMode>();
  private currentMode: AgentMode = 'chat';
  /** Session permission mode (ADR 0027/0061); never persisted, every session starts in the configured mode. */
  private permissionModeValue: PermissionMode;
  private readonly settingsPort: PermissionSettingsPort;
  /** Repository settings contents already offered to the user (hash), so a prompt is not repeated. */
  private readonly trustOffered = new Set<string>();
  /** Domains the user allowed for this session or once, with the time of a once-answer (ADR 0061). */
  private readonly networkOnce = new Map<string, {allowed: boolean; at: number}>();
  private readonly networkAsks = new Map<string, Promise<boolean>>();
  private readonly trustPrompts = new Map<string, {path: string; hash: string}>();
  private trustPromptsEnabled = true;
  private promptsAvailable = true;
  /** Optional per-turn work budget (ADR 0030); undefined means no limit. Session-only. */
  private turnBudgetValue: TurnBudget | undefined;
  private extraInstructionsValue: string | undefined;
  private lastUsage: Usage | null = null;
  /** Status is read on every UI frame; explicit usage reports remain fresh reads. */
  private statusUsage: ReturnType<FutrynClient['usage']> | null = null;
  private readonly accountVerifications = new Map<string, Promise<AccountVerification>>();
  private sending = false;
  private sendAbort?: AbortController;
  /** Turn identity of the running send, used to reject stale steering (Codex expected_turn_id). */
  private sandboxBlockedOperations = 0;
  private readonly sandboxDeniedCalls = new Set<string>();
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
  private readonly sessionGrants = new Map<string, string>();
  private readonly permissionWaiters = new Map<string, (resolution: PermissionPromptResolution) => void>();
  /** Workspace tools are offered only after the UI obtained folder consent (ADR 0014/0017). */
  private toolsAllowed = false;

  constructor(private readonly ports: FutrynBackendPorts) {
    this.turnBudgetValue = ports.settings.read().agentPreferences?.turnBudget;
    ports.observeSubagentNotices?.(notice => this.handleSubagentNotice(notice));
    ports.observeSubagentEvents?.(notice => this.handleSubagentEvent(notice.parentSessionId, notice.event));
    ports.observeBackgroundTasks?.(event => this.handleBackgroundTaskEvent(event));
    this.settingsPort = ports.permissionSettings ?? memoryPermissionSettings();
    this.permissionModeValue = this.initialPermissionMode();
  }

  /** The starting mode (ADR 0061): the launch flag, else `permissions.defaultMode`, else `default`. */
  initialPermissionMode(): PermissionMode {
    const mode = this.ports.permissionMode ?? this.settingsPort.snapshot().defaultMode;
    return mode && PERMISSION_MODES.includes(mode) ? mode : DEFAULT_PERMISSION_MODE;
  }

  /** Identity of the running turn, if any. */
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
    if (this.ports.appearanceStore) return this.projectAppearance?.[key] !== undefined ? 'workspace' : 'user';
    if (state.projectAppearances?.[this.ports.workspace]?.[key] !== undefined) return 'workspace';
    return state.appearance ? 'user' : 'default';
  }

  private clearSessionAuthorization(): void {
    this.pendingImages = [];
    this.pendingPromptAttachments = [];
    this.imageGeneration++;
    this.permissionModeValue = this.initialPermissionMode();
    this.sessionGrants.clear();
    this.networkOnce.clear();
    this.ports.toolGrants?.clear();
    this.denyPendingPermissions();
  }

  /** A policy change makes every unresolved authorization prompt stale, never an approval. */
  private denyPendingPermissions(capability?: string): void {
    if (capability === undefined) this.cancelPlanApproval();
    for (const request of this.permissions.values()) {
      if (capability !== undefined && request.capability !== capability) continue;
      // A trust prompt is about a file's content, not about the policy that just changed.
      if (request.capability === 'settings.trust') continue;
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
    if (!enabled) this.cancelPlanApproval();
    this.toolsAllowed = enabled;
    this.notifyStateChange();
    if (enabled) this.reviewSettingsTrust();
  }

  toolsEnabled(): boolean {
    return this.toolsAllowed;
  }

  /** Whether this canonical workspace has already received persistent interactive folder consent. */
  workspaceTrusted(): boolean {
    return this.ports.settings.read().trustedWorkspaces?.includes(this.ports.workspace) ?? false;
  }

  /** Persist explicit folder consent and enable workspace tools for this launch. */
  trustWorkspace(): void {
    const workspace = this.ports.workspace;
    this.ports.settings.update(settings => {
      const trusted = new Set(settings.trustedWorkspaces ?? []);
      trusted.add(workspace);
      settings.trustedWorkspaces = [...trusted].sort();
    });
    this.setToolsEnabled(true);
  }

  /** Files the user allowed tools to read for the rest of this session. */
  listToolGrants(): string[] {
    return this.ports.toolGrants?.list() ?? [];
  }

  /** Revoke every session tool grant; the next read asks again. */
  revokeToolGrants(): void {
    for (const controller of this.subagentMessages.keys()) controller.abort();
    // Both stores: the dispatcher's grants and the prompt cache that answers 'session' without
    // asking. Clearing only the first let a revoked file or command be re-granted silently.
    this.ports.toolGrants?.clear();
    this.sessionGrants.clear();
    this.networkOnce.clear();
    this.notifyStateChange();
  }

  /** User-scoped memory metadata; detailed reads/deletes remain mediated tool calls. */
  memories(): MemoryInfo[] {
    return this.toolsEnabled() ? structuredClone(this.ports.memories?.() ?? []) : [];
  }
  memoryDirectory(): string | null {
    return this.toolsEnabled() ? (this.ports.memoryDirectory?.() ?? null) : null;
  }
  async openMemoryDirectory(): Promise<void> {
    if (!this.toolsEnabled() || !this.ports.openMemoryDirectory) throw new FutrynError('UNSUPPORTED');
    await this.ports.openMemoryDirectory();
  }
  async readMemory(name: string): Promise<ToolResult> {
    return this.memoryAction('read', name);
  }
  async deleteMemory(name: string): Promise<ToolResult> {
    return this.memoryAction('delete', name);
  }
  /** Explicit user memory writes use the same mediated tool as model writes (ADR 0057). */
  async writeMemory(entry: MemoryWrite): Promise<ToolResult> {
    if (this.currentMode !== 'chat' || this.sending) throw new FutrynError('POLICY');
    if (!this.toolsEnabled() || !this.ports.memoryAction) throw new FutrynError('UNSUPPORTED');
    const validated = memoryWriteSchema.safeParse(entry);
    if (!validated.success) throw new FutrynError('INVALID_INPUT');
    return this.ports.memoryAction('write', validated.data.name, validated.data);
  }
  private async memoryAction(action: 'read' | 'delete', name: string): Promise<ToolResult> {
    if (!this.toolsEnabled() || !this.ports.memoryAction) throw new FutrynError('UNSUPPORTED');
    return this.ports.memoryAction(action, name);
  }

  skills(): SkillsReport {
    return structuredClone(
      this.toolsEnabled()
        ? (this.ports.skills?.() ?? {skills: [], errors: [], warnings: []})
        : {skills: [], errors: [], warnings: []},
    );
  }

  saveSkillOverrides(changes: Readonly<Record<string, SkillVisibility>>): void {
    if (!this.toolsEnabled() || !this.ports.saveSkillOverrides) throw new FutrynError('UNSUPPORTED');
    const catalog = new Map(this.skills().skills.map(skill => [skill.name, skill]));
    const updates = Object.entries(changes);
    if (
      updates.some(
        ([name, visibility]) =>
          !catalog.has(name) || catalog.get(name)?.disableModelInvocation || !SKILL_VISIBILITIES.includes(visibility),
      )
    )
      throw new FutrynError('INVALID_INPUT');
    this.ports.saveSkillOverrides(changes);
    this.notifyStateChange();
  }

  skillForCommand(input: string) {
    const name = /^\/([a-zA-Z0-9][a-zA-Z0-9_:-]{0,63})(?:\s|$)/.exec(input.trim())?.[1];
    return name ? this.skills().skills.find(skill => skill.name === name) : undefined;
  }
  isSkillCommand(input: string): boolean {
    if (parseSlashCommand(input).definition) return false;
    const skill = this.skillForCommand(input);
    return !!skill && skill.visibility !== 'off';
  }

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
    if (this.currentSession) this.transientSessionModes.delete(this.currentSession.id);
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
  additionalInstructions(): string | undefined {
    return this.extraInstructionsValue;
  }
  setAdditionalInstructions(text: string | undefined): void {
    if (text === undefined || !text.trim()) {
      this.extraInstructionsValue = undefined;
      return;
    }
    const trimmed = text.trim();
    if (Buffer.byteLength(trimmed, 'utf8') > 16384 || trimmed.includes('\0')) throw new FutrynError('INVALID_INPUT');
    this.extraInstructionsValue = trimmed;
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
    // As in Claude Code, bypassPermissions can only be entered by starting in it.
    if (mode === 'bypassPermissions' && this.initialPermissionMode() !== 'bypassPermissions')
      throw new FutrynError('POLICY');
    if (mode !== this.permissionModeValue) {
      // Answers given under the old mode (prompts, session grants) never outlive a mode change.
      this.denyPendingPermissions();
      this.revokeToolGrants();
    }
    this.permissionModeValue = mode;
    this.notifyStateChange();
    return mode;
  }

  /**
   * Shift+Tab: default -> acceptEdits -> plan -> default (bypassPermissions joins the cycle only
   * when the session started in it, as Claude Code does).
   */
  cyclePermissionMode(): PermissionMode {
    const order: PermissionMode[] =
      this.initialPermissionMode() === 'bypassPermissions'
        ? [...PERMISSION_MODE_CYCLE, 'bypassPermissions']
        : [...PERMISSION_MODE_CYCLE];
    const index = order.indexOf(this.permissionModeValue);
    return this.setPermissionMode(order[(index + 1) % order.length]!);
  }

  /** The merged, trust-filtered settings every decision reads (ADR 0061). */
  permissionSettings(): PermissionSettingsSnapshot {
    return this.settingsPort.snapshot();
  }

  /** Change user sandbox policy for subsequent commands; invalidate pending approvals and grants. */
  updateSandbox(patch: SandboxSettingsPatch): PermissionSettingsSnapshot {
    if (!this.settingsPort.updateSandbox) throw new FutrynError('UNSUPPORTED');
    this.settingsPort.updateSandbox(patch);
    this.denyPendingPermissions();
    this.revokeToolGrants();
    this.notifyStateChange();
    return this.permissionSettings();
  }

  /** Add an additional working directory via explicit user `/add-dir` action. */
  addAdditionalDirectory(directory: string, options: {persist?: boolean} = {}): string {
    if (!this.settingsPort.addAdditionalDirectory) throw new FutrynError('UNSUPPORTED');
    const added = this.settingsPort.addAdditionalDirectory(directory, options);
    this.notifyStateChange();
    return this.ports.sanitizeText(added);
  }

  /** Rescan skill directories in place (`/reload-skills`). */
  reloadSkills(): SkillsReport {
    if (!this.ports.reloadSkills) throw new FutrynError('UNSUPPORTED');
    const report = structuredClone(this.ports.reloadSkills());
    this.notifyStateChange();
    return report;
  }

  /** Ask an ephemeral side question (`/btw`) without running tools or modifying durable session history. */
  async askSideQuestion(question: string, signal?: AbortSignal): Promise<{text: string; usage?: Usage}> {
    const trimmed = question.trim();
    if (!trimmed) throw new FutrynError('INVALID_INPUT');
    if (this.sending) throw new FutrynError('POLICY');
    if (!this.ports.askSideQuestion) throw new FutrynError('UNSUPPORTED');
    const selection = this.status().selection;
    if (!selection) throw new FutrynError('AUTH');
    const messages = (this.currentSession?.messages ?? []).map(message => {
      const {providerReplay: _replay, ...visible} = message;
      return visible;
    });
    const result = await this.ports.askSideQuestion({selection, messages, question: trimmed}, signal);
    return {
      text: this.ports.sanitizeText(result.text),
      ...(result.usage ? {usage: result.usage} : {}),
    };
  }

  /** Structured export of the active conversation (`markdown` or `json`), sanitized and without private replay state. */
  exportSession(format: 'markdown' | 'json'): string {
    const session = this.currentSession;
    const sanitize = (value: string) => this.ports.sanitizeText(value);
    const messages = (session?.messages ?? []).map(message => ({
      role: message.role,
      content: sanitize(message.content),
      ...(message.toolName ? {toolName: sanitize(message.toolName)} : {}),
      ...(message.toolCallId ? {toolCallId: sanitize(message.toolCallId)} : {}),
      ...(message.toolCalls?.length
        ? {
            toolCalls: message.toolCalls.map(call => ({
              id: sanitize(call.id),
              name: sanitize(call.name),
              input: JSON.parse(sanitize(JSON.stringify(call.input))),
            })),
          }
        : {}),
    }));
    const title = sanitize(session?.title ?? 'Cosmew Conversation');
    const model = session?.selection.modelId ?? this.status().selection?.modelId ?? 'unknown';
    const exportedAt = new Date().toISOString();
    if (format === 'json') {
      return (
        JSON.stringify(
          {
            version: 1,
            exportedAt,
            sessionId: session?.id ?? null,
            title,
            model: sanitize(model),
            messages,
          },
          null,
          2,
        ) + '\n'
      );
    }
    const lines: string[] = [
      `# ${title}`,
      '',
      `- **Session**: ${session?.id ?? 'unsaved'}`,
      `- **Model**: ${sanitize(model)}`,
      `- **Exported**: ${exportedAt}`,
      '',
    ];
    for (const message of messages) {
      if (message.role === 'user') {
        lines.push('## User', '', message.content, '');
      } else if (message.role === 'assistant') {
        lines.push('## Assistant', '');
        if (message.content) lines.push(message.content, '');
        if (message.toolCalls?.length) {
          for (const call of message.toolCalls) {
            lines.push(
              `### Tool Call: \`${call.name}\``,
              '',
              '```json',
              JSON.stringify(call.input, null, 2),
              '```',
              '',
            );
          }
        }
      } else if (message.role === 'tool') {
        lines.push(`### Tool Result: \`${message.toolName ?? 'tool'}\``, '', '```text', message.content, '```', '');
      }
    }
    return lines.join('\n').trimEnd() + '\n';
  }

  async sandboxDependencies(): Promise<SandboxDependenciesReport> {
    if (!this.ports.sandboxDependencies) throw new FutrynError('UNSUPPORTED');
    return structuredClone(await this.ports.sandboxDependencies());
  }

  private recordSandboxDenied(result: ToolResult): void {
    if (
      !this.settingsPort.snapshot().sandbox.enabled ||
      result.code !== 'SANDBOX_DENIED' ||
      !['exec_command', 'write_stdin'].includes(result.name) ||
      this.sandboxDeniedCalls.has(result.callId)
    )
      return;
    this.sandboxDeniedCalls.add(result.callId);
    this.sandboxBlockedOperations++;
  }

  /** Effective rules of the working directory: user + project + local settings (deny > ask > allow). */
  permissionRules(): PermissionRuleSet {
    const {rules} = this.settingsPort.snapshot();
    return {allow: [...rules.allow], ask: [...rules.ask], deny: [...rules.deny]};
  }

  /** Save a rule in one settings file (default: the local, uncommitted one). */
  addPermissionRule(
    effect: PermissionRuleEffect,
    rule: string,
    scope: PermissionSettingsScope = 'local',
  ): PermissionRuleSet {
    const parsed = permissionRuleSchema.safeParse(rule.trim());
    if (!parsed.success || !PERMISSION_SETTINGS_SCOPES.includes(scope)) throw new FutrynError('INVALID_INPUT');
    this.settingsPort.addRule(scope, effect, parsed.data);
    // Tightening policy invalidates old prompts and session grants. Adding Allow is a relaxation
    // (including the `always` prompt answer), so active prompts and session grants stay intact.
    if (effect !== 'allow') {
      this.denyPendingPermissions();
      this.revokeToolGrants();
    }
    this.notifyStateChange();
    return this.permissionRules();
  }
  removePermissionRule(
    effect: PermissionRuleEffect,
    rule: string,
    scope: PermissionSettingsScope = 'local',
  ): PermissionRuleSet {
    this.settingsPort.removeRule(scope, effect, rule);
    if (effect === 'allow') this.denyPendingPermissions();
    this.revokeToolGrants();
    this.notifyStateChange();
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

  cycleMode(): AgentMode {
    const order: AgentMode[] = ['chat', 'plan', 'review'];
    const idx = order.indexOf(this.currentMode);
    return this.setMode(order[(idx + 1) % order.length]!);
  }

  /** Cosmew tools offered right now; exec_command appears only when its OS containment is proven. */
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
    this.sandboxBlockedOperations = 0;
    this.sandboxDeniedCalls.clear();
    this.sending = true;
    const shellAbort = new AbortController();
    this.sendAbort = shellAbort;
    const shellSignal = options.signal ? AbortSignal.any([options.signal, shellAbort.signal]) : shellAbort.signal;
    try {
      const result = await this.ports.runShellCommand(command, shellSignal, options.onOutput, {
        sessionId: session.id,
        callId: options.callId ?? `shell-${crypto.randomUUID()}`,
      });
      this.recordSandboxDenied(result);
      return result;
    } finally {
      this.sending = false;
      this.sendAbort = undefined;
      const stored = this.ports.getSession(session.id);
      if (stored) session.messages = committedSessionMessages(stored);
      this.notifyStateChange();
    }
  }
  /**
   * Cosmew tools the selected backend really offers the model: none unless folder consent holds, the
   * backend runs Cosmew tools (Cosmew agent or Codex bridge) and the model supports tools.
   */
  /** Connected user MCP servers, or an empty report when this process has no MCP port. */
  mcpStatus(): McpStatusReport {
    try {
      return this.ports.mcpStatus?.() ?? {configPath: '', servers: [], problems: []};
    } catch {
      return {configPath: '', servers: [], problems: ['MCP status is unavailable.']};
    }
  }

  invalidateMcpPermissions(): void {
    // Advance the dispatcher's MCP epoch before waking stale prompt waiters.
    this.ports.toolGrants?.clear('mcp.call');
    for (const [scopeHash, capability] of this.sessionGrants)
      if (capability === 'mcp.call') this.sessionGrants.delete(scopeHash);
    this.denyPendingPermissions('mcp.call');
    this.notifyStateChange();
  }

  /** Refresh UI projections when background MCP connection status changes without revoking unrelated grants. */
  notifyMcpStatusChanged(): void {
    this.notifyStateChange();
  }

  async mcpManager(): Promise<McpManagerSnapshot> {
    return structuredClone(
      (await this.ports.mcpManagerSnapshot?.()) ?? {supported: false, configPath: '', servers: [], problems: []},
    );
  }

  async manageMcp(action: McpManagementAction, signal?: AbortSignal): Promise<McpManagementResult> {
    if (!this.ports.manageMcp) throw new FutrynError('UNSUPPORTED');
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    const mutating = !['search', 'recommended', 'doctor'].includes(action.type);
    if (mutating) this.invalidateMcpPermissions();
    try {
      return structuredClone(await this.ports.manageMcp(action, signal));
    } catch (error) {
      if (error instanceof FutrynError)
        throw new McpManagementError(error.code, this.ports.sanitizeText(error.message).slice(0, 300));
      throw error;
    } finally {
      this.notifyStateChange();
    }
  }

  mcpPrompts(): McpPromptView[] {
    const sanitize = (value: string) => this.ports.sanitizeText(value);
    try {
      return (this.ports.mcpPrompts?.() ?? []).map(prompt => ({
        qualifiedName: sanitize(prompt.qualifiedName),
        server: sanitize(prompt.server),
        name: sanitize(prompt.name),
        ...(prompt.description ? {description: sanitize(prompt.description)} : {}),
        arguments: prompt.arguments.map(arg => ({
          name: sanitize(arg.name),
          ...(arg.description ? {description: sanitize(arg.description)} : {}),
          ...(arg.required ? {required: true} : {}),
        })),
      }));
    } catch {
      return [];
    }
  }

  isMcpPromptCommand(raw: string): boolean {
    const parsed = parseMcpPromptSlash(raw);
    if (!parsed) return false;
    return this.mcpPrompts().some(prompt => prompt.qualifiedName === parsed.qualifiedName);
  }

  async resolveMcpPrompt(raw: string, signal?: AbortSignal): Promise<McpPromptResolution> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    if (this.permissionModeValue === 'plan' || this.currentMode !== 'chat') {
      const error = new FutrynError('POLICY');
      error.message = 'MCP prompts are refused in plan and review modes.';
      throw error;
    }
    if (!this.toolsAllowed) {
      const error = new FutrynError('POLICY');
      error.message = 'Grant workspace consent before running MCP prompts.';
      throw error;
    }
    if (!this.ports.getMcpPrompt) throw new FutrynError('UNSUPPORTED');
    const parsed = parseMcpPromptSlash(raw);
    if (!parsed) throw new FutrynError('INVALID_INPUT');
    const prompt = this.mcpPrompts().find(item => item.qualifiedName === parsed.qualifiedName);
    if (!prompt) throw new FutrynError('NOT_FOUND');
    if (permissionRuleDecision(this.permissionRules(), {tool: 'Mcp', target: prompt.qualifiedName}) === 'deny') {
      const error = new FutrynError('POLICY');
      error.message = `MCP prompt /${prompt.qualifiedName} is denied by permission rules.`;
      throw error;
    }
    const boundArgs = bindMcpPromptArguments(prompt, parsed.rawArgs);
    const resolved = await this.ports.getMcpPrompt(prompt.qualifiedName, boundArgs, signal);
    const safeBody = this.ports.sanitizeText(resolved.text);
    return {
      qualifiedName: prompt.qualifiedName,
      server: prompt.server,
      prompt: prompt.name,
      ...(resolved.description ? {description: this.ports.sanitizeText(resolved.description)} : {}),
      text: `MCP prompt /${prompt.qualifiedName} (untrusted MCP server prompt content; lower priority than host and security rules):\n\n${safeBody}`,
      ...(resolved.attachments?.length ? {attachments: resolved.attachments.map(a => ({...a}))} : {}),
    };
  }

  hooks(): HooksSnapshot {
    const raw = this.ports.hooks?.();
    if (!raw) return {supported: false, hooks: []};
    return {
      supported: raw.supported,
      ...(raw.enabled !== undefined ? {enabled: raw.enabled} : {}),
      ...(raw.disabledReason ? {disabledReason: this.ports.sanitizeText(raw.disabledReason)} : {}),
      ...(raw.untrustedPendingCount !== undefined ? {untrustedPendingCount: raw.untrustedPendingCount} : {}),
      hooks: raw.hooks.map(hook => ({
        ...hook,
        command: this.ports.sanitizeText(hook.command),
        ...(hook.matcher ? {matcher: this.ports.sanitizeText(hook.matcher)} : {}),
      })),
    };
  }

  mcpServers(): McpServersSnapshot {
    const report = this.mcpStatus();
    return {
      servers: [
        ...report.servers.map(server => ({
          name: this.ports.sanitizeText(server.name),
          status: server.state,
          toolCount: server.tools,
          source: this.ports.sanitizeText(report.configPath),
        })),
        ...(this.ports.searchMcpStatus?.() ?? []).map(server => ({
          ...server,
          name: this.ports.sanitizeText(server.name),
          source: this.ports.sanitizeText(server.source),
        })),
      ],
      supported: {stdioManagement: Boolean(this.ports.manageMcp), oauthManagement: Boolean(this.ports.manageMcp)},
    };
  }

  private readonly hookListeners = new Set<(event: HookRanEvent) => void>();
  onHookRan(listener: (event: HookRanEvent) => void): () => void {
    this.hookListeners.add(listener);
    return () => this.hookListeners.delete(listener);
  }

  availableTools(): string[] {
    if (!this.toolsReachModel()) return [];
    try {
      return this.ports.availableTools?.() ?? [];
    } catch {
      return [];
    }
  }

  /** Same condition the status reports: consent + a backend that runs Cosmew tools + a tools-capable model. */
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
      generalToolsExecution: this.ports.availableTools ? 'implemented' : 'not-implemented',
      mcpIntegration: this.ports.mcpStatus ? 'partial' : 'not-implemented',
      hooks: this.ports.hooks ? 'implemented' : 'not-implemented',
      pluginHost: 'not-implemented',
      delegatedSubagents: this.ports.subagents ? 'implemented' : 'not-implemented',
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

  /** Subagents spawned by `sessionId` (defaults to the active session), in creation order. */
  subagents(sessionId = this.currentSession?.id): SubagentSummaryView[] {
    if (!sessionId) return [];
    return structuredClone(this.ports.subagents?.(sessionId) ?? []);
  }

  /** Shell sessions and background subagents belonging to this conversation. Snapshots carry no authority. */
  backgroundTasks(sessionId = this.currentSession?.id): BackgroundTask[] {
    if (!sessionId || !this.toolsEnabled()) return [];
    const shell = this.ports.backgroundTasks?.(sessionId) ?? [];
    const agents: BackgroundTask[] = this.subagents(sessionId)
      .filter(agent => agent.background)
      .map(agent => ({
        id: agent.id,
        kind: 'agent',
        description: agent.description,
        status:
          agent.status === 'completed'
            ? 'done'
            : agent.status === 'failed'
              ? 'failed'
              : ['cancelled', 'closed', 'interrupted'].includes(agent.status)
                ? 'stopped'
                : 'running',
        startedAt: agent.createdAt,
        outputTail: (agent.summary || agent.steps.map(step => step.text ?? step.output ?? '').join('\n')).slice(-8192),
      }));
    return structuredClone(
      [...shell, ...agents].map(task => ({
        ...task,
        description: this.ports.sanitizeText(task.description),
        outputTail: this.ports.sanitizeText(task.outputTail),
      })),
    );
  }

  async stopBackgroundTask(id: string): Promise<boolean> {
    const sessionId = this.currentSession?.id;
    const task = this.backgroundTasks(sessionId).find(task => task.id === id);
    if (!sessionId || !task || task.status !== 'running') return false;
    return task.kind === 'agent' ? this.stopSubagent(id) : (this.ports.stopBackgroundTask?.(id, sessionId) ?? false);
  }

  backgroundCurrentTask(): BackgroundTask | undefined {
    const sessionId = this.currentSession?.id;
    if (!sessionId || !this.toolsEnabled()) return undefined;
    const task = this.ports.backgroundCurrentTask?.(sessionId);
    return task
      ? structuredClone({
          ...task,
          description: this.ports.sanitizeText(task.description),
          outputTail: this.ports.sanitizeText(task.outputTail),
        })
      : undefined;
  }

  private readonly backgroundTaskListeners = new Set<(event: BackgroundTaskEvent) => void>();
  private handleSubagentEvent(parentSessionId: string, event: SubagentEvent): void {
    // The immutable parent attribution comes from stored child metadata, never the current UI session.
    this.notify(event.type, `${event.agentType}: ${event.description}`);
    if (!event.background) return;
    const task = this.backgroundTasks(parentSessionId).find(task => task.id === event.agentId);
    if (!task) return;
    this.handleBackgroundTaskEvent({
      type:
        event.type === 'subagent.started'
          ? 'task.started'
          : event.type === 'subagent.finished'
            ? 'task.finished'
            : 'task.updated',
      task,
      parentSessionId,
    });
  }
  onBackgroundTaskEvent(listener: (event: BackgroundTaskEvent) => void): () => void {
    this.backgroundTaskListeners.add(listener);
    return () => this.backgroundTaskListeners.delete(listener);
  }
  private handleBackgroundTaskEvent(event: BackgroundTaskEvent): void {
    const clean = {
      ...event,
      task: {
        ...event.task,
        description: this.ports.sanitizeText(event.task.description),
        outputTail: this.ports.sanitizeText(event.task.outputTail),
      },
    };
    const detail =
      clean.type === 'task.finished' && clean.task.kind === 'shell'
        ? `Background command "${clean.task.description}" ${clean.task.status === 'done' ? 'completed' : clean.task.status}${clean.task.exitCode === undefined ? '' : ` (exit code ${clean.task.exitCode})`}`
        : clean.task.description;
    this.notify(clean.type, detail);
    for (const listener of [...this.backgroundTaskListeners]) {
      try {
        listener(structuredClone(clean));
      } catch {
        /* observers cannot break execution */
      }
    }
  }

  /** Inspect one subagent session by its conversation ID. */
  inspectSubagent(agentId: string): SubagentSummaryView | undefined {
    const found = this.ports.inspectSubagent?.(agentId);
    return found ? structuredClone(found) : undefined;
  }

  /** Agent types the model may use (built-in and custom), with source/description/tools; empty before consent. */
  agentTypes(): AgentTypesReport {
    if (!this.toolsEnabled() || !this.ports.agentTypes) return {types: [], errors: [], warnings: []};
    return structuredClone(this.ports.agentTypes());
  }

  /** `/agents` stop: abort a running subagent; it stays resumable via agent_message. Returns whether it was running. */
  stopSubagent(agentId: string): boolean {
    if (!this.toolsEnabled() || !this.ports.stopSubagent) throw new FutrynError('UNSUPPORTED');
    return this.ports.stopSubagent(agentId);
  }

  private readonly subagentMessages = new Map<AbortController, string>();

  /** Explicitly steer a running child or resume a finished child through the tool dispatcher. */
  async sendSubagentMessage(agentId: string, message: string, signal?: AbortSignal): Promise<ToolResult> {
    const sessionId = this.currentSession?.id;
    if (!this.toolsEnabled() || !this.ports.sendSubagentMessage) throw new FutrynError('UNSUPPORTED');
    const input = agentMessageInputSchema.safeParse({id: agentId, message});
    if (!input.success || !message.trim()) throw new FutrynError('INVALID_INPUT');
    if (
      !sessionId ||
      !this.subagents(sessionId).some(child => child.id === agentId && child.parentConversationId === sessionId)
    )
      throw new FutrynError('NOT_FOUND');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    this.subagentMessages.set(controller, sessionId);
    try {
      return await this.ports.sendSubagentMessage(sessionId, agentId, message, controller.signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.subagentMessages.delete(controller);
      this.notifyStateChange();
    }
  }

  private readonly subagentNoticeListeners = new Set<(notice: SubagentNotice) => void>();
  /** Subscribe to background subagent completions (summary delivery already happened; this is for the UI). */
  onSubagentNotice(listener: (notice: SubagentNotice) => void): () => void {
    this.subagentNoticeListeners.add(listener);
    return () => this.subagentNoticeListeners.delete(listener);
  }
  private handleSubagentNotice(notice: SubagentNotice): void {
    const clean: SubagentNotice = {
      ...notice,
      agentType: this.ports.sanitizeText(notice.agentType),
      description: this.ports.sanitizeText(notice.description),
    };
    this.notify('subagent.finished', `${clean.agentType}: ${clean.description}`);
    const agentTask = this.backgroundTasks(clean.parentSessionId).find(task => task.id === clean.agentId);
    if (agentTask)
      this.handleBackgroundTaskEvent({
        type: 'task.finished',
        task: agentTask,
        parentSessionId: clean.parentSessionId,
        ...(clean.delivery === 'steered' || clean.delivery === 'queued' ? {delivery: clean.delivery} : {}),
      });
    for (const listener of [...this.subagentNoticeListeners]) {
      try {
        listener(clean);
      } catch {
        /* observers cannot break the agent */
      }
    }
  }

  private planApproval:
    | {
        request: PlanProposal;
        signal?: AbortSignal;
        resolve: (outcome: PlanApprovalOutcome) => void;
        reject: (error: unknown) => void;
        cleanup: () => void;
      }
    | undefined;
  private readonly planListeners = new Set<(proposal: PlanProposal) => void>();

  pendingPlanApproval(): PlanProposal | null {
    return this.planApproval ? structuredClone(this.planApproval.request) : null;
  }
  /** Durable review history; unlike pendingPlanApproval it may survive restart. */
  planProposal(): PlanProposal | null {
    const id = this.currentSession?.id;
    const proposal = id ? this.ports.getPlanProposal?.(id) : null;
    return proposal ? structuredClone(proposal) : null;
  }
  onPlanProposed(listener: (proposal: PlanProposal) => void): () => void {
    this.planListeners.add(listener);
    return () => this.planListeners.delete(listener);
  }
  canProposePlan(): boolean {
    return this.toolsEnabled() && this.permissionModeValue === 'plan' && this.currentMode !== 'review';
  }
  /** Called only through the dispatcher; approval does not replay any tool. */
  proposePlan(plan: string, signal?: AbortSignal): Promise<PlanApprovalOutcome> {
    if (!this.canProposePlan()) return Promise.reject(new FutrynError('POLICY'));
    if (!this.userInputAvailable)
      return Promise.resolve({kind: 'unavailable', reason: 'no interactive user is attached'});
    if (signal?.aborted) return Promise.reject(new FutrynError('CANCELLED'));
    if (!this.currentSession || this.planApproval) return Promise.reject(new FutrynError('POLICY'));
    if (typeof plan !== 'string' || !plan.trim() || plan.length > 32000)
      return Promise.reject(new FutrynError('INVALID_INPUT'));
    let request: PlanProposal = {
      id: crypto.randomUUID(),
      sessionId: this.currentSession.id,
      plan: this.ports.sanitizeText(plan.trim()),
      createdAt: new Date().toISOString(),
      status: 'proposed',
      revision: 1,
    };
    request = this.ports.savePlanProposal?.(request.sessionId, request) ?? request;
    return new Promise((resolve, reject) => {
      const onAbort = () => this.cancelPlanApproval();
      this.planApproval = {
        request,
        signal,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, {once: true});
      this.notify('plan.proposed');
      for (const listener of [...this.planListeners]) {
        try {
          listener(structuredClone(request));
        } catch {
          /* observers have no authority */
        }
      }
    });
  }
  /** Update only a live pending review. Editing never changes permission mode or grants tools. */
  editPlanProposal(text: string, expected?: {id: string; expectedRevision: number}): PlanProposal {
    const pending = this.requirePlanApproval();
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new FutrynError('INVALID_INPUT');
    if (
      expected &&
      (expected.id !== pending.request.id || expected.expectedRevision !== (pending.request.revision ?? 1))
    )
      throw new FutrynError('POLICY');
    const plan = this.ports.sanitizeText(text.trim());
    if (!plan || plan.length > 32000) throw new FutrynError('INVALID_INPUT');
    if (plan === pending.request.plan) return structuredClone(pending.request);
    const record: PlanProposal = {...pending.request, plan, revision: (pending.request.revision ?? 1) + 1};
    delete record.path;
    const saved = this.ports.savePlanProposal?.(record.sessionId, record) ?? record;
    if (this.requirePlanApproval() !== pending) throw new FutrynError('POLICY');
    pending.request = saved;
    this.notify('plan.proposed');
    for (const listener of [...this.planListeners]) {
      try {
        listener(structuredClone(saved));
      } catch {
        /* observers have no authority */
      }
    }
    return structuredClone(saved);
  }
  private requirePlanApproval() {
    const pending = this.planApproval;
    if (!pending) throw new FutrynError('NOT_FOUND');
    if (pending.signal?.aborted || !this.canProposePlan() || pending.request.sessionId !== this.currentSession?.id) {
      this.cancelPlanApproval();
      throw new FutrynError('POLICY');
    }
    return pending;
  }
  resolvePlanApproval(resolution: PlanApprovalResolution): void {
    const pending = this.requirePlanApproval();
    const object = typeof resolution === 'object' && resolution !== null ? resolution : undefined;
    const mode = typeof resolution === 'string' ? resolution : object && 'mode' in object ? object.mode : undefined;
    const feedback = object?.feedback;
    if (
      (mode !== undefined && mode !== 'manual' && mode !== 'acceptEdits') ||
      (object && (typeof feedback !== 'string' || !feedback.trim() || feedback.length > 4000)) ||
      (!mode && !object)
    )
      throw new FutrynError('INVALID_INPUT');
    const cleanFeedback = feedback === undefined ? undefined : this.ports.sanitizeText(feedback.trim());
    const outcome: PlanApprovalOutcome = mode
      ? {
          kind: 'approved',
          mode,
          ...(pending.request.revision! > 1 ? {plan: pending.request.plan} : {}),
          ...(cleanFeedback !== undefined ? {feedback: cleanFeedback} : {}),
        }
      : {
          kind: 'feedback',
          feedback: cleanFeedback!,
          ...(pending.request.revision! > 1 ? {plan: pending.request.plan} : {}),
        };
    const record: PlanProposal = {
      ...pending.request,
      status: outcome.kind === 'feedback' ? 'feedback' : 'approved',
      ...(cleanFeedback !== undefined ? {feedback: cleanFeedback} : {}),
      ...(outcome.kind === 'approved' ? {resolution: outcome.mode} : {}),
    };
    // Persist before granting a mode transition. Storage failure leaves the dialog pending.
    this.ports.savePlanProposal?.(record.sessionId, record);
    if (this.requirePlanApproval() !== pending) throw new FutrynError('POLICY');
    if (outcome.kind === 'approved') this.rememberSessionMode(record.sessionId, 'chat');
    if (this.requirePlanApproval() !== pending) throw new FutrynError('POLICY');
    this.planApproval = undefined;
    pending.cleanup();
    if (outcome.kind === 'approved') {
      this.setPermissionMode(outcome.mode === 'manual' ? 'default' : 'acceptEdits');
      this.currentMode = 'chat';
    }
    pending.resolve(outcome);
    this.notify('plan.resolved');
  }
  private cancelPlanApproval(): void {
    const pending = this.planApproval;
    if (!pending) return;
    this.planApproval = undefined;
    pending.cleanup();
    try {
      this.ports.savePlanProposal?.(pending.request.sessionId, {...pending.request, status: 'cancelled'});
      pending.reject(new FutrynError('CANCELLED'));
    } catch (error) {
      pending.reject(error);
    }
    this.notify('plan.resolved');
  }

  // ---- request_user_input (ADR 0042) -------------------------------------------------------
  private readonly questions = new Map<
    string,
    {request: PendingQuestion; settle: (outcome: UserInputOutcome) => void}
  >();
  private userInputAvailable = false;

  /** An interactive UI is attached and can answer questions (the TUI sets it; `exec` never does). */
  setUserInputAvailable(available: boolean): void {
    if (!available) this.cancelPlanApproval();
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
    for (const [controller, sessionId] of this.subagentMessages) {
      if (this.currentSession?.id !== sessionId || !this.toolsEnabled()) controller.abort();
    }
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
      unsandboxedAllowed: false,
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
    const selection = this.currentSession?.selection ?? this.sessionSelection ?? this.ports.resolveSelection(project);
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
      sandboxBlockedOperations: this.sandboxBlockedOperations,
      mode: this.currentMode,
      permissionMode: this.permissionModeValue,
      /** `sandbox.*` of the merged settings (ADR 0061). */
      sandbox: (() => {
        const {sandbox, additionalDirectories} = this.settingsPort.snapshot();
        return {
          enabled: sandbox.enabled,
          autoAllowBashIfSandboxed: sandbox.autoAllowBashIfSandboxed,
          allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands,
          allowedDomains: sandbox.allowedDomains.length,
          excludedCommands: sandbox.excludedCommands.length,
          additionalDirectories: additionalDirectories.length,
        };
      })(),
      bypassAvailable: this.initialPermissionMode() === 'bypassPermissions',
      executionBackend,
      /** Cosmew tools reach the model: folder consent AND a backend that runs them AND a capable model. */
      toolsEnabled: workspaceReadStatus === 'read-only',
      providers: state.providers,
      accounts: state.accounts,
      activeAccount,
      activeProvider,
      selection,
      activeModel,
      workspaceReadStatus,
      activeSessionId: this.currentSession?.id ?? null,
      sessionTitle: this.currentSession?.title ?? null,
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

  async quickConnectProvider(
    input: QuickConnectProviderInput,
    signal?: AbortSignal,
  ): Promise<QuickConnectProviderResult> {
    if (this.sending) throw new FutrynError('POLICY');
    if (!this.ports.quickConnectProvider) throw new FutrynError('UNSUPPORTED');
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    const result = await this.ports.quickConnectProvider(input, signal);
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    this.clearSessionAuthorization();
    this.currentSession = null;
    this.sessionSelection = null;
    this.lastUsage = null;
    this.notifyStateChange();
    return {
      ...result,
      summary: this.ports.sanitizeText(result.summary),
    };
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
      const chosen =
        models.find(m => m.id === (input.manualModelId ?? refreshed.defaultModel)) ??
        models.find(m => isCodingModel(m));
      if (chosen) this.ports.selectModel(refreshed, chosen);
      this.clearSessionAuthorization();
      this.currentSession = null;
      this.sessionSelection = null;
      this.lastUsage = null;
      this.notifyStateChange();
      return this.ports.getAccount(refreshed.id);
    } catch (error) {
      // A failed or cancelled login cannot leave a usable credential behind.
      // Failed cleanup is surfaced so the account remains retryable via /logout.
      if (account) await this.ports.logoutAccount(account.id, !input.reauthenticateAccountId);
      if (account && this.sessionSelection?.accountId === account.id) this.sessionSelection = null;
      if (account && this.currentSession?.selection.accountId === account.id) {
        this.clearSessionAuthorization();
        this.currentSession = null;
        this.lastUsage = null;
      }
      this.notifyStateChange();
      throw error;
    }
  }

  /** Verify the pinned selection once per credential generation and model on this client. */
  async verifyAccount(signal?: AbortSignal): Promise<AccountVerification> {
    const {activeAccount: account, selection} = this.status();
    if (!account || account.status === 'logged-out') return {ok: false, reason: 'no-account'};
    if (!selection) return {ok: false, reason: 'model'};
    const interrupted = {ok: false, reason: 'network'} as const;
    if (signal?.aborted) return interrupted;

    const key = JSON.stringify([account.id, account.authGeneration ?? 1, selection.modelId]);
    let pending = this.accountVerifications.get(key);
    if (!pending) {
      const deadline = AbortSignal.timeout(20_000);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      pending = Promise.resolve().then(async (): Promise<AccountVerification> => {
        try {
          if (requestSignal.aborted) return interrupted;
          await this.ports.validateAccount({...account, defaultModel: selection.modelId}, requestSignal, true);
          if (requestSignal.aborted) return interrupted;
          return {ok: true};
        } catch (error) {
          if (requestSignal.aborted) return interrupted;
          const code = error instanceof FutrynError ? error.code : undefined;
          if (code === 'PROVIDER_BILLING') {
            const providerHint = error instanceof ProviderBillingError ? error.providerHint : undefined;
            return {ok: false, reason: 'billing', ...(providerHint ? {providerHint} : {})};
          }
          if (code === 'AUTH' || code === 'FORBIDDEN') return {ok: false, reason: 'auth'};
          if (code === 'NOT_FOUND' || code === 'INVALID_INPUT' || code === 'UNSUPPORTED')
            return {ok: false, reason: 'model'};
          return interrupted;
        } finally {
          if (signal?.aborted) this.accountVerifications.delete(key);
          this.notifyStateChange();
        }
      });
      this.accountVerifications.set(key, pending);
    }

    const result = await pending;
    if (signal?.aborted) return interrupted;
    const current = this.status();
    if (!current.activeAccount || current.activeAccount.status === 'logged-out')
      return {ok: false, reason: 'no-account'};
    if (
      current.activeAccount.id !== account.id ||
      (current.activeAccount.authGeneration ?? 1) !== (account.authGeneration ?? 1) ||
      current.selection?.modelId !== selection.modelId
    )
      return {ok: false, reason: 'model'};
    return result;
  }

  async diagnose(signal?: AbortSignal, generate = false): Promise<string> {
    const status = this.status();
    const account = status.activeAccount;
    let configProblems = '';
    try {
      const problems = this.ports.hostConfigDiagnostics?.() ?? [];
      if (problems.length) configProblems = `\nHost config problems (~/.cosmew/config.toml): ${problems.join('; ')}`;
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
    this.sessionSelection = null;
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
    if (this.sessionSelection?.accountId === target.id) this.sessionSelection = null;
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
    all?: boolean;
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
    const selected = this.status().selection;
    let models = options?.all
      ? base.models
      : base.models.filter(m => isCodingModel(m, selected?.accountId === accountId ? selected.modelId : undefined));
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

  private readonly metadataRefreshes = new Map<string, Promise<void> | null>();

  /** Starts advisory work without blocking input/turns; consumers share its completion. */
  refreshModelMetadata(
    options: {accountId?: string; modelId?: string; effortOnly?: boolean; offline?: boolean} = {},
  ): Promise<void> | undefined {
    if (options.offline || !this.ports.refreshModelMetadata) return;
    try {
      const status = this.status();
      const accountId = options.accountId ?? status.activeAccount?.id;
      const modelId = options.modelId ?? status.selection?.modelId;
      if (!accountId || !modelId) return;
      const account = this.ports.getAccount(accountId);
      const model = this.ports.cachedModels(account).find(model => model.id === modelId);
      if (!model || model.reasoningEfforts?.length || model.capabilities.reasoning === 'unsupported') return;
      if (
        options.effortOnly &&
        !this.effort(accountId, model) &&
        !this.ports.settings.read().reasoningPreferences?.[accountId + ':' + modelId]
      )
        return;
      const key = accountId + ':' + modelId;
      if (this.metadataRefreshes.has(key)) return this.metadataRefreshes.get(key) ?? undefined;
      const refresh = this.ports.refreshModelMetadata(account, modelId);
      if (!refresh) return;
      const pending = refresh
        .catch(() => {})
        .finally(() => {
          this.metadataRefreshes.set(key, null);
          this.notifyStateChange();
        });
      this.metadataRefreshes.set(key, pending);
      return pending;
    } catch {
      // Advisory lookup must never prevent selecting or using an account.
      return;
    }
  }

  cachedModels(accountId?: string): ModelInfo[] {
    const state = this.ports.settings.read();
    const targetId = accountId ?? this.status().activeAccount?.id ?? state.activeAccountId;
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
    const targetId = accountId ?? this.status().activeAccount?.id ?? state.activeAccountId;
    if (!targetId) throw new FutrynError('AUTH');
    const account = this.ports.getAccount(targetId);
    const model = this.ports.addManualModel(account, modelId);
    this.notifyStateChange();
    return model;
  }

  selectModel(modelId: string, options?: {accountId?: string; projectScoped?: boolean; scope?: 'session'}): Selection {
    if (options?.scope !== undefined && options.scope !== 'session') throw new FutrynError('INVALID_INPUT');
    const state = this.ports.settings.read();
    const targetId = options?.accountId ?? this.status().activeAccount?.id ?? state.activeAccountId;
    if (!targetId) throw new FutrynError('AUTH');
    const account = this.ports.getAccount(targetId);
    if (account.status === 'logged-out') throw new FutrynError('AUTH');
    const models = this.ports.cachedModels(account);
    const model = models.find(m => m.id === modelId);
    if (!model) throw new FutrynError('NOT_FOUND');
    const previousSelection = this.currentSession?.selection;
    if (this.sending) throw new FutrynError('POLICY');
    const changed = Boolean(
      this.currentSession && (previousSelection?.accountId !== account.id || previousSelection?.modelId !== model.id),
    );
    if (options?.scope === 'session') {
      const selection = {accountId: account.id, modelId: model.id};
      if (this.currentSession && changed) {
        if (this.ports.setSessionSelection) {
          const updated = this.ports.setSessionSelection(this.currentSession.id, selection);
          this.transientSessionModes.set(updated.id, this.currentMode);
          this.clearSessionAuthorization();
          this.currentSession = {...updated, title: this.currentSession.title};
          this.lastUsage = null;
        } else if (this.ports.forkSession) {
          const fork = this.ports.forkSession(this.currentSession.id, selection);
          this.transientSessionModes.set(fork.id, this.currentMode);
          this.clearSessionAuthorization();
          this.currentSession = fork;
          this.lastUsage = null;
        } else {
          throw new FutrynError('UNSUPPORTED');
        }
      }
      this.sessionSelection = this.currentSession ? null : selection;
      this.notifyStateChange();
      return {...selection};
    }
    if (this.currentSession && changed && this.ports.setSessionSelection) {
      const targetSelection = {accountId: account.id, modelId: model.id};
      const sessionId = this.currentSession.id;
      const title = this.currentSession.title;
      const updated = this.ports.setSessionSelection(sessionId, targetSelection);
      let selection: Selection;
      try {
        selection = this.ports.selectModel(account, model, options?.projectScoped ? this.ports.workspace : undefined);
      } catch (error) {
        try {
          this.ports.setSessionSelection(sessionId, previousSelection!);
        } catch {
          /* preserve primary error */
        }
        throw error;
      }
      this.sessionSelection = null;
      this.clearSessionAuthorization();
      this.currentSession = {...updated, title};
      this.lastUsage = null;
      this.notifyStateChange();
      return selection;
    }
    this.sessionSelection = null;
    const selection = this.ports.selectModel(account, model, options?.projectScoped ? this.ports.workspace : undefined);
    // Fallback for minimal embeddings without in-place session selection updates.
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
    const stored = this.ports.getSession(id);
    if (!stored) return undefined;
    return {
      ...stored,
      messages: stored.messages.map(visibleMessage),
      ...(stored.recovery
        ? {recovery: {...stored.recovery, messages: stored.recovery.messages.map(visibleMessage)}}
        : {}),
    };
  }

  createSession(projectScoped = false): {id: string; selection: Selection; messages: Message[]} {
    if (this.sending) throw new FutrynError('POLICY');
    const session = this.ports.startSession(
      projectScoped ? this.ports.workspace : undefined,
      !this.currentSession ? (this.sessionSelection ?? undefined) : undefined,
    );
    this.rememberSessionMode(session.id, this.currentMode);
    this.clearSessionAuthorization();
    const pendingKey = `pending:${session.selection.accountId}:${session.selection.modelId}`;
    const pendingEffort = !this.currentSession ? this.sessionEfforts.get(pendingKey) : undefined;
    if (pendingEffort !== undefined) {
      this.sessionEfforts.set(
        `${session.id}:${session.selection.accountId}:${session.selection.modelId}`,
        pendingEffort,
      );
      this.sessionEfforts.delete(pendingKey);
    }
    this.currentSession = session;
    this.sessionSelection = null;
    this.lastUsage = null;
    this.notifyStateChange();
    return {
      id: this.currentSession.id,
      selection: {...this.currentSession.selection},
      messages: this.currentSession.messages.map(visibleMessage),
    };
  }

  resumeSession(id: string): {id: string; selection: Selection; messages: Message[]} {
    if (this.sending) throw new FutrynError('POLICY');
    const mode = this.transientSessionModes.get(id) ?? this.ports.settings.read().sessionModes?.[id] ?? 'chat';
    const stored = this.ports.getSession(id);
    const session = this.ports.resumeSession(id);
    if (this.currentSession) this.claimedNextTurn.delete(this.currentSession.id);
    this.clearSessionAuthorization();
    this.currentSession = {...session, title: stored?.title};
    this.sessionSelection = null;
    this.currentMode = mode;
    this.lastUsage = stored?.turns?.at(-1)?.usage ?? null;
    this.notifyStateChange();
    return {
      id: this.currentSession.id,
      selection: {...this.currentSession.selection},
      messages: this.currentSession.messages.map(visibleMessage),
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
      id === this.currentSession?.id
        ? this.currentMode
        : (this.transientSessionModes.get(id) ?? this.ports.settings.read().sessionModes?.[id] ?? 'chat');
    const fork = this.ports.forkSession(id, source.selection);
    this.rememberSessionMode(fork.id, mode);
    this.clearSessionAuthorization();
    this.currentSession = fork;
    this.currentMode = mode;
    this.lastUsage = null;
    this.notifyStateChange();
    return {id: fork.id, selection: {...fork.selection}, messages: fork.messages.map(visibleMessage)};
  }

  deleteSession(id: string): boolean {
    if (this.currentSession?.id === id && this.sending) throw new FutrynError('POLICY');
    const deleted = this.ports.deleteSession(id);
    if (!deleted) return false;
    this.claimedNextTurn.delete(id);
    this.transientSessionModes.delete(id);
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
    this.sessionSelection = null;
    this.sessionEfforts.clear();
    this.lastUsage = null;
    this.notifyStateChange();
  }

  activeSession(): {id: string; selection: Selection; messages: Message[]} | null {
    if (!this.currentSession) return null;
    return {
      id: this.currentSession.id,
      selection: {...this.currentSession.selection},
      messages: this.currentSession.messages.map(visibleMessage),
    };
  }

  checkpoints(): CheckpointView[] {
    return this.currentSession ? (this.ports.checkpoints?.(this.currentSession.id) ?? []) : [];
  }

  async createCommandFile(filename: string, content: string, signal?: AbortSignal): Promise<ToolResult> {
    if (this.sending || !this.toolsEnabled()) throw new FutrynError('POLICY');
    if (!this.ports.createCommandFile) throw new FutrynError('UNSUPPORTED');
    if (
      filename.length > 240 ||
      filename.split('/').some(part => !/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,119}$/u.test(part) || part.endsWith(' ')) ||
      Buffer.byteLength(content) > 512 * 1024
    )
      throw new FutrynError('INVALID_INPUT');
    signal?.throwIfAborted();
    return this.ports.createCommandFile(filename, this.ports.sanitizeText(content), signal);
  }

  async renameCurrentSession(name?: string, signal?: AbortSignal): Promise<string> {
    if (this.sending) throw new FutrynError('POLICY');
    const session = this.currentSession;
    if (!session) throw new FutrynError('NOT_FOUND');
    if (!this.ports.renameSession) throw new FutrynError('UNSUPPORTED');
    if (name === undefined && !this.ports.generateSessionTitle) throw new FutrynError('UNSUPPORTED');
    signal?.throwIfAborted();
    const source = name ?? (await this.ports.generateSessionTitle!(session.id, signal));
    signal?.throwIfAborted();
    if (this.currentSession !== session || this.sending) throw new FutrynError('POLICY');
    const title = [
      ...this.ports
        .sanitizeText(source)
        .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\s]+/gu, ' ')
        .trim(),
    ]
      .slice(0, 200)
      .join('');
    if (!title) throw new FutrynError('INVALID_INPUT');
    if (!this.ports.renameSession(session.id, title)) throw new FutrynError('NOT_FOUND');
    this.currentSession = {...session, title};
    this.notifyStateChange();
    return title;
  }

  async rewind(
    input: {checkpointId: string; scope: RewindScope; instructions?: string},
    signal?: AbortSignal,
  ): Promise<RewindOutcome> {
    const {checkpointId: id, scope} = input;
    if (
      input.instructions !== undefined &&
      (typeof input.instructions !== 'string' || input.instructions.length > 4000)
    )
      throw new FutrynError('INVALID_INPUT');
    if (
      !['conversation', 'code', 'both', 'summarize'].includes(scope) ||
      !this.currentSession ||
      !this.ports.rewindCheckpoint
    )
      throw new FutrynError('INVALID_INPUT');
    if (this.sending) throw new FutrynError('POLICY');
    if (this.backgroundTasks().some(t => t.status === 'running')) throw new FutrynError('POLICY');
    const session = this.currentSession;
    this.sending = true;
    try {
      const outcome = await this.ports.rewindCheckpoint(
        session.id,
        id,
        scope,
        signal,
        input.instructions === undefined ? undefined : this.ports.sanitizeText(input.instructions.trim()),
      );
      if (outcome.restored && outcome.sessionId && outcome.sessionId !== session.id) {
        const next = this.ports.resumeSession(outcome.sessionId);
        this.clearSessionAuthorization();
        this.currentSession = next;
        this.lastUsage = null;
        this.rememberSessionMode(next.id, this.currentMode);
      }
      this.notifyStateChange();
      return outcome;
    } finally {
      this.sending = false;
    }
  }

  async *sendMessage(
    content: string,
    options?: {signal?: AbortSignal; maxOutputTokens?: number; maxEstimatedCostUSD?: number; projectScoped?: boolean},
  ): AsyncIterable<ModelEvent> {
    const trimmed = [content.trim(), ...this.pendingImages.map(i => i.view.label)].filter(Boolean).join('\n');
    if (!trimmed) throw new FutrynError('INVALID_INPUT');
    if (this.sending) throw new FutrynError('POLICY');
    if (!this.currentSession) {
      const session = this.ports.startSession(
        options?.projectScoped ? this.ports.workspace : undefined,
        this.sessionSelection ?? undefined,
      );
      this.rememberSessionMode(session.id, this.currentMode);
      this.currentSession = session;
      this.sessionSelection = null;
      const pendingKey = `pending:${session.selection.accountId}:${session.selection.modelId}`;
      const pendingEffort = this.sessionEfforts.get(pendingKey);
      if (pendingEffort !== undefined) {
        this.sessionEfforts.set(
          `${session.id}:${session.selection.accountId}:${session.selection.modelId}`,
          pendingEffort,
        );
        this.sessionEfforts.delete(pendingKey);
      }
    }
    this.refreshModelMetadata();
    const images = [...this.pendingImages.splice(0).map(i => i.attachment), ...this.pendingPromptAttachments.splice(0)];
    this.imageGeneration++;
    const session = this.currentSession;
    const claimed = this.claimedNextTurn.get(session.id);
    const queuedInputId = claimed?.content === trimmed ? claimed.id : undefined;
    this.sandboxBlockedOperations = 0;
    this.sandboxDeniedCalls.clear();
    this.sending = true;
    const sendAbort = new AbortController();
    this.sendAbort = sendAbort;
    const turnSignal = options?.signal ? AbortSignal.any([options.signal, sendAbort.signal]) : sendAbort.signal;
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
        turnSignal,
        options?.maxOutputTokens,
        options?.maxEstimatedCostUSD,
        this.status().reasoningEffort ?? undefined,
        queuedInputId,
        images.length ? images : undefined,
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
            this.recordSandboxDenied(event.result);
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
          case 'hook.ran': {
            const clean = {
              ...event,
              name: this.ports.sanitizeText(event.name),
              summary: this.ports.sanitizeText(event.summary),
            };
            this.notify('hook.ran', clean.summary);
            for (const listener of [...this.hookListeners]) {
              try {
                listener({...clean});
              } catch {}
            }
            break;
          }
          case 'subagent.started':
          case 'subagent.progress':
          case 'subagent.finished':
            this.handleSubagentEvent(session.id, event);
            break;
          case 'completed': {
            this.lastUsage = event.usage;
            this.streamingText = '';
            this.streamingSteps = [];
            const stored = this.ports.getSession(session.id);
            if (stored) session.messages = committedSessionMessages(stored);
            else session.messages.push({role: 'user', content: trimmed}, {role: 'assistant', content: assistantText});
            if (this.currentMode === 'chat' && !turnSignal.aborted && this.ports.afterTurnCompleted) {
              try {
                const savedMemories = await this.ports.afterTurnCompleted(
                  {sessionId: session.id, selection: session.selection, messages: session.messages},
                  turnSignal,
                );
                if (Array.isArray(savedMemories) && savedMemories.length) {
                  const labels = savedMemories.map(name => this.ports.sanitizeText(name)).join(', ');
                  this.notify('memory.extracted', `Auto-saved ${savedMemories.length} memory entry: ${labels}`);
                }
              } catch {
                /* Auto-memory extraction is best-effort and never fails the completed turn. */
              }
            }
            this.emitReactiveEvent('done', event.finishReason);
            break;
          }
        }
        yield event;
      }
    } catch (err) {
      try {
        const stored = this.ports.getSession(session.id);
        if (stored?.recovery) session.messages = stored.recovery.messages;
      } catch {
        /* Preserve the original turn error if session storage is unavailable during teardown. */
      }
      this.emitReactiveEvent('error', err instanceof FutrynError ? err.code : 'ERROR');
      throw err;
    } finally {
      // Reservations are transient; the inbox row is acknowledged atomically by the backend.
      // If acceptance failed, the durable row remains available for a later explicit retry.
      this.claimedNextTurn.delete(session.id);
      this.sending = false;
      this.sendAbort = undefined;
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
  /** Release an unconsumed queued-message claim if submission aborted before `sendMessage()` began. */
  releaseQueuedMessage(sessionId?: string): void {
    const id = sessionId ?? this.currentSession?.id;
    if (!id || !this.claimedNextTurn.has(id)) return;
    this.claimedNextTurn.delete(id);
    this.notifyStateChange();
  }
  queuedMessages(): readonly string[] {
    return this.currentSession
      ? (this.ports.listNextTurn?.(this.currentSession.id) ?? []).map(input => input.content)
      : [];
  }
  /** Accepted instructions the last turn could not process; the next sent message delivers them first. */
  queuedInput(): readonly {steerId: string; content: string}[] {
    if (!this.currentSession) return [];
    const id = this.currentSession.id;
    return [
      ...(this.ports.queuedInput?.(id) ?? []),
      ...(this.ports.listNextTurn?.(id) ?? []).map(p => ({steerId: p.id, content: p.content})),
    ].map(p => ({...p}));
  }

  /** Move the shell lease when possible; otherwise interrupt. The durable inbox delivers next. */
  sendQueuedNow(): 'backgrounded' | 'interrupted' | 'idle' {
    if (!this.sending) return 'idle';
    const sessionId = this.currentSession?.id;
    if (sessionId) this.ports.queueSteeringForNextTurn?.(sessionId);
    if (this.backgroundCurrentTask()) return 'backgrounded';
    this.sendAbort?.abort();
    return 'interrupted';
  }

  retractQueuedInput(): string {
    const id = this.currentSession?.id;
    if (!id) return '';
    if (this.ports.retractQueuedEntries)
      return this.retractQueuedEntries()
        .map(entry => entry.content)
        .join('\n');
    // A legacy backend cannot exclude the input already handed to its delivery caller.
    if (this.claimedNextTurn.has(id)) throw new FutrynError('POLICY');
    if (!this.ports.retractQueuedInput) throw new FutrynError('UNSUPPORTED');
    const text = this.ports.retractQueuedInput(id);
    this.notifyStateChange();
    return this.ports.sanitizeText(text);
  }

  /** Atomic selective take-back. A snapshot is never delivery or retraction authority. */
  retractQueuedEntries(options: RetractQueuedOptions = {}): QueuedInputEntry[] {
    const id = this.currentSession?.id;
    if (!id) return [];
    if (!this.ports.retractQueuedEntries) throw new FutrynError('UNSUPPORTED');
    const claimed = this.claimedNextTurn.get(id);
    const entries = this.ports.retractQueuedEntries(id, {
      ...options,
      // Only this client owns the reservation. Callers cannot replace or hide its identity.
      claimedIds: claimed ? [claimed.id] : [],
    });
    this.notifyStateChange();
    return entries.map(e => ({...e, content: this.ports.sanitizeText(e.content)}));
  }
  promptHistory(input: {scope: PromptHistoryScope; limit?: number} = {scope: 'everywhere'}): PromptHistoryEntry[] {
    if (
      !['session', 'project', 'everywhere'].includes(input.scope) ||
      (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1))
    )
      throw new FutrynError('INVALID_INPUT');
    if (!this.ports.promptHistory) throw new FutrynError('UNSUPPORTED');
    const limit = Math.min(200, Math.floor(input.limit ?? 100));
    return this.ports
      .promptHistory({...input, limit, workspace: this.ports.workspace, sessionId: this.currentSession?.id})
      .slice(0, limit)
      .map(e => ({...e, content: this.ports.sanitizeText(e.content).slice(0, 16000)}));
  }

  steerMessage(content: string): SteerOutcome {
    const trimmed = content.trim();
    if (!trimmed) return {accepted: false, reason: 'empty_input'};
    if (!this.sending || !this.currentSession) return {accepted: false, reason: 'no_active_turn'};
    // Codex steer_input refuses Review tasks; Cosmew's review mode is the same non-steerable kind.
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
    this.sandboxBlockedOperations = 0;
    this.sandboxDeniedCalls.clear();
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
    return this.usageFromRecord(this.currentSession ? this.ports.getSession(this.currentSession.id) : undefined);
  }

  private usageFromRecord(record?: SessionRecord) {
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
      record?.additionalUsage,
    );
  }

  /**
   * Limits for every connected account, from what is already known: the last live fetch or the
   * plan snapshot attached to the latest reply. Sends no request.
   */
  limits(): AccountLimits[] {
    const providers = new Map(this.ports.listProviders().map(p => [p.id, p]));
    const accounts = this.ports.listAccounts().filter(account => account.status !== 'logged-out');
    const knownAccounts = new Map(accounts.map(account => [account.id, account]));
    type QuotaItem = NonNullable<Usage['quota']>[number] & {modelId?: string};
    const snapshots = new Map<string, Map<string, QuotaItem>>();
    const collect = (
      accountId: string | undefined,
      providerId: string | undefined,
      quota?: Usage['quota'],
      modelId?: string,
    ) => {
      if (!accountId || !knownAccounts.has(accountId)) return;
      if (providerId && knownAccounts.get(accountId)!.providerId !== providerId) return;
      const items = snapshots.get(accountId) ?? new Map<string, QuotaItem>();
      for (const item of quota ?? []) {
        const key = JSON.stringify([
          item.kind ?? 'unknown',
          item.name,
          item.kind === 'rate-limit' ? modelId : undefined,
        ]);
        const previous = items.get(key);
        if (
          Number.isFinite(Date.parse(item.observedAt)) &&
          (!previous || Date.parse(item.observedAt) > Date.parse(previous.observedAt))
        )
          items.set(key, {...item, modelId});
      }
      snapshots.set(accountId, items);
    };
    // Session selection changes and sort order do not identify the account that made a request.
    // Scan all saved turns, including child/compaction sources; never borrow their quota for a parent.
    if (this.ports.listQuotaSources) {
      for (const source of this.ports.listQuotaSources())
        collect(source.accountId, source.providerId, source.quota, source.modelId);
    } else {
      for (const summary of this.ports.listSessions()) {
        const record = this.ports.getSession(summary.id);
        const usages = [...(record?.turns ?? []).map(turn => turn.usage), record?.additionalUsage];
        for (const usage of usages) {
          for (const source of usage?.breakdown ?? [])
            collect(source.accountId, source.providerId, source.quota, source.modelId);
        }
      }
    }
    return accounts.map(account => {
      const providerName = providers.get(account.providerId)?.name ?? account.providerId;
      const base = {accountId: account.id, alias: account.alias, providerId: account.providerId, providerName};
      const live = this.liveLimits.get(account.id);
      const checking = this.limitsPending.has(account.id) || undefined;
      const quota = [...(snapshots.get(account.id)?.values() ?? [])];
      const reported = quotaItems(quota).map((item, index) => ({
        ...item,
        ...(quota[index]?.modelId ? {modelId: quota[index]!.modelId} : {}),
        label:
          item.kind === 'rate-limit' && quota[index]?.modelId ? `${item.label} (${quota[index]!.modelId})` : item.label,
      }));
      const items = [...(live?.items ?? []), ...reported];
      if (items.length) {
        const observed = [live?.items.length ? live.observedAt : null, ...quota.map(q => q.observedAt)]
          .filter((at): at is string => Boolean(at))
          .sort((a, b) => Date.parse(b) - Date.parse(a));
        return {
          ...base,
          source: live?.items.length
            ? reported.length
              ? ('mixed' as const)
              : ('live' as const)
            : ('last-turn' as const),
          status: live?.error ? ('error' as const) : ('available' as const),
          observedAt: observed[0] ?? null,
          items,
          stale: Boolean(
            live?.stale || live?.error || items.some(item => item.resetAt && Date.parse(item.resetAt) <= Date.now()),
          ),
          note: live?.note,
          error: live?.error,
          checking,
        };
      }
      const supportsHeaders = ['openai', 'anthropic', 'chatgpt-api'].includes(account.providerId);
      return {
        ...base,
        source: 'unavailable' as const,
        status: live?.error
          ? ('error' as const)
          : (live?.status ?? (supportsHeaders ? ('unavailable' as const) : ('unsupported' as const))),
        observedAt: live?.observedAt ?? null,
        items: [],
        note:
          live?.note ??
          (supportsHeaders
            ? 'No provider-reported snapshot yet. Limits appear only when returned in response headers; no supported account quota refresh endpoint.'
            : 'Account quota refresh is unsupported for this provider. No provider-reported limits are available.'),
        error: live?.error,
        checking,
      };
    });
  }

  /** Ask providers that have a balance/quota API for fresh numbers. Concurrent calls share one refresh. */
  refreshLimits(signal?: AbortSignal): Promise<void> {
    const fetchLimits = this.ports.fetchAccountLimits;
    if (!fetchLimits || signal?.aborted) return Promise.resolve();
    this.limitsRefresh ??= (async () => {
      const providers = new Map(this.ports.listProviders().map(p => [p.id, p]));
      await Promise.allSettled(
        this.ports
          .listAccounts()
          .filter(account => account.status !== 'logged-out')
          .map(async account => {
            if (signal?.aborted) return;
            const base = {
              accountId: account.id,
              alias: account.alias,
              providerId: account.providerId,
              providerName: providers.get(account.providerId)?.name ?? account.providerId,
            };
            try {
              const request = fetchLimits(account, signal);
              if (!request) return;
              this.limitsPending.add(account.id);
              this.notifyStateChange();
              const result = await request;
              if (signal?.aborted) return;
              this.liveLimits.set(account.id, {
                ...base,
                source: 'live',
                status: result.items.length ? 'available' : 'unavailable',
                observedAt: new Date().toISOString(),
                items: result.items.map(item => ({
                  ...item,
                  source: 'live' as const,
                  observedAt: new Date().toISOString(),
                })),
                note: result.note,
                stale: false,
              });
            } catch (error) {
              if (
                signal?.aborted ||
                (error instanceof FutrynError && error.code === 'CANCELLED') ||
                (error instanceof Error && error.name === 'AbortError')
              )
                return;
              const previous = this.liveLimits.get(account.id);
              this.liveLimits.set(account.id, {
                ...base,
                source: 'live',
                status: 'error',
                observedAt: previous?.observedAt ?? null,
                items: previous?.items ?? [],
                note: previous?.note,
                stale: true,
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

  private readonly contextMessageBytes = new WeakMap<Message, number>();

  context(draft = '') {
    const status = this.status();
    const history = this.currentSession?.messages ?? [];
    const record = this.currentSession ? this.ports.getSession(this.currentSession.id) : undefined;
    const pending = this.sending ? record?.messages.filter(message => message.state === 'pending').at(-1) : undefined;
    const trimmedDraft = draft.trim();
    const requestDraft = /^[\/!]/.test(trimmedDraft) ? '' : trimmedDraft;
    const images = this.pendingImages;
    const draftContent = [requestDraft, ...images.map(image => image.view.label)].filter(Boolean).join('\n');
    const draftMessage: Message | undefined = draftContent
      ? {
          role: 'user',
          content: draftContent,
          ...(images.length ? {attachments: images.map(image => image.attachment)} : {}),
        }
      : undefined;
    const preview = this.ports.previewContext?.(
      status.selection,
      this.currentSession?.id,
      pending ? {role: pending.role, content: pending.content} : draftMessage,
    );
    const tail: Message[] = [
      ...(pending ? [{role: pending.role, content: pending.content}] : []),
      ...(pending ? this.streamingSteps : []),
      ...(pending && this.streamingText ? [{role: 'assistant' as const, content: this.streamingText}] : []),
      ...(requestDraft ? [{role: 'user' as const, content: requestDraft}] : []),
    ];
    // For a JSON array, UTF-8 byte counts are additive across its serialized entries and commas.
    // The SDK replaces messages on recovery/rewind and appends new objects when committing a turn.
    const count = history.length + tail.length;
    let bytes = 2 + Math.max(0, count - 1);
    for (const message of preview ? [] : [...history, ...tail]) {
      let length = this.contextMessageBytes.get(message);
      if (length === undefined) {
        length = Buffer.byteLength(JSON.stringify(message), 'utf8');
        this.contextMessageBytes.set(message, length);
      }
      bytes += length;
    }
    const instructionBytes = this.projectContext()?.usedBytes ?? 0;
    const messageCount = preview?.messages ?? count + (instructionBytes ? 1 : 0);
    const estimate =
      preview?.estimateTokens ??
      (messageCount ? Math.ceil((bytes + instructionBytes) / 4) + messageCount * 16 + 64 : 0);
    const latest = record?.turns?.findLast(turn => turn.kind !== 'user-shell');
    const observation = record?.turns?.findLast(
      turn =>
        turn.accountId === status.selection?.accountId &&
        turn.modelId === status.selection?.modelId &&
        turn.context &&
        turn.context.source !== 'estimate',
    );
    const last = observation?.context ?? null;
    const limit = preview?.limitTokens ?? last?.limitTokens ?? status.activeModel?.contextLimit ?? null;
    const reserve = preview?.outputReserve ?? 0;
    return {
      autoCompact: this.userPreferences().autoCompact,
      estimateTokens: estimate,
      estimateMethod: preview
        ? 'Cosmew request estimate (about 3 UTF-8 bytes/token)'
        : 'UTF-8 bytes / 4 + message overhead; no exact tokenizer',
      estimateSource: preview?.prepared ? 'prepared' : preview ? 'preview' : 'history',
      limitTokens: limit,
      outputReserve: reserve,
      outputLimit: status.activeModel?.outputLimit ?? null,
      estimatedPercent: limit ? Math.round((estimate / limit) * 1000) / 10 : null,
      measuredCurrentHistory:
        !preview &&
        !!observation &&
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
    const key = `${this.currentSession?.id ?? 'pending'}:${accountId}:${model.id}`;
    const override = this.sessionEfforts.get(key);
    if (override !== undefined) return override === 'default' ? (model.defaultReasoningEffort ?? null) : override;
    const stored = this.ports.settings.read().reasoningPreferences?.[accountId + ':' + model.id];
    return stored && model.reasoningEfforts?.includes(stored) ? stored : (model.defaultReasoningEffort ?? null);
  }
  setReasoningEffort(value: string, options?: {scope: 'session'}): void {
    if (options?.scope !== undefined && options.scope !== 'session') throw new FutrynError('INVALID_INPUT');
    if (this.sending) throw new FutrynError('POLICY');
    const status = this.status();
    const model = status.activeModel;
    const account = status.activeAccount;
    if (!model || !account) throw new FutrynError('UNSUPPORTED');
    if (value !== 'default') {
      if (!model.reasoningEfforts?.length || model.capabilities.reasoning === 'unsupported') {
        const protocol = status.activeProvider?.protocol;
        if (
          protocol === 'anthropic' ||
          protocol === 'gemini' ||
          protocol === 'vertex' ||
          protocol === 'vertex-anthropic'
        )
          throw new FutrynError(
            'UNSUPPORTED',
            false,
            null,
            protocol === 'vertex-anthropic' ? 'anthropic' : protocol === 'vertex' ? 'gemini' : protocol,
            model.capabilities.reasoning === 'supported' ? 'mapping' : model.capabilities.reasoning,
          );
        throw new FutrynError('UNSUPPORTED', false, null, 'levels');
      }
      if (!model.reasoningEfforts.includes(value)) throw new FutrynError('INVALID_INPUT');
    }
    const sessionKey = `${this.currentSession?.id ?? 'pending'}:${account.id}:${model.id}`;
    if (options?.scope === 'session') {
      this.sessionEfforts.set(sessionKey, value);
      this.notifyStateChange();
      return;
    }
    this.sessionEfforts.delete(sessionKey);
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
        (!source ? catalog.models.find(m => isCodingModel(m)) : undefined));
    if (!model) throw new FutrynError('NOT_FOUND');
    const selection = {accountId: target.id, modelId: model.id};
    if (continueHistory && source && this.ports.setSessionSelection) {
      const updated = this.ports.setSessionSelection(source.id, selection);
      try {
        this.ports.selectModel(target, model);
      } catch (error) {
        try {
          this.ports.setSessionSelection(source.id, source.selection);
        } catch {
          /* preserve primary error */
        }
        throw error;
      }
      this.sessionSelection = null;
      this.clearSessionAuthorization();
      this.currentSession = {...updated, title: source.title};
      this.lastUsage = null;
      this.emitReactiveEvent('idle', 'Account switched');
      this.notifyStateChange();
      return target;
    }
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
    this.sessionSelection = null;
    this.clearSessionAuthorization();
    this.currentSession = fork;
    this.lastUsage = null;
    this.emitReactiveEvent('idle', 'Account switched');
    this.notifyStateChange();
    return target;
  }

  private projectAppearance: PartialAppearanceConfig | undefined;
  private sessionPreferences: UserPreferences = {...DEFAULT_USER_PREFERENCES};

  userPreferences(): UserPreferences {
    return {...(this.ports.userPreferencesStore?.readPreferences() ?? this.sessionPreferences)};
  }

  updateUserPreferences(patch: Partial<UserPreferences>): UserPreferences {
    if (this.ports.userPreferencesStore) this.ports.userPreferencesStore.writePreferences(patch);
    else this.sessionPreferences = {...this.sessionPreferences, ...patch};
    this.notifyStateChange();
    return this.userPreferences();
  }

  onboardingState() {
    return this.ports.appearanceStore?.onboardingState?.();
  }

  completeOnboardingStep(id: string): void {
    this.ports.appearanceStore?.completeOnboardingStep?.(id);
  }

  private sessionEditorMode: EditorMode = 'normal';
  private readonly editorModeListeners = new Set<() => void>();

  editorMode(): EditorMode {
    return this.ports.appearanceStore?.readEditorMode?.() ?? this.sessionEditorMode;
  }

  setEditorMode(mode: EditorMode): void {
    if (mode !== 'normal' && mode !== 'vim') throw new TypeError('Invalid editor mode.');
    if (this.editorMode() === mode) return;
    this.ports.appearanceStore?.writeEditorMode?.(mode);
    this.sessionEditorMode = mode;
    for (const listener of this.editorModeListeners) listener();
  }

  subscribeEditorMode(listener: () => void): () => void {
    this.editorModeListeners.add(listener);
    return () => this.editorModeListeners.delete(listener);
  }

  appearanceNotices(): readonly string[] {
    return this.ports.appearanceStore?.notices?.() ?? [];
  }

  // Appearance & Custom Themes
  getAppearance(projectScoped = true): AppearanceConfig {
    const state = this.ports.settings.read();
    const base = this.ports.appearanceStore?.read() ?? state.appearance ?? defaultAppearance();
    if (!projectScoped) return appearanceSchema.parse(base);
    const projectOverride = this.ports.appearanceStore
      ? this.projectAppearance
      : state.projectAppearances?.[this.ports.workspace];
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
    if (this.ports.appearanceStore) {
      if (scope === 'global') this.ports.appearanceStore.write(validatedPatch);
      else
        this.projectAppearance = partialAppearanceSchema.parse({
          ...this.projectAppearance,
          ...validatedPatch,
          animations: {...this.projectAppearance?.animations, ...validatedPatch.animations},
        });
      this.notifyStateChange();
      return this.getAppearance(true);
    }
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

  getWorkspaceDiff(options: WorkspaceDiffOptions = {}): WorkspaceDiffReport {
    options = {base: options.base ?? 'session'};
    if (!this.toolsAllowed)
      return {
        workspace: this.workspace(),
        gitAvailable: false,
        state: 'denied',
        message: 'Folder consent required.',
        base: options.base,
        capabilities: {
          session: {available: false, reason: 'Folder consent required.'},
          uncommitted: {available: false, reason: 'Folder consent required.'},
          branch: {available: false, reason: 'Folder consent required.'},
        },
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };
    return structuredClone(this.ports.getWorkspaceDiff(options));
  }

  async refreshWorkspaceDiff(options: WorkspaceDiffOptions = {}): Promise<WorkspaceDiffReport> {
    options = {base: options.base ?? 'session'};
    if (!this.toolsAllowed) return this.getWorkspaceDiff(options);
    const report = await (this.ports.refreshWorkspaceDiff
      ? this.ports.refreshWorkspaceDiff(options)
      : this.ports.getWorkspaceDiff(options));
    if (!this.toolsAllowed) return this.getWorkspaceDiff(options);
    return structuredClone(report);
  }

  /**
   * Diff files as `/code-review` (alias `/review`) may send them to the model. Content of a file the read policy would deny
   * or ask about (secrets, Git internals, Cosmew state) is withheld so review never bypasses the
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
    commandSandbox?: PermissionPromptRequest['commandSandbox'];
    diffPreview?: string;
    ttlMs?: number;
    scopeKey?: string;
    /** Approvals this prompt offers (Codex `available_decisions`); default once + session. */
    decisions?: PermissionPromptRequest['decisions'];
    /** The project Allow rule `always` saves; without it `always` is not offered. */
    alwaysRule?: string;
    /** Subagent attribution when the request comes from a nested subagent (Wave 2 S5a). */
    subagent?: SubagentPromptAttribution;
  }): PermissionPromptRequest {
    const now = new Date();
    const domainRule =
      input.capability === 'network.connect' &&
      input.alwaysRule?.startsWith('domain:') &&
      DOMAIN_PATTERN.test(input.alwaysRule.slice(7));
    const rule = input.alwaysRule && (domainRule || isSafeAlwaysRule(input.alwaysRule)) ? input.alwaysRule : undefined;
    // A settings trust prompt saves a content hash, not a rule, so it offers `always` without one.
    const offered = (input.decisions ?? ['once', 'session']).filter(
      decision => decision !== 'always' || rule || input.capability === 'settings.trust',
    );
    const expires = new Date(now.getTime() + (input.ttlMs ?? 300_000));
    const scopeHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.capability,
          input.action,
          input.target,
          ...(input.scopeKey ? [input.scopeKey] : []),
          // Subagents inherit only `fs.read` session grants from the parent (Wave 2 S5a).
          ...(input.subagent && input.capability !== 'fs.read' ? [`subagent:${input.subagent.agentId}`] : []),
        ]),
      )
      .digest('hex');
    const req = permissionPromptRequestSchema.parse({
      approvalId: crypto.randomUUID(),
      capability: input.capability,
      action: this.ports.sanitizeText(input.action),
      target: this.ports.sanitizeText(input.target),
      riskLevel: input.riskLevel ?? 'medium',
      reason: this.ports.sanitizeText(input.reason),
      ...(input.commandSandbox ? {commandSandbox: input.commandSandbox} : {}),
      scopeHash: scopeHash.length >= 8 ? scopeHash : scopeHash.padEnd(8, '_'),
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      diffPreview: input.diffPreview ? this.ports.sanitizeText(input.diffPreview) : undefined,
      decisions: offered.length ? offered : ['once'],
      ...(rule && offered.includes('always') ? {alwaysRule: this.ports.sanitizeText(rule)} : {}),
      ...(input.subagent
        ? {
            subagent: {
              agentId: input.subagent.agentId,
              agentType: this.ports.sanitizeText(input.subagent.agentType),
              description: this.ports.sanitizeText(input.subagent.description),
            },
          }
        : {}),
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
    const trust = this.trustPrompts.get(approvalId);
    if (decision === 'always' && !trust) {
      // Persist the Allow rule (or allowed domain) first: if it cannot be saved nothing is approved.
      if (!req.alwaysRule) throw new FutrynError('POLICY');
      if (req.capability === 'network.connect' && req.alwaysRule.startsWith('domain:')) {
        const domain = req.alwaysRule.slice(7);
        if (!DOMAIN_PATTERN.test(domain)) throw new FutrynError('POLICY');
        this.settingsPort.addAllowedDomain('local', domain);
      } else {
        if (!isSafeAlwaysRule(req.alwaysRule)) throw new FutrynError('POLICY');
        this.addPermissionRule('allow', req.alwaysRule);
      }
    }
    req.status =
      decision === 'once'
        ? 'approved_once'
        : decision === 'session'
          ? 'approved_session'
          : decision === 'always'
            ? 'approved_always'
            : 'denied';
    if (decision === 'session' && !trust) {
      this.sessionGrants.set(req.scopeHash, req.capability);
    }
    if (trust) {
      this.trustPrompts.delete(approvalId);
      if (decision === 'always' || decision === 'session')
        this.settingsPort.trust(trust.path, trust.hash, decision === 'always');
      this.notifyStateChange();
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
   * Decide one request (ADR 0061): deny rules, then `plan` (refuses writes and execution), then
   * ask/allow rules, then the permission mode; whatever remains `ask` goes to the user, who
   * resolves 'deny' when the prompt is dismissed, expires, the session is cleared or `signal`
   * aborts, so a waiting tool call can never hang or be granted by accident.
   */
  requestPermission(
    input: {
      capability: PermissionPromptRequest['capability'];
      action: string;
      target: string;
      reason: string;
      riskLevel?: PermissionPromptRequest['riskLevel'];
      commandSandbox?: PermissionPromptRequest['commandSandbox'];
      scopeKey?: string;
      diffPreview?: string;
      kind?: PermissionKind;
      /** Ask even in acceptEdits. External command cwd also asks in bypass while sandboxing remains enabled. */
      requiresApproval?: boolean;
      /** Approvals offered (ADR 0055); default once + session. */
      decisions?: PermissionPromptRequest['decisions'];
      /** The rule (or `domain:host`) an `always` answer saves. */
      alwaysRule?: string;
      /** Rule namespace judging this request. Defaults to the tool of the capability. */
      ruleTool?: PermissionRuleTool;
      /** Exact structured command/path for rules; null skips rules (display-only request). Defaults to `target`. */
      ruleTarget?: string | null;
      /** Bash: parsed sub-commands for rules, or null for an unparsed script (ADR 0040). */
      ruleSegments?: string[] | null;
      /** Allow rules never answer this request (an escape from the sandbox); deny and ask rules still do. */
      ignoreAllowRules?: boolean;
      /** Subagent attribution when the request comes from a nested subagent (Wave 2 S5a). */
      subagent?: SubagentPromptAttribution;
    },
    signal?: AbortSignal,
  ): Promise<PermissionResolutionScope> {
    if (signal?.aborted) return Promise.resolve('deny');
    this.reviewSettingsTrust();
    // The mode answers only what policy left as `ask`; a fs.read that reaches here is a secret file.
    const {
      kind: explicitKind,
      ruleTarget,
      ruleSegments,
      ruleTool,
      ignoreAllowRules,
      requiresApproval,
      ...prompt
    } = input;
    const kind: PermissionKind =
      explicitKind ??
      (
        {'fs.read': 'secret', 'fs.write': 'edit', 'process.execute': 'command', 'network.connect': 'network'} as Record<
          string,
          PermissionKind
        >
      )[input.capability] ??
      'other';
    const tool: PermissionRuleTool =
      ruleTool ??
      (
        {
          'process.execute': 'Bash',
          'fs.write': 'Edit',
          'fs.read': 'Read',
          'network.connect': 'WebFetch',
          'network.search': 'WebSearch',
          'mcp.call': 'Mcp',
        } as Record<string, PermissionRuleTool>
      )[input.capability] ??
      'Tool';
    const commandRule = COMMAND_RULE_TOOLS.includes(tool);
    // Allow rules judge only structured targets (a real command or real paths), never display labels.
    const rules = this.permissionRules();
    const judged: PermissionRuleSet = ignoreAllowRules ? {allow: [], ask: rules.ask, deny: rules.deny} : rules;
    const target =
      ruleTarget === null || (tool === 'Tool' && ruleTarget === undefined) ? null : (ruleTarget ?? input.target);
    const relative = (value: string) => (tool === 'Read' || tool === 'Edit' ? this.workspaceRelative(value) : value);
    let ruled: PermissionRuleEffect | undefined;
    if (target !== null) {
      ruled = permissionRuleDecision(judged, {
        tool,
        target: relative(target),
        ...(commandRule && ruleSegments !== undefined ? {segments: ruleSegments} : {}),
      });
    } else {
      // Fail closed: deny/ask rules still apply to the best text we have, and an unverifiable request
      // never slips past a deny/ask rule of its tool through a permissive mode such as bypass.
      ruled =
        permissionRuleDecision({allow: [], ask: rules.ask, deny: rules.deny}, {tool, target: relative(input.target)}) ??
        ([...rules.deny, ...rules.ask].some(rule => rule === tool || rule.startsWith(tool + '(')) ? 'ask' : undefined);
    }
    // Rules saved before `WebSearch` existed name the tool as `Tool(web_search)`; they keep working.
    if (input.capability === 'network.search' && target !== null)
      ruled = strongest(ruled, permissionRuleDecision(judged, {tool: 'Tool', target: 'web_search'}));
    const mode = this.permissionModeValue;
    const explicitCommandApproval =
      input.capability === 'process.execute' &&
      requiresApproval &&
      ignoreAllowRules &&
      input.commandSandbox !== 'disabled';
    let decision: 'allow' | 'ask' | 'deny';
    if (ruled === 'deny') decision = 'deny';
    // Plan mode refuses writes and execution whatever an allow rule says.
    else if (mode === 'plan' && PLAN_REFUSED_KINDS.has(kind)) decision = 'deny';
    else if (explicitCommandApproval) decision = 'ask';
    else {
      decision = ruled ?? (requiresApproval ? 'ask' : permissionModeDecision(mode, kind));
      if (decision === 'ask' && mode === 'bypassPermissions' && ruled !== 'ask') decision = 'allow';
    }
    if (decision !== 'ask') {
      this.emitReactiveEvent(
        decision === 'allow' ? 'done' : 'error',
        `Permission ${decision === 'allow' ? 'approved' : 'denied'} by ${ruled ? 'rule' : `${mode} mode`}: ${input.action}`,
      );
      return Promise.resolve(decision === 'allow' ? 'once' : 'deny');
    }
    if (!this.promptsAvailable) return Promise.resolve('deny');
    return this.askPermission(prompt, signal);
  }

  /** Show the prompt and wait for the answer; never auto-resolved by the mode. */
  private askPermission(
    input: Parameters<FutrynClient['enqueuePermissionRequest']>[0],
    signal?: AbortSignal,
  ): Promise<PermissionResolutionScope> {
    if (signal?.aborted) return Promise.resolve('deny');
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
        this.trustPrompts.delete(request.approvalId);
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
   * The sandbox network gate (ADR 0061): may a command reach this host? Deny rules and `plan` refuse;
   * `sandbox.network.allowedDomains`, `WebFetch(domain:...)` allow rules and session answers allow;
   * anything else asks (bypassPermissions allows, a headless run denies). `always` saves the domain
   * to `sandbox.network.allowedDomains` of the local settings.
   */
  authorizeNetwork(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
    const name = host.toLowerCase().replace(/\.$/, '');
    const snapshot = this.settingsPort.snapshot();
    const verdict = permissionRuleDecision(snapshot.rules, {tool: 'WebFetch', target: name});
    if (verdict === 'deny' || this.permissionModeValue === 'plan') return Promise.resolve(false);
    if (verdict !== 'ask' && (verdict === 'allow' || domainAllowed(name, snapshot.sandbox.allowedDomains)))
      return Promise.resolve(true);
    const cached = this.networkOnce.get(name);
    if (cached && Date.now() - cached.at < NETWORK_ANSWER_TTL_MS) return Promise.resolve(cached.allowed);
    const pending = this.networkAsks.get(name);
    if (pending) return pending;
    const ask = this.requestPermission(
      {
        capability: 'network.connect',
        kind: 'network',
        action: `Allow network access to ${name}`,
        target: `${name}:${port}`,
        reason:
          'A sandboxed command is connecting to this host through the Cosmew proxy. "Always" saves it to sandbox.network.allowedDomains of the local settings.',
        riskLevel: 'medium',
        scopeKey: `network:${name}`,
        decisions: ['once', 'session', 'always'],
        alwaysRule: `domain:${name}`,
        ruleTool: 'WebFetch',
        ruleTarget: name,
      },
      signal,
    )
      .then(answer => {
        const allowed = answer !== 'deny';
        if (answer === 'once' || answer === 'deny') this.networkOnce.set(name, {allowed, at: Date.now()});
        return allowed;
      })
      .finally(() => this.networkAsks.delete(name));
    this.networkAsks.set(name, ask);
    return ask;
  }

  /** Approve a pending repository settings file after the user reviewed it (`/permissions`). */
  approvePendingSettings(path: string, persist: boolean): void {
    const pending = this.settingsPort.snapshot().pendingTrust.find(entry => entry.path === path);
    if (!pending) throw new FutrynError('NOT_FOUND');
    this.settingsPort.trust(pending.path, pending.hash, persist);
    this.notifyStateChange();
  }

  /**
   * Whether anyone can answer a prompt. A headless run without a TTY turns it off: whatever would
   * ask is denied at once, without a `permission.requested` event (like `claude -p`).
   */
  setPromptsAvailable(available: boolean): void {
    this.promptsAvailable = available;
  }

  /** Headless runs never ask about repository settings; they stay untrusted (loosening ignored). */
  setSettingsTrustPrompts(enabled: boolean): void {
    this.trustPromptsEnabled = enabled;
  }

  /**
   * Offer every repository settings file that would loosen something, once per exact content
   * (ADR 0061). The user's answer is the only way it takes effect: `session` or `always` (saved by
   * content hash); a changed file hashes differently and is asked again.
   */
  reviewSettingsTrust(): void {
    if (!this.toolsAllowed || !this.trustPromptsEnabled) return;
    for (const pending of this.settingsPort.snapshot().pendingTrust) {
      const key = `${pending.path}\0${pending.hash}`;
      if (this.trustOffered.has(key)) continue;
      this.trustOffered.add(key);
      const grants = pending.grants.join('; ');
      const request = this.enqueuePermissionRequest({
        capability: 'settings.trust',
        action: `Trust repository ${pending.scope} settings`,
        target: pending.path,
        reason: `Repository settings are untrusted until you approve them. This file would: ${grants}`.slice(0, 400),
        riskLevel: 'high',
        scopeKey: `settings:${pending.hash}`,
        decisions: ['session', 'always'],
      });
      this.trustPrompts.set(request.approvalId, {path: pending.path, hash: pending.hash});
    }
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

/** The stricter of two rule verdicts (deny > ask > allow). */
function strongest(
  a: PermissionRuleEffect | undefined,
  b: PermissionRuleEffect | undefined,
): PermissionRuleEffect | undefined {
  const rank = {deny: 3, ask: 2, allow: 1} as const;
  return (a ? rank[a] : 0) >= (b ? rank[b] : 0) ? a : b;
}

/** Kinds `plan` mode refuses outright (ADR 0061). */
const PLAN_REFUSED_KINDS: ReadonlySet<PermissionKind> = new Set([
  'edit',
  'sandboxed-command',
  'command',
  'escalation',
  'network',
]);
/** A once/deny answer about a host is remembered this long so a command's connections do not re-prompt. */
const NETWORK_ANSWER_TTL_MS = 30_000;

/** Parse `/mcp__<server>__<prompt> [args]` into qualified name and raw argument tail. */
function parseMcpPromptSlash(raw: string): {qualifiedName: string; rawArgs: string} | null {
  const trimmed = raw.trim();
  const match = /^\/(mcp__[A-Za-z0-9_-]{1,32}__[A-Za-z0-9_-]{1,64})(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return {qualifiedName: match[1]!, rawArgs: (match[2] ?? '').trim()};
}

function tokenizePromptArgs(rawArgs: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const ch = rawArgs[i]!;
    if (quote) {
      if (ch === '\\' && i + 1 < rawArgs.length) {
        current += rawArgs[++i]!;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) {
    const err = new FutrynError('INVALID_INPUT');
    err.message = 'Unterminated quote in MCP prompt arguments.';
    throw err;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function bindMcpPromptArguments(prompt: McpPromptView, rawArgs: string): Record<string, string> {
  const tokens = rawArgs ? tokenizePromptArgs(rawArgs) : [];
  const declared = new Set(prompt.arguments.map(arg => arg.name));
  const bound: Record<string, string> = {};
  const positional: string[] = [];
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (declared.has(key) || (prompt.arguments.length === 0 && /^[A-Za-z0-9_.-]{1,64}$/.test(key))) {
        bound[key] = value;
        continue;
      }
    }
    positional.push(token);
  }
  const remaining = prompt.arguments.filter(arg => !Object.hasOwn(bound, arg.name));
  for (let i = 0; i < positional.length && i < remaining.length; i++) {
    const arg = remaining[i]!;
    bound[arg.name] = i === remaining.length - 1 ? positional.slice(i).join(' ') : positional[i]!;
  }
  const missing = prompt.arguments.filter(arg => arg.required && !bound[arg.name]?.trim());
  if (missing.length) {
    const usageArgs = prompt.arguments.map(a => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
    const err = new FutrynError('INVALID_INPUT');
    err.message = `Missing required argument(s) (${missing.map(m => m.name).join(', ')}). Usage: /${prompt.qualifiedName} ${usageArgs}`;
    throw err;
  }
  return bound;
}

/** In-memory settings for a client built without files (tests, embedding): no trust, no persistence. */
function memoryPermissionSettings(): PermissionSettingsPort {
  const scopes = PERMISSION_SETTINGS_SCOPES;
  const files = new Map<PermissionSettingsScope, {rules: PermissionRuleSet; domains: string[]}>(
    scopes.map(scope => [scope, {rules: {allow: [], ask: [], deny: []}, domains: []}]),
  );
  const sandbox = {
    enabled: false,
    autoAllowBashIfSandboxed: false,
    excludedCommands: [] as string[],
    allowUnsandboxedCommands: true,
  };
  const additionalDirectories: string[] = [];
  return {
    updateSandbox(patch) {
      for (const key of ['enabled', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands'] as const)
        if (patch[key] !== undefined) sandbox[key] = patch[key];
      if (patch.excludeCommand && !sandbox.excludedCommands.includes(patch.excludeCommand))
        sandbox.excludedCommands.push(patch.excludeCommand);
    },
    addAdditionalDirectory(directory) {
      const trimmed = directory.trim();
      if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) throw new FutrynError('INVALID_INPUT');
      if (trimmed.split(/[\\/]+/).includes('.git')) throw new FutrynError('POLICY');
      if (!additionalDirectories.includes(trimmed)) additionalDirectories.push(trimmed);
      return trimmed;
    },
    snapshot() {
      const union = (pick: (rules: PermissionRuleSet) => string[]) => [
        ...new Set(scopes.flatMap(scope => pick(files.get(scope)!.rules))),
      ];
      return {
        rules: {allow: union(r => r.allow), ask: union(r => r.ask), deny: union(r => r.deny)},
        additionalDirectories: [...additionalDirectories],
        sandbox: {
          ...sandbox,
          excludedCommands: [...sandbox.excludedCommands],
          allowedDomains: [...new Set(scopes.flatMap(scope => files.get(scope)!.domains))],
        },
        files: scopes.map(scope => ({
          scope,
          path: `(memory)/${scope}`,
          exists: true,
          trusted: true,
          rules: structuredClone(files.get(scope)!.rules),
          allowedDomains: [...files.get(scope)!.domains],
          diagnostics: [],
        })),
        pendingTrust: [],
        diagnostics: [],
      };
    },
    addRule(scope, effect, rule) {
      const set = files.get(scope)!.rules;
      for (const key of ['allow', 'ask', 'deny'] as const) set[key] = set[key].filter(entry => entry !== rule);
      if (set[effect].length >= 200) throw new FutrynError('POLICY');
      set[effect].push(rule);
    },
    removeRule(scope, effect, rule) {
      const set = files.get(scope)!.rules;
      set[effect] = set[effect].filter(entry => entry !== rule);
    },
    addAllowedDomain(scope, domain) {
      const domains = files.get(scope)!.domains;
      if (!domains.includes(domain)) domains.push(domain);
    },
    trust() {},
  };
}

export {FutrynClient as HannesClient};
