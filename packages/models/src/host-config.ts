import {
  approvalPolicySchema,
  sandboxModeSchema,
  envNameSchema,
  headerNameSchema,
  idSchema,
  modelIdSchema,
  protocolSchema,
  providerSchema,
  type ApprovalPolicy,
  type Provider,
  type SandboxModeSetting,
} from '@futryn/contracts';

/**
 * Host provider configuration (ADR 0046): `[model_providers.<id>]` tables of the user-level
 * `~/.futryn/config.toml`, using Codex field names. This module is pure: it validates already parsed
 * TOML and renders TOML text. Reading the file, running the token command and every network call
 * belong to the composition root and the transport.
 */

/** Codex `auth` table: a command that prints a bearer token, run without a shell. */
export interface TokenCommand {
  command: string;
  args: string[];
  timeoutMs: number;
  refreshIntervalMs: number;
}
export interface HostProviderEntry {
  provider: Provider;
  tokenCommand?: TokenCommand;
}
export interface HostConfigDiagnostic {
  /** Provider id the problem belongs to; absent for file-level problems. */
  providerId?: string;
  message: string;
}
export interface HostConfig {
  providers: HostProviderEntry[];
  diagnostics: HostConfigDiagnostic[];
}

/** Codex fields that exist but Futryn refuses or does not implement, with the reason shown to the user. */
const REFUSED_FIELDS: Record<string, string> = {
  experimental_bearer_token:
    'plaintext tokens are never stored in config files; use env_key, the keyring or an auth command',
  gateway_oauth: 'not supported',
  aws: 'not supported',
  project_id: 'not supported',
  location: 'not supported',
  credential_file: 'not supported',
  capabilities: 'not supported',
  requires_openai_auth: 'not supported',
  supports_websockets: 'not supported',
  supports_standalone_web_search: 'not supported',
  websocket_connect_timeout_ms: 'not supported',
};
const ALLOWED_FIELDS = new Set([
  'name',
  'base_url',
  'wire_api',
  'env_key',
  'env_key_instructions',
  'query_params',
  'http_headers',
  'env_http_headers',
  'request_max_retries',
  'stream_max_retries',
  'stream_idle_timeout_ms',
  'model_catalog_url',
  'models',
  'catalog',
  'requires_auth',
  'replay_reasoning',
  'auth',
]);
const ALLOWED_AUTH_FIELDS = new Set(['command', 'args', 'timeout_ms', 'refresh_interval_ms']);
const CATALOGS = ['openai', 'anthropic', 'gemini', 'ollama', 'manual'] as const;

/** Codex DEFAULT_PROVIDER_AUTH_TIMEOUT_MS / refresh interval. Futryn caps the timeout at one minute. */
const AUTH_TIMEOUT_MS = 5_000;
const AUTH_TIMEOUT_MAX_MS = 60_000;
const AUTH_REFRESH_MS = 300_000;

const SENSITIVE_NAME =
  /(^|[-_])(authorization|api[-_]?key|apikey|token|secret|passw(or)?d|cookie|credential|sig(nature)?|auth)($|[-_])/i;
/** A static value that looks like a credential: provider key prefixes, JWTs, bearer text or long random strings. */
const TOKEN_LIKE =
  /^(bearer\s|basic\s|sk-|sk_|pk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|AIza|ya29\.|glpat-|eyJ[\w-]{8,}\.)|^[A-Za-z0-9_+/=-]{32,}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};

