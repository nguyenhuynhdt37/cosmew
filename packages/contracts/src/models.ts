import { z } from 'zod';

export const CONTRACT_VERSION = '1.0' as const;
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const modelIdSchema = z.string().min(1).max(200).regex(/^[\w~./:@+-]+$/);
export const protocolSchema = z.enum(['chat', 'responses', 'anthropic', 'gemini']);
export const providerSchema = z.strictObject({
  id: idSchema, name: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/),
  protocol: protocolSchema, baseURL: z.string().url().max(2048),
  auth: z.enum(['api-key', 'none']), catalog: z.enum(['openai', 'anthropic', 'gemini', 'ollama', 'manual']),
  metadataVersion: z.literal(1), timeoutMs: z.number().int().min(100).max(300000).default(60000),
  streamUsage: z.boolean().optional(),
});
export type Provider = z.infer<typeof providerSchema>;
export const credentialRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keyring'), key: z.string().uuid() }),
  z.strictObject({ kind: z.literal('env'), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/) }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type CredentialRef = z.infer<typeof credentialRefSchema>;
export const accountSchema = z.strictObject({
  id: z.string().uuid(), providerId: idSchema,
  alias: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/),
  credential: credentialRefSchema, status: z.enum(['unvalidated', 'valid', 'invalid', 'logged-out']),
  validatedAt: z.string().datetime().nullable(), defaultModel: modelIdSchema.optional(),
  authGeneration: z.number().int().positive().optional(),
});
export type Account = z.infer<typeof accountSchema>;
const capability = z.enum(['supported', 'unsupported', 'unknown']);
export const capabilitiesSchema = z.strictObject({
  text: capability.default('unknown'), tools: capability.default('unknown'),
  streaming: capability.default('unknown'), vision: capability.default('unknown'), reasoning: capability.default('unknown'),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const modelSchema = z.strictObject({
  id: modelIdSchema, name: z.string().min(1).max(300), capabilities: capabilitiesSchema,
  contextLimit: z.number().int().positive().nullable(), outputLimit: z.number().int().positive().nullable(),
  pricing: z.strictObject({ inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative(), currency: z.literal('USD') }).nullable(),
  source: z.enum(['provider', 'manual']), fetchedAt: z.string().datetime(),
  metadataSource: z.string().max(2048).nullable(), metadataFetchedAt: z.string().datetime().nullable(),
});
export type ModelInfo = z.infer<typeof modelSchema>;
export const selectionSchema = z.strictObject({ accountId: z.string().uuid(), modelId: modelIdSchema });
export type Selection = z.infer<typeof selectionSchema>;
export const messageSchema = z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(262144) });
export type Message = z.infer<typeof messageSchema>;
export const requestSchema = z.strictObject({
  requestId: z.string().uuid(), modelId: modelIdSchema,
  messages: z.array(messageSchema).min(1).max(200),
  maxOutputTokens: z.number().int().min(1).max(32768).default(4096),
  maxEstimatedCostUSD: z.number().positive().max(1000).optional(),
  tools: z.array(z.strictObject({ name: idSchema, description: z.string().max(2000), inputSchema: z.record(z.string(), z.unknown()) })).max(32).default([]),
});
export type ModelRequest = z.infer<typeof requestSchema>;
export interface Usage { inputTokens: number | null; outputTokens: number | null; costUSD: number | null; costEstimated?: boolean }
export interface ToolCall { id: string; name: string; input: unknown }
export type ModelEvent =
  | { type: 'started'; requestId: string }
  | { type: 'textDelta'; text: string }
  | { type: 'toolCallComplete'; call: ToolCall }
  | { type: 'completed'; finishReason: string; usage: Usage };
export interface ModelPort {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  generate(request: ModelRequest, signal?: AbortSignal): Promise<{ text: string; calls: ToolCall[]; usage: Usage; finishReason: string }>;
}
export interface CredentialVault {
  get(ref: CredentialRef): Promise<string | undefined>;
  set(key: string, secret: string): Promise<void>;
  delete(ref: CredentialRef): Promise<void>;
}
export interface NetworkPolicy { authorize(provider: Provider, account: Account): void }
export const cacheSchema = z.strictObject({
  accountId: z.string().uuid(), providerFingerprint: z.string(), fetchedAt: z.string().datetime(),
  models: z.array(modelSchema).max(10000),
});
export const settingsSchema = z.strictObject({
  schemaVersion: z.literal(1), providers: z.array(providerSchema).max(100), accounts: z.array(accountSchema).max(200),
  activeAccountId: z.string().uuid().nullable(), selection: selectionSchema.nullable(),
  projects: z.record(z.string(), selectionSchema), catalogs: z.array(cacheSchema).max(200),
}).superRefine((settings, ctx) => {
  const unique = (values: string[]) => new Set(values).size === values.length;
  const validAccount = (id: string) => settings.accounts.some(a => a.id === id && a.status !== 'logged-out');
  if (!unique(settings.providers.map(p => p.id)) || !unique(settings.accounts.map(a => a.id)) || !unique(settings.accounts.map(a => a.alias)) || !unique(settings.catalogs.map(c => c.accountId))) ctx.addIssue({ code: 'custom', message: 'Duplicate identity' });
  const keys = settings.accounts.flatMap(a => a.credential.kind === 'keyring' ? [a.credential.key] : []);
  if (!unique(keys) || settings.accounts.some(a => !settings.providers.some(p => p.id === a.providerId)) || settings.catalogs.some(c => !settings.accounts.some(a => a.id === c.accountId))) ctx.addIssue({ code: 'custom', message: 'Invalid identity reference' });
  if ((settings.activeAccountId && !validAccount(settings.activeAccountId)) || (settings.selection && !validAccount(settings.selection.accountId)) || Object.values(settings.projects).some(p => !validAccount(p.accountId))) ctx.addIssue({ code: 'custom', message: 'Invalid selection' });
});
export type Settings = z.infer<typeof settingsSchema>;
export const emptySettings = (): Settings => ({ schemaVersion: 1, providers: [], accounts: [], activeAccountId: null, selection: null, projects: {}, catalogs: [] });
export interface SettingsStore {
  read(): Settings;
  update(change: (settings: Settings) => void): void;
}
