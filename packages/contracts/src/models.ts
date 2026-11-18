import {turnBudgetSchema} from './telemetry';
import {permissionRuleSetSchema} from './permissions';
import {z} from 'zod';
import {attachmentSchema} from './tools';

export const CONTRACT_VERSION = '1.34' as const;
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const themeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform(v => v.toLowerCase());
export const modelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w~./:@+-]+$/);
export const protocolSchema = z.enum(['chat', 'responses', 'anthropic', 'gemini']);
export const envNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/);
/** HTTP header name (RFC 9110 token); credentials never travel in static headers (ADR 0046). */
export const headerNameSchema = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/);
export const providerSchema = z.strictObject({
  id: idSchema,
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  protocol: protocolSchema,
  baseURL: z.string().url().max(2048),
  /** `command`: a bearer token printed by a user-configured command (host config only, ADR 0046). `oauth`: an access token the sign-in flow refreshes (ADR 0047). */
  auth: z.enum(['api-key', 'none', 'command', 'oauth']),
  catalog: z.enum(['openai', 'anthropic', 'gemini', 'ollama', 'manual']),
  metadataVersion: z.literal(1),
  /** Metadata requests. Model streams use `streamIdleTimeoutMs`. */
  timeoutMs: z.number().int().min(100).max(300000).default(60000),
  /** Silence allowed in a model stream (Codex stream_idle_timeout_ms); default GENERATION_LIMITS. Contract 1.17. */
  streamIdleTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  streamUsage: z.boolean().optional(),
  family: idSchema.optional(),
  /** Declared in the user-level host config (~/.futryn/config.toml), the source of truth for it. Contract 1.20. */
  source: z.literal('config').optional(),
  /** Environment variable that conventionally holds the API key (Codex `env_key`). */
  envKey: envNameSchema.optional(),
  envKeyInstructions: z
    .string()
    .max(500)
    .regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/)
    .optional(),
  /** Appended to every request URL (Codex `query_params`); never credentials. */
  queryParams: z
    .record(z.string().min(1).max(100), z.string().max(500))
    .refine(v => Object.keys(v).length <= 20)
    .optional(),
  /** Static request headers (Codex `http_headers`); never credentials. */
  httpHeaders: z
    .record(headerNameSchema, z.string().max(500))
    .refine(v => Object.keys(v).length <= 20)
    .optional(),
  /** Header name -> environment variable holding its value (Codex `env_http_headers`); skipped when unset. */
  envHttpHeaders: z
    .record(headerNameSchema, envNameSchema)
    .refine(v => Object.keys(v).length <= 20)
    .optional(),
  /** Codex `request_max_retries` / `stream_max_retries` (hard cap 100). */
  requestMaxRetries: z.number().int().min(0).max(100).optional(),
  streamMaxRetries: z.number().int().min(0).max(100).optional(),
  /** Same-origin catalog URL under the base URL (Codex `model_catalog_url`). */
  modelCatalogURL: z.string().url().max(2048).optional(),
  /** Hand-written model list for gateways that do not serve /models. */
  models: z.array(modelIdSchema).max(500).optional(),
  /** Compress large request bodies with zstd (ChatGPT sign-in rejects uncompressed bodies over ~1 MiB, ADR 0047). */
  requestEncoding: z.literal('zstd').optional(),
  /** Send the assistant's earlier reasoning back as `reasoning_content` (DeepSeek, ADR 0048). */
  replayReasoning: z.boolean().optional(),
});
export type Provider = z.infer<typeof providerSchema>;

/** Registry metadata is introduced in contract 1.1; no credential bytes cross this boundary. */
export interface AuthMethod {
  id: 'api-key' | 'env' | 'none' | 'openrouter-oauth' | 'oauth-browser';
  name: string;
  description: string;
  providerId?: string;
  advanced?: boolean;
  available?: boolean;
  diagnostic?: string;
  autoComplete?: boolean;
}
export interface ProviderAuthChallenge {
  id: string;
  authorizationURL: string;
  expiresAt: string;
  autoComplete?: boolean;
  userCode?: string;
  message?: string;
}
export interface ProviderAuthProgress {
  state: 'pending' | 'ready' | 'failed';
  authorizationURL?: string;
  userCode?: string;
  message?: string;
}
export interface Integration {
  provider: Provider;
  providerIds?: string[];
  methods: AuthMethod[];
  notice: string;
}