/** Public, credential-free HTTP(S) base URL; plain HTTP only for loopback. Path prefixes are kept. */
export function validateBaseURL(value: unknown, field = 'base_url'): string {
  if (typeof value !== 'string' || !value) return fail(`${field} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`${field} is not a URL`);
  }
  if (url.username || url.password) return fail(`${field} must not contain credentials`);
  if (url.search || url.hash) return fail(`${field} must not contain a query or fragment (use query_params)`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))
    return fail(`${field} must use https (http only for localhost)`);
  return url.href.replace(/\/$/, '');
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) return fail(`${field} must be a table of strings`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return fail(`${field}.${key} must be a string`);
    out[key] = item;
  }
  if (Object.keys(out).length > 20) return fail(`${field} has more than 20 entries`);
  return out;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min)
    return fail(`${field} must be an integer >= ${min}`);
  return Math.min(value, max);
}

function tokenCommand(value: unknown): TokenCommand {
  if (!isRecord(value)) return fail('auth must be a table with a command');
  for (const key of Object.keys(value)) if (!ALLOWED_AUTH_FIELDS.has(key)) fail(`auth.${key} is not supported`);
  const command = value.command;
  if (typeof command !== 'string' || !command.trim()) return fail('auth.command is required');
  // Codex: an absolute path or a bare executable name; never a relative path or a shell line.
  const bare = /^[A-Za-z0-9._+-]+$/.test(command);
  const absolute = /^(\/|[A-Za-z]:[\\/])/.test(command) && !/[\x00-\x1f]/.test(command);
  if (!bare && !absolute) return fail('auth.command must be an absolute path or a bare executable name');
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(a => typeof a !== 'string' || a.length > 1000))
    return fail('auth.args must be a list of at most 32 strings');
  return {
    command,
    args: args as string[],
    timeoutMs:
      value.timeout_ms === undefined
        ? AUTH_TIMEOUT_MS
        : integer(value.timeout_ms, 'auth.timeout_ms', 1, AUTH_TIMEOUT_MAX_MS),
    refreshIntervalMs:
      value.refresh_interval_ms === undefined
        ? AUTH_REFRESH_MS
        : integer(value.refresh_interval_ms, 'auth.refresh_interval_ms', 0, 86_400_000),
  };
}

function convert(id: string, raw: unknown): HostProviderEntry {
  if (!idSchema.safeParse(id).success)
    return fail('provider id may only use letters, digits, dot, dash and underscore');
  if (!isRecord(raw)) return fail('must be a table');
  for (const key of Object.keys(raw)) {
    if (REFUSED_FIELDS[key]) fail(`${key}: ${REFUSED_FIELDS[key]}`);
    if (!ALLOWED_FIELDS.has(key)) fail(`${key} is not a supported field`);
  }
  const baseURL = validateBaseURL(raw.base_url);
  const protocol = protocolSchema.safeParse(raw.wire_api ?? 'chat');
  if (!protocol.success) return fail('wire_api must be chat, responses, anthropic or gemini');

  const queryParams = raw.query_params === undefined ? undefined : stringMap(raw.query_params, 'query_params');
  for (const [name, value] of Object.entries(queryParams ?? {})) {
    if (SENSITIVE_NAME.test(name) || name.toLowerCase() === 'key')
      fail(`query_params.${name}: credentials do not belong in the URL; use env_key, the keyring or an auth command`);
    if (TOKEN_LIKE.test(value)) fail(`query_params.${name} looks like a credential`);
  }
  const httpHeaders = raw.http_headers === undefined ? undefined : stringMap(raw.http_headers, 'http_headers');
  for (const [name, value] of Object.entries(httpHeaders ?? {})) {
    if (!headerNameSchema.safeParse(name).success) fail(`http_headers.${name} is not a valid header name`);
    if (SENSITIVE_NAME.test(name))
      fail(`http_headers.${name}: credential headers are set from env_http_headers, env_key or an auth command`);
    if (/[\x00-\x1f\x7f]/.test(value)) fail(`http_headers.${name} contains control characters`);
    if (TOKEN_LIKE.test(value)) fail(`http_headers.${name} looks like a credential; use env_http_headers`);
  }
  const envHttpHeaders =
    raw.env_http_headers === undefined ? undefined : stringMap(raw.env_http_headers, 'env_http_headers');
  for (const [name, envName] of Object.entries(envHttpHeaders ?? {})) {
    if (!headerNameSchema.safeParse(name).success) fail(`env_http_headers.${name} is not a valid header name`);
    if (!envNameSchema.safeParse(envName).success) fail(`env_http_headers.${name} must name an environment variable`);
  }

  if (raw.env_key !== undefined && !envNameSchema.safeParse(raw.env_key).success)
    fail('env_key must be an environment variable NAME, not a key');
  if (raw.env_key_instructions !== undefined && typeof raw.env_key_instructions !== 'string')
    fail('env_key_instructions must be a string');
  if (raw.requires_auth !== undefined && typeof raw.requires_auth !== 'boolean')
    fail('requires_auth must be true or false');
  if (raw.replay_reasoning !== undefined && typeof raw.replay_reasoning !== 'boolean')
    fail('replay_reasoning must be true or false');

  let models: string[] | undefined;
  if (raw.models !== undefined) {
    if (
      !Array.isArray(raw.models) ||
      raw.models.length > 500 ||
      raw.models.some(m => !modelIdSchema.safeParse(m).success)
    )
      fail('models must be a list of model ids');
    models = raw.models as string[];
  }
  let catalog: Provider['catalog'] =
    protocol.data === 'anthropic' ? 'anthropic' : protocol.data === 'gemini' ? 'gemini' : 'openai';
  if (raw.catalog !== undefined) {
    if (!(CATALOGS as readonly unknown[]).includes(raw.catalog)) fail(`catalog must be one of ${CATALOGS.join(', ')}`);
    catalog = raw.catalog as Provider['catalog'];
  } else if (models?.length && raw.model_catalog_url === undefined) catalog = 'manual';

  let modelCatalogURL: string | undefined;
  if (raw.model_catalog_url !== undefined) {
    modelCatalogURL = validateBaseURL(raw.model_catalog_url, 'model_catalog_url');
    const base = new URL(baseURL);
    const catalogURL = new URL(modelCatalogURL);
    const prefix = base.pathname.replace(/\/$/, '') + '/';
    if (catalogURL.origin !== base.origin || !catalogURL.pathname.startsWith(prefix))
      fail('model_catalog_url must be on the same origin and below base_url');
  }

  let command: TokenCommand | undefined;
  if (raw.auth !== undefined) {
    if (raw.requires_auth === false) fail('auth and requires_auth = false contradict each other');
    command = tokenCommand(raw.auth);
  }
  const provider = providerSchema.safeParse({
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
    protocol: protocol.data,
    baseURL,
    auth: command ? 'command' : raw.requires_auth === false ? 'none' : 'api-key',
    catalog,
    metadataVersion: 1,
    timeoutMs: 60000,
    source: 'config',
    ...(raw.stream_idle_timeout_ms !== undefined
      ? {streamIdleTimeoutMs: integer(raw.stream_idle_timeout_ms, 'stream_idle_timeout_ms', 100, 3_600_000)}
      : {}),
    ...(raw.env_key ? {envKey: raw.env_key} : {}),
    ...(raw.env_key_instructions ? {envKeyInstructions: raw.env_key_instructions} : {}),
    ...(queryParams && Object.keys(queryParams).length ? {queryParams} : {}),
    ...(httpHeaders && Object.keys(httpHeaders).length ? {httpHeaders} : {}),
    ...(envHttpHeaders && Object.keys(envHttpHeaders).length ? {envHttpHeaders} : {}),
    ...(raw.request_max_retries !== undefined
      ? {requestMaxRetries: integer(raw.request_max_retries, 'request_max_retries', 0, 100)}
      : {}),
    ...(raw.stream_max_retries !== undefined
      ? {streamMaxRetries: integer(raw.stream_max_retries, 'stream_max_retries', 0, 100)}
      : {}),
    ...(modelCatalogURL ? {modelCatalogURL} : {}),
    ...(models?.length ? {models} : {}),
    ...(raw.replay_reasoning === true ? {replayReasoning: true} : {}),
    // Streams are chatty; a chat gateway reports usage only when asked.
    ...(protocol.data === 'chat' ? {streamUsage: true} : {}),
  });
  if (!provider.success) return fail('invalid provider definition');
  return {provider: provider.data, ...(command ? {tokenCommand: command} : {})};
}

/** Validate parsed TOML. A bad provider is reported and skipped; it never blocks the others. */
export function loadHostConfig(parsed: unknown, reserved: ReadonlySet<string> = new Set()): HostConfig {
  const result: HostConfig = {providers: [], diagnostics: []};
  if (!isRecord(parsed)) return result;
  const table = parsed.model_providers;
  if (table === undefined) return result;
  if (!isRecord(table)) {
    result.diagnostics.push({message: 'model_providers must be a table of providers'});
    return result;
  }
  for (const [id, raw] of Object.entries(table)) {
    try {
      if (reserved.has(id)) fail('this id belongs to a built-in subscription provider and cannot be redefined');
      result.providers.push(convert(id, raw));
    } catch (error) {
      result.diagnostics.push({
        providerId: id,
        message: error instanceof Invalid ? error.message : 'invalid definition',
      });
    }
  }
  return result;
}

/**
 * Permission defaults of the user-level config (ADR 0055), with Codex field names: top-level
 * `sandbox_mode` and `approval_policy`, and `[sandbox_workspace_write] network_access`. Pure: the
 * composition root reads the file, applies the environment and the CLI flags on top, and never
 * reads this from a workspace. An invalid value fails closed (stricter) and is reported.
 */
export interface HostPermissionConfig {
  sandboxMode?: SandboxModeSetting;
  approvalPolicy?: ApprovalPolicy;
  networkAccess?: boolean;
  diagnostics: HostConfigDiagnostic[];
}

export function loadHostPermissions(parsed: unknown): HostPermissionConfig {
  const result: HostPermissionConfig = {diagnostics: []};
  if (!isRecord(parsed)) return result;
  if (parsed.sandbox_mode !== undefined) {
    const mode = sandboxModeSchema.safeParse(parsed.sandbox_mode);
    if (mode.success) result.sandboxMode = mode.data;
    else {
      result.sandboxMode = 'read-only';
      result.diagnostics.push({
        message: 'sandbox_mode must be read-only, workspace-write or danger-full-access; using read-only',
      });
    }
  }
  if (parsed.approval_policy !== undefined) {
    const policy = approvalPolicySchema.safeParse(parsed.approval_policy);
    if (policy.success) result.approvalPolicy = policy.data;
    else {
      result.approvalPolicy = 'untrusted';
      result.diagnostics.push({message: 'approval_policy must be untrusted, on-request or never; using untrusted'});
    }
  }
  const workspaceWrite = parsed.sandbox_workspace_write;
  if (workspaceWrite !== undefined) {
    if (!isRecord(workspaceWrite)) result.diagnostics.push({message: 'sandbox_workspace_write must be a table'});
    else if (workspaceWrite.network_access !== undefined) {
      if (typeof workspaceWrite.network_access === 'boolean') result.networkAccess = workspaceWrite.network_access;
      else
        result.diagnostics.push({
          message: 'sandbox_workspace_write.network_access must be true or false; network stays off',
        });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Writing: text edits that keep the rest of the user's file (comments, other tables) untouched.

const tomlString = (value: string) => JSON.stringify(value);
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));

/** TOML text of one provider definition, the inverse of `loadHostConfig` for the fields it writes. */
export function renderProviderToml(entry: HostProviderEntry): string {
  const {provider, tokenCommand: command} = entry;
  const head = `model_providers.${tomlKey(provider.id)}`;
  const lines = [`[${head}]`, `name = ${tomlString(provider.name)}`, `base_url = ${tomlString(provider.baseURL)}`];
  lines.push(`wire_api = ${tomlString(provider.protocol)}`);
  const defaultCatalog =
    provider.protocol === 'anthropic' ? 'anthropic' : provider.protocol === 'gemini' ? 'gemini' : 'openai';
  if (provider.catalog !== defaultCatalog && !(provider.catalog === 'manual' && provider.models?.length))
    lines.push(`catalog = ${tomlString(provider.catalog)}`);
  if (provider.envKey) lines.push(`env_key = ${tomlString(provider.envKey)}`);
  if (provider.envKeyInstructions) lines.push(`env_key_instructions = ${tomlString(provider.envKeyInstructions)}`);
  if (provider.auth === 'none') lines.push('requires_auth = false');
  if (provider.streamIdleTimeoutMs !== undefined)
    lines.push(`stream_idle_timeout_ms = ${provider.streamIdleTimeoutMs}`);
  if (provider.requestMaxRetries !== undefined) lines.push(`request_max_retries = ${provider.requestMaxRetries}`);
  if (provider.streamMaxRetries !== undefined) lines.push(`stream_max_retries = ${provider.streamMaxRetries}`);
  if (provider.modelCatalogURL) lines.push(`model_catalog_url = ${tomlString(provider.modelCatalogURL)}`);
  if (provider.models?.length) lines.push(`models = [${provider.models.map(tomlString).join(', ')}]`);
  if (provider.replayReasoning) lines.push('replay_reasoning = true');
  const table = (name: string, values: Record<string, string> | undefined) => {
    if (!values || !Object.keys(values).length) return;
    lines.push('', `[${head}.${name}]`);
    for (const [key, value] of Object.entries(values)) lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
  };
  table('query_params', provider.queryParams);
  table('http_headers', provider.httpHeaders);
  table('env_http_headers', provider.envHttpHeaders);
  if (command) {
    lines.push('', `[${head}.auth]`, `command = ${tomlString(command.command)}`);
    if (command.args.length) lines.push(`args = [${command.args.map(tomlString).join(', ')}]`);
    lines.push(`timeout_ms = ${command.timeoutMs}`, `refresh_interval_ms = ${command.refreshIntervalMs}`);
  }
  return lines.join('\n') + '\n';
}

const sectionOf = (header: string, id: string) => {
  const names = [id, tomlString(id), `'${id}'`];
  return names.some(name => header === `[model_providers.${name}]` || header.startsWith(`[model_providers.${name}.`));
};

/** Append a provider table. Throws when the id is already defined in the text. */
export function appendProvider(text: string, entry: HostProviderEntry): string {
  const lines = text.split('\n');
  if (lines.some(line => sectionOf(line.trim(), entry.provider.id))) throw new Invalid('provider already defined');
  const separator = text.length && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
  return text + separator + renderProviderToml(entry);
}

/** Remove a provider's tables (and their comment lines directly above). Returns the text unchanged if absent. */
export function removeProvider(text: string, id: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) skipping = sectionOf(trimmed, id);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}