export const credentialRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('keyring'), key: z.string().uuid()}),
  z.strictObject({kind: z.literal('env'), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/)}),
  z.strictObject({kind: z.literal('none')}),
]);
export type CredentialRef = z.infer<typeof credentialRefSchema>;
export const accountSchema = z.strictObject({
  id: z.string().uuid(),
  providerId: idSchema,
  alias: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  credential: credentialRefSchema,
  status: z.enum(['unvalidated', 'valid', 'invalid', 'logged-out']),
  validatedAt: z.string().datetime().nullable(),
  defaultModel: modelIdSchema.optional(),
  authGeneration: z.number().int().positive().optional(),
});
export type Account = z.infer<typeof accountSchema>;
const capability = z.enum(['supported', 'unsupported', 'unknown']);
export const capabilitiesSchema = z.strictObject({
  text: capability.default('unknown'),
  tools: capability.default('unknown'),
  streaming: capability.default('unknown'),
  vision: capability.default('unknown'),
  reasoning: capability.default('unknown'),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const modelSchema = z.strictObject({
  id: modelIdSchema,
  name: z.string().min(1).max(300),
  capabilities: capabilitiesSchema,
  reasoningEfforts: z.array(z.string().min(1).max(40)).max(20).optional(),
  defaultReasoningEffort: z.string().max(40).optional(),
  contextLimit: z.number().int().positive().nullable(),
  outputLimit: z.number().int().positive().nullable(),
  pricing: z
    .strictObject({
      inputPerMillion: z.number().nonnegative(),
      outputPerMillion: z.number().nonnegative(),
      currency: z.literal('USD'),
    })
    .nullable(),
  source: z.enum(['provider', 'manual']),
  fetchedAt: z.string().datetime(),
  metadataSource: z.string().max(2048).nullable(),
  metadataFetchedAt: z.string().datetime().nullable(),
});
export type ModelInfo = z.infer<typeof modelSchema>;
export const selectionSchema = z.strictObject({accountId: z.string().uuid(), modelId: modelIdSchema});
export type Selection = z.infer<typeof selectionSchema>;
export const toolCallSchema = z.strictObject({id: z.string().min(1).max(200), name: idSchema, input: z.unknown()});
/**
 * Conversation message. `assistant` may carry `toolCalls` (then `content` may be empty);
 * `tool` carries one tool result for `toolCallId`. Plain user/assistant text messages are
 * unchanged, so stored sessions from before tool support still parse.
 */
export const messageSchema = z
  .strictObject({
    role: z.enum(['user', 'assistant', 'tool']),
    // No size ceilings (Codex): the context window bounds history.
    content: z.string(),
    toolCalls: z.array(toolCallSchema).min(1).optional(),
    toolCallId: z.string().min(1).max(200).optional(),
    toolName: idSchema.optional(),
    /** Assistant messages with tool calls: the model's reasoning, sent back only to providers that require it (ADR 0048). */
    reasoning: z.string().optional(),
    /** Tool messages only: media the tool returned (ADR 0041). Never persisted in the message row. */
    attachments: z.array(attachmentSchema).max(8).optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string) => ctx.addIssue({code: 'custom', message});
    if (m.attachments && m.role !== 'tool') issue('only tool messages carry attachments');
    if (m.reasoning !== undefined && m.role !== 'assistant') issue('only assistant messages carry reasoning');
    if (m.role === 'tool') {
      if (!m.toolCallId || !m.toolName || m.toolCalls) issue('tool message needs toolCallId and toolName only');
    } else {
      if (m.toolCallId || m.toolName) issue('only tool messages carry toolCallId/toolName');
      if (m.role === 'user' && (m.toolCalls || !m.content)) issue('user message needs text and no tool calls');
      if (m.role === 'assistant' && !m.content && !m.toolCalls) issue('assistant message needs text or tool calls');
    }
  });
export type Message = z.infer<typeof messageSchema>;
export const requestSchema = z.strictObject({
  requestId: z.string().uuid(),
  modelId: modelIdSchema,
  // No message-count ceiling (ADR 0030): the context window, checked by the agent loop, bounds history.
  messages: z.array(messageSchema).min(1).max(100000),
  /** Absent: no cap is sent (Codex); the provider uses the model's own output limit. */
  maxOutputTokens: z.number().int().min(1).optional(),
  reasoningEffort: z.string().min(1).max(40).optional(),
  maxEstimatedCostUSD: z.number().positive().max(1000).optional(),
  tools: z
    .array(
      z.strictObject({
        name: idSchema,
        description: z.string().max(2000),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(32)
    .default([]),
  /**
   * Host guidance (ADR 0020) plus explicitly labeled untrusted skill metadata (ADR 0056). Adapters place it in the
   * provider's system/developer channel; it is not stored with the conversation.
   */
  instructions: z.string().min(1).max(32768).optional(),
  /**
   * Opaque conversation identifier for provider prompt caching. Adapters hash it before it leaves
   * the process; it is never a secret and carries no user text.
   */
  cacheKey: z.string().min(1).max(200).optional(),
});
export type ModelRequest = z.infer<typeof requestSchema>;
export type Usage = z.infer<typeof import('./telemetry').usageSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
/** What one compaction did to the model-visible context. Durable history is never changed. */
export interface ContextCompaction {
  trigger: 'auto' | 'manual';
  /** `model`: handoff summary written by the current model; `excerpt`: deterministic fallback. */
  strategy: 'model' | 'excerpt';
  /** Estimated model-visible tokens before and after (conservative estimate, not provider-measured). */
  tokensBefore: number;
  tokensAfter: number;
  /** True when the model summary failed and the excerpt checkpoint was used instead. */
  fallback?: boolean;
}
export type ModelEvent =
  | {type: 'started'; requestId: string}
  | {type: 'textDelta'; text: string}
  | {type: 'reasoningDelta'; text: string}
  | {type: 'usage'; usage: Usage}
  | {type: 'context'; context: import('./telemetry').ContextMeasurement}
  | {type: 'toolCallComplete'; call: ToolCall}
  | {type: 'toolOutputDelta'; callId: string; name: string; stream: 'stdout' | 'stderr'; text: string}
  | {type: 'toolResult'; result: import('./tools').ToolResult}
  /** Steering input accepted during the turn was delivered to model-visible history before the next request. */
  | {type: 'steered'; steerId: string; content: string}
  /**
   * `endTurn: false` is a provider statement that the turn is not over (Codex `Completed { end_turn }`;
   * Anthropic `pause_turn`). Absent means the provider exposed no such signal.
   */
  | {type: 'completed'; finishReason: string; usage: Usage; endTurn?: boolean}
  /** Streamed text/reasoning of the current response is void: it is being retried or was preempted by steering. */
  | {type: 'responseDiscarded'; reason: 'retry' | 'preempted'; attempt?: number; maxRetries?: number}
  /** Accepted steering the turn could not deliver (budget, context or interruption); it opens the next turn. */
  | {type: 'inputDeferred'; steerIds: string[]; reason: string}
  /** Older history was replaced by a handoff summary (or, as a fallback, an excerpt checkpoint). ADR 0054. */
  | ({type: 'context.compacted'} & ContextCompaction)
  /** Subagent lifecycle and progress events (Wave 2 S5). */
  | import('./subagents').SubagentEvent;
/** A provider API adapter: Futryn sends the request and reads the response; it owns the loop and tools. */
export interface ModelPort {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  generate(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<{text: string; calls: ToolCall[]; usage: Usage; finishReason: string}>;
}
export interface CredentialVault {
  get(ref: CredentialRef): Promise<string | undefined>;
  set(key: string, secret: string): Promise<void>;
  delete(ref: CredentialRef): Promise<void>;
}
export interface NetworkPolicy {
  authorize(provider: Provider, account: Account): void;
}
export const cacheSchema = z.strictObject({
  accountId: z.string().uuid(),
  providerFingerprint: z.string(),
  fetchedAt: z.string().datetime(),
  models: z.array(modelSchema).max(10000),
});

export const THEME_TOKEN_KEYS = [
  'background',
  'backgroundPanel',
  'backgroundElevated',
  'foreground',
  'foregroundMuted',
  'foregroundSubtle',
  'accent',
  'accentForeground',
  'border',
  'borderFocused',
  'selection',
  'selectionForeground',
  'cursor',
  'error',
  'warning',
  'success',
  'info',
  'diffAdded',
  'diffRemoved',
  'diffContext',
  'syntaxKeyword',
  'syntaxString',
  'syntaxComment',
  'syntaxFunction',
  'markdownHeading',
  'markdownCode',
  'scrollbar',
  'composerBackground',
  'sidebarBackground',
  'overlayBackground',
] as const;
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

export const themeTokensSchema = z.strictObject({
  background: hexColorSchema,
  backgroundPanel: hexColorSchema,
  backgroundElevated: hexColorSchema,
  foreground: hexColorSchema,
  foregroundMuted: hexColorSchema,
  foregroundSubtle: hexColorSchema,
  accent: hexColorSchema,
  accentForeground: hexColorSchema,
  border: hexColorSchema,
  borderFocused: hexColorSchema,
  selection: hexColorSchema,
  selectionForeground: hexColorSchema,
  cursor: hexColorSchema,
  error: hexColorSchema,
  warning: hexColorSchema,
  success: hexColorSchema,
  info: hexColorSchema,
  diffAdded: hexColorSchema,
  diffRemoved: hexColorSchema,
  diffContext: hexColorSchema,
  syntaxKeyword: hexColorSchema,
  syntaxString: hexColorSchema,
  syntaxComment: hexColorSchema,
  syntaxFunction: hexColorSchema,
  markdownHeading: hexColorSchema,
  markdownCode: hexColorSchema,
  scrollbar: hexColorSchema,
  composerBackground: hexColorSchema,
  sidebarBackground: hexColorSchema,
  overlayBackground: hexColorSchema,
});
export type ThemeTokens = z.infer<typeof themeTokensSchema>;

export const WALLPAPER_PRESET_IDS = [
  'moonlit',
  'futryn-spark',
  'cloud-drift',
  'honu-lagoon',
  'koi-pond',
  'jellyfish',
  'lantern-night',
  'fireflies',
  'neon-rain',
  'sakura-dusk',
  'snow-cabin',
  'star-voyage',
] as const;
export type WallpaperPresetId = (typeof WALLPAPER_PRESET_IDS)[number];

export const themeCategorySchema = z.enum(['featured', 'colors', 'live', 'custom']);
export type ThemeCategory = z.infer<typeof themeCategorySchema>;

export const borderStyleSchema = z.enum(['soft', 'rounded', 'sharp', 'double', 'heavy']);
export type BorderStyle = z.infer<typeof borderStyleSchema>;

export const themeModeSchema = z.enum(['dark', 'light', 'system']);
export type ThemeMode = z.infer<typeof themeModeSchema>;

export const themeManifestSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  id: themeIdSchema,
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  category: themeCategorySchema.default('custom'),
  description: z.string().max(240).default(''),
  author: z.string().max(120).optional(),
  license: z.string().max(120).optional(),
  attribution: z.string().max(240).optional(),
  sourceFormat: z.enum(['futryn', 'opencode', 'claude-desktop']).default('futryn'),
  builtIn: z.boolean().default(false),
  defaultMode: z.enum(['dark', 'light']).default('dark'),
  borderStyle: borderStyleSchema.default('soft'),
  wallpaper: themeIdSchema.nullable().default(null),
  greeting: z.string().max(120).optional(),
  dark: themeTokensSchema,
  light: themeTokensSchema,
});
export type ThemeManifest = z.infer<typeof themeManifestSchema>;

export const compatibilityReportSchema = z.strictObject({
  sourceFormat: z.enum(['futryn', 'opencode', 'claude-desktop', 'unknown']),
  compatible: z.boolean(),
  themeId: themeIdSchema.optional(),
  convertedProperties: z.array(z.string().max(120)).max(100),
  unsupportedProperties: z.array(z.string().max(200)).max(100),
  warnings: z.array(z.string().max(300)).max(50),
  refusedExecutableContent: z.boolean().default(false),
  attribution: z.string().max(240).optional(),
});
export type CompatibilityReport = z.infer<typeof compatibilityReportSchema>;

export const animationConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  motion: z.enum(['smooth', 'grid']).default('smooth'),
  speed: z.number().min(0.1).max(16).default(1),
  cellSize: z.number().int().min(1).max(4).default(1),
  veil: z.number().min(0).max(0.95).default(0.65),
  reducedMotion: z.boolean().default(false),
  pauseUnfocused: z.boolean().default(true),
  reactiveEffects: z.boolean().default(true),
});
export type AnimationConfig = z.infer<typeof animationConfigSchema>;

export const appearanceSchema = z.strictObject({
  theme: themeIdSchema.default('auto'),
  mode: z.enum(['dark', 'light', 'system']).default('system'),
  wallpaper: themeIdSchema.nullable().default(null),
  animations: animationConfigSchema.default(() => ({
    enabled: true,
    motion: 'smooth' as const,
    speed: 1,
    cellSize: 1,
    veil: 0.65,
    reducedMotion: false,
    pauseUnfocused: true,
    reactiveEffects: true,
  })),
  syntaxHighlighting: z.boolean().default(true),
  sidebar: z.boolean().default(false),
});
export type AppearanceConfig = z.infer<typeof appearanceSchema>;

export const partialAppearanceSchema = z.strictObject({
  theme: themeIdSchema.optional(),
  mode: z.enum(['dark', 'light', 'system']).optional(),
  wallpaper: themeIdSchema.nullable().optional(),
  animations: animationConfigSchema.partial().optional(),
  syntaxHighlighting: z.boolean().optional(),
  sidebar: z.boolean().optional(),
});
export type PartialAppearanceConfig = z.infer<typeof partialAppearanceSchema>;

export const defaultAnimationConfig = (): AnimationConfig => animationConfigSchema.parse({});
export const defaultAppearance = (): AppearanceConfig => appearanceSchema.parse({});

export const settingsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** Stable local ChatGPT OAuth host identity, without credentials (ADR 0050). */
    chatgptHostID: z.string().uuid().optional(),
    providers: z.array(providerSchema).max(100),
    accounts: z.array(accountSchema).max(200),
    activeAccountId: z.string().uuid().nullable(),
    selection: selectionSchema.nullable(),
    projects: z.record(z.string(), selectionSchema),
    catalogs: z.array(cacheSchema).max(200),
    reasoningPreferences: z.record(z.string(), z.string().min(1).max(40)).optional(),
    sessionModes: z.record(z.string().uuid(), z.enum(['chat', 'plan', 'review'])).optional(),
    agentPreferences: z.strictObject({turnBudget: turnBudgetSchema.optional()}).optional(),
    appearance: appearanceSchema.optional(),
    projectAppearances: z.record(z.string(), partialAppearanceSchema).optional(),
    /** Project permission rules by workspace path (ADR 0028); optional, so older files still load. */
    projectPermissionRules: z.record(z.string(), permissionRuleSetSchema).optional(),
  })
  .superRefine((settings, ctx) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    const validAccount = (id: string) => settings.accounts.some(a => a.id === id && a.status !== 'logged-out');
    if (
      !unique(settings.providers.map(p => p.id)) ||
      !unique(settings.accounts.map(a => a.id)) ||
      !unique(settings.accounts.map(a => a.alias)) ||
      !unique(settings.catalogs.map(c => c.accountId))
    )
      ctx.addIssue({code: 'custom', message: 'Duplicate identity'});
    const keys = settings.accounts.flatMap(a => (a.credential.kind === 'keyring' ? [a.credential.key] : []));
    if (
      !unique(keys) ||
      settings.accounts.some(a => !settings.providers.some(p => p.id === a.providerId)) ||
      settings.catalogs.some(c => !settings.accounts.some(a => a.id === c.accountId))
    )
      ctx.addIssue({code: 'custom', message: 'Invalid identity reference'});
    if (
      (settings.activeAccountId && !validAccount(settings.activeAccountId)) ||
      (settings.selection && !validAccount(settings.selection.accountId)) ||
      Object.values(settings.projects).some(p => !validAccount(p.accountId))
    )
      ctx.addIssue({code: 'custom', message: 'Invalid selection'});
  });
export type Settings = z.infer<typeof settingsSchema>;
export const emptySettings = (): Settings => ({
  schemaVersion: 1,
  providers: [],
  accounts: [],
  activeAccountId: null,
  selection: null,
  projects: {},
  catalogs: [],
});
export interface SettingsStore {
  read(): Settings;
  update(change: (settings: Settings) => void): void;
}

/**
 * Who runs the coding agent (ADR 0029, 0049). Futryn always owns the loop and every project tool;
 * a provider only answers API requests. `chat-only`: no folder consent, so no project tools.
 */
export type ExecutionBackendKind = 'hannes' | 'chat-only';
export interface ExecutionBackend {
  kind: ExecutionBackendKind;
  loopOwner: 'hannes';
  toolOwner: 'hannes' | 'none';
  label: string;
}
export function executionBackendFor(options: {toolsEnabled: boolean}): ExecutionBackend {
  return options.toolsEnabled
    ? {kind: 'hannes', loopOwner: 'hannes', toolOwner: 'hannes', label: 'Futryn agent · Futryn tools'}
    : {
        kind: 'chat-only',
        loopOwner: 'hannes',
        toolOwner: 'none',
        label: 'Futryn agent · tools off (no folder consent)',
      };
}
