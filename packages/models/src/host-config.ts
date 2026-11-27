import {
  BUILTIN_SUBAGENT_TYPES,
  DEFAULT_AGENT_MAX_DEPTH,
  DEFAULT_AGENT_MAX_THREADS,
  envNameSchema,
  headerNameSchema,
  idSchema,
  modelIdSchema,
  protocolSchema,
  providerSchema,
  providerReasoningSchema,
  type HostAgentRoleConfig,
  type HostAgentsConfig,
  type Provider,
} from '@cosmew/contracts';

/**
 * Host provider configuration (ADR 0046): `[model_providers.<id>]` tables of the user-level
 * `~/.cosmew/config.toml` (legacy roots remain readable), using Codex field names. This module is pure: it validates already parsed
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

/** Codex fields that exist but Cosmew refuses or does not implement, with the reason shown to the user. */
const REFUSED_FIELDS: Record<string, string> = {
  experimental_bearer_token:
    'plaintext tokens are never stored in config files; use env_key, the keyring or an auth command',
  gateway_oauth: 'not supported',
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
  'stream_usage',
  'model_catalog_url',
  'models',
  'catalog',
  'requires_auth',
  'auth_mode',
  'replay_reasoning',
  'reasoning',
  'auth',
  'aws',
  'vertex',
  'azure',
  'project_id',
  'location',
  'credential_file',
  'api_version',
]);
const ALLOWED_AUTH_FIELDS = new Set(['command', 'args', 'timeout_ms', 'refresh_interval_ms']);
const ALLOWED_AWS_FIELDS = new Set(['region', 'profile']);
const ALLOWED_VERTEX_FIELDS = new Set(['project_id', 'location', 'credential_file']);
const ALLOWED_AZURE_FIELDS = new Set(['api_version', 'api_mode', 'use_deployment_based_urls']);
const CATALOGS = ['openai', 'anthropic', 'gemini', 'ollama', 'bedrock', 'manual'] as const;
const AUTH_MODES = ['api-key', 'none', 'aws-sigv4', 'google-adc'] as const;
const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const AWS_PROFILE_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GCP_PROJECT_RE = /^[a-z0-9][a-z0-9.:-]{2,99}$/;
const GCP_LOCATION_RE = /^(?:global|[a-z]{2,12}-[a-z0-9-]{2,20})$/;
const AZURE_API_VERSION_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-[a-z0-9-]+)?$/;
const DEFAULT_AZURE_API_VERSION = '2024-10-21';

/** Codex DEFAULT_PROVIDER_AUTH_TIMEOUT_MS / refresh interval. Cosmew caps the timeout at one minute. */
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
  const reasoning = raw.reasoning === undefined ? undefined : providerReasoningSchema.safeParse(raw.reasoning);
  if (reasoning && !reasoning.success)
    fail(
      'reasoning must use known keys, a boolean supported, 1–20 unique effort strings (1–40 characters; default is reserved), and positive integer budgets keyed by minimal, low, medium, high, xhigh or max',
    );
  const protocol = protocolSchema.safeParse(raw.wire_api ?? 'chat');
  if (!protocol.success)
    return fail('wire_api must be chat, responses, anthropic, gemini, azure, bedrock, vertex or vertex-anthropic');

  let aws: Provider['aws'];
  if (raw.aws !== undefined) {
    if (protocol.data !== 'bedrock') return fail('aws settings are only supported with wire_api = "bedrock"');
    if (!isRecord(raw.aws)) return fail('aws must be a table');
    const awsRaw = raw.aws;
    for (const key of Object.keys(awsRaw)) if (!ALLOWED_AWS_FIELDS.has(key)) return fail(`aws.${key} is not supported`);
    if (typeof awsRaw.region !== 'string' || !AWS_REGION_RE.test(awsRaw.region))
      return fail('aws.region must be a valid AWS region (e.g. us-east-1)');
    if (awsRaw.profile !== undefined && (typeof awsRaw.profile !== 'string' || !AWS_PROFILE_RE.test(awsRaw.profile)))
      return fail('aws.profile must be a valid profile name');
    aws = {region: awsRaw.region, ...(typeof awsRaw.profile === 'string' ? {profile: awsRaw.profile} : {})};
  }

  let vertex: Provider['vertex'];
  const hasVertexFields =
    raw.vertex !== undefined ||
    raw.project_id !== undefined ||
    raw.location !== undefined ||
    raw.credential_file !== undefined;
  if (hasVertexFields) {
    if (protocol.data !== 'vertex' && protocol.data !== 'vertex-anthropic')
      return fail(
        'project_id, location, credential_file and vertex settings require wire_api = "vertex" or "vertex-anthropic"',
      );
    const vt = raw.vertex === undefined ? {} : isRecord(raw.vertex) ? raw.vertex : fail('vertex must be a table');
    for (const key of Object.keys(vt))
      if (!ALLOWED_VERTEX_FIELDS.has(key)) return fail(`vertex.${key} is not supported`);
    const projectId = raw.project_id ?? vt.project_id;
    const location = raw.location ?? vt.location;
    const credentialFile = raw.credential_file ?? vt.credential_file;
    if (raw.project_id !== undefined && vt.project_id !== undefined)
      return fail('specify project_id either at top level or in [vertex], not both');
    if (raw.location !== undefined && vt.location !== undefined)
      return fail('specify location either at top level or in [vertex], not both');
    if (raw.credential_file !== undefined && vt.credential_file !== undefined)
      return fail('specify credential_file either at top level or in [vertex], not both');
    if (typeof projectId !== 'string' || !GCP_PROJECT_RE.test(projectId))
      return fail('project_id must be a valid Google Cloud project id');
    if (typeof location !== 'string' || !GCP_LOCATION_RE.test(location))
      return fail('location must be "global" or a valid Google Cloud region (e.g. us-central1)');
    let validCredentialFile: string | undefined;
    if (credentialFile !== undefined) {
      if (
        typeof credentialFile !== 'string' ||
        !credentialFile.trim() ||
        credentialFile.length > 1024 ||
        /[\x00-\x1f\x7f]/.test(credentialFile)
      )
        return fail('credential_file must be a valid file path');
      const absolute =
        credentialFile.startsWith('/') || credentialFile.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(credentialFile);
      if (!absolute || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(credentialFile))
        return fail('credential_file must be an absolute path (or ~/...) without parent traversal');
      validCredentialFile = credentialFile;
    }
    vertex = {
      projectId,
      location,
      ...(validCredentialFile ? {credentialFile: validCredentialFile} : {}),
    };
  }

  let baseURL: string;
  if (raw.base_url !== undefined) {
    baseURL = validateBaseURL(raw.base_url);
  } else if (protocol.data === 'bedrock' && aws?.region) {
    baseURL = `https://bedrock-runtime.${aws.region}.amazonaws.com`;
  } else if ((protocol.data === 'vertex' || protocol.data === 'vertex-anthropic') && vertex) {
    const host =
      vertex.location === 'global' ? 'aiplatform.googleapis.com' : `${vertex.location}-aiplatform.googleapis.com`;
    const publisher = protocol.data === 'vertex-anthropic' ? 'anthropic' : 'google';
    baseURL = `https://${host}/v1/projects/${vertex.projectId}/locations/${vertex.location}/publishers/${publisher}`;
  } else {
    baseURL = fail('base_url is required (or specify aws.region for bedrock / project_id + location for vertex)');
  }

  if (protocol.data === 'bedrock' && !aws) {
    const match = /^bedrock-runtime\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/i.exec(
      new URL(baseURL).hostname,
    );
    if (match?.[1]) aws = {region: match[1].toLowerCase()};
  }

  let azure: Provider['azure'];
  if (raw.azure !== undefined || raw.api_version !== undefined || protocol.data === 'azure') {
    if (protocol.data !== 'azure')
      return fail('azure and api_version settings are only supported with wire_api = "azure"');
    const az = raw.azure === undefined ? {} : isRecord(raw.azure) ? raw.azure : fail('azure must be a table');
    for (const key of Object.keys(az)) if (!ALLOWED_AZURE_FIELDS.has(key)) return fail(`azure.${key} is not supported`);
    if (raw.api_version !== undefined && az.api_version !== undefined)
      return fail('specify api_version either at top level or in [azure], not both');
    const apiVersion = raw.api_version ?? az.api_version;
    if (apiVersion !== undefined && (typeof apiVersion !== 'string' || !AZURE_API_VERSION_RE.test(apiVersion)))
      return fail('azure.api_version must match YYYY-MM-DD (optional suffix, e.g. 2024-10-21)');
    const apiMode = az.api_mode;
    if (apiMode !== undefined && apiMode !== 'chat' && apiMode !== 'responses')
      return fail('azure.api_mode must be "chat" or "responses"');
    if (az.use_deployment_based_urls !== undefined && typeof az.use_deployment_based_urls !== 'boolean')
      return fail('azure.use_deployment_based_urls must be true or false');
    const isV1Endpoint = /\/openai\/v1$/i.test(new URL(baseURL).pathname.replace(/\/$/, ''));
    const useDeploymentBasedUrls: boolean =
      typeof az.use_deployment_based_urls === 'boolean' ? az.use_deployment_based_urls : !isV1Endpoint;
    const resolvedMode: 'chat' | 'responses' =
      apiMode === 'chat' || apiMode === 'responses' ? apiMode : useDeploymentBasedUrls ? 'chat' : 'responses';
    const resolvedVersion =
      typeof apiVersion === 'string' ? apiVersion : useDeploymentBasedUrls ? DEFAULT_AZURE_API_VERSION : undefined;
    azure = {
      ...(resolvedVersion ? {apiVersion: resolvedVersion} : {}),
      apiMode: resolvedMode,
      useDeploymentBasedUrls,
    };
  }

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
  if (raw.stream_usage !== undefined && typeof raw.stream_usage !== 'boolean')
    fail('stream_usage must be true or false');
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
    protocol.data === 'anthropic'
      ? 'anthropic'
      : protocol.data === 'gemini'
        ? 'gemini'
        : protocol.data === 'bedrock'
          ? 'bedrock'
          : protocol.data === 'vertex' || protocol.data === 'vertex-anthropic'
            ? 'manual'
            : 'openai';
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
    if (raw.requires_auth === false || raw.auth_mode !== undefined)
      fail('auth command cannot be combined with requires_auth = false or auth_mode');
    command = tokenCommand(raw.auth);
  }
  if (raw.auth_mode !== undefined && !(AUTH_MODES as readonly unknown[]).includes(raw.auth_mode))
    fail(`auth_mode must be one of ${AUTH_MODES.join(', ')}`);
  if (raw.auth_mode !== undefined && raw.requires_auth === false && raw.auth_mode !== 'none')
    fail('auth_mode and requires_auth = false contradict each other');

  const resolvedAuth: Provider['auth'] = command
    ? 'command'
    : raw.auth_mode !== undefined
      ? (raw.auth_mode as Provider['auth'])
      : raw.requires_auth === false
        ? 'none'
        : protocol.data === 'bedrock'
          ? raw.env_key
            ? 'api-key'
            : 'aws-sigv4'
          : protocol.data === 'vertex' || protocol.data === 'vertex-anthropic'
            ? raw.env_key
              ? 'api-key'
              : 'google-adc'
            : 'api-key';

  if (resolvedAuth === 'aws-sigv4' && protocol.data !== 'bedrock')
    fail('auth_mode = "aws-sigv4" requires wire_api = "bedrock"');
  if (resolvedAuth === 'google-adc' && !['vertex', 'vertex-anthropic', 'gemini'].includes(protocol.data))
    fail('auth_mode = "google-adc" requires wire_api = "vertex", "vertex-anthropic" or "gemini"');

  const provider = providerSchema.safeParse({
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
    protocol: protocol.data,
    baseURL,
    auth: resolvedAuth,
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
    ...(reasoning?.success ? {reasoning: reasoning.data} : {}),
    ...(aws ? {aws} : {}),
    ...(vertex ? {vertex} : {}),
    ...(azure ? {azure} : {}),
    // Streams are chatty; a chat gateway reports usage only when asked.
    ...(protocol.data === 'chat' || (protocol.data === 'azure' && azure?.apiMode === 'chat')
      ? {streamUsage: raw.stream_usage !== false}
      : {}),
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
 * Permissions moved to Claude Code style settings files (ADR 0061): `~/.cosmew/settings.json` and the
 * project's `.cosmew/settings.json` / `settings.local.json` (legacy roots remain readable). The Codex keys of ADR 0053/0055 are no
 * longer read; finding one in `config.toml` is reported so nobody believes it still applies.
 */
export interface HostPermissionConfig {
  diagnostics: HostConfigDiagnostic[];
}

const REMOVED_PERMISSION_KEYS: Record<string, string> = {
  sandbox_mode: 'use sandbox.enabled in settings.json',
  approval_policy: 'use permissions.defaultMode in settings.json',
  sandbox_workspace_write: 'use sandbox.network.allowedDomains in settings.json',
};

export function loadHostPermissions(parsed: unknown): HostPermissionConfig {
  const result: HostPermissionConfig = {diagnostics: []};
  if (!isRecord(parsed)) return result;
  for (const [key, replacement] of Object.entries(REMOVED_PERMISSION_KEYS))
    if (parsed[key] !== undefined)
      result.diagnostics.push({message: `${key} is no longer supported and is ignored (ADR 0061): ${replacement}`});
  return result;
}

export interface HostAgentsLoadedConfig extends HostAgentsConfig {
  diagnostics: HostConfigDiagnostic[];
}

const AGENT_TOP_FIELDS = new Set([
  'enabled',
  'max_threads',
  'max_concurrent_threads_per_session',
  'max_depth',
  'model',
  'default_model',
  'default_subagent_model',
  'reasoning_effort',
  'default_reasoning_effort',
  'default_subagent_reasoning_effort',
  'max_child_tokens',
  'max_child_duration_ms',
  'max_child_cost_usd',
]);

const AGENT_ROLE_FIELDS = new Set([
  'model',
  'reasoning_effort',
  'model_reasoning_effort',
  'description',
  'developer_instructions',
]);

const VALID_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const VALID_ROLE_NAMES = new Set<string>([...BUILTIN_SUBAGENT_TYPES, 'explorer', 'default']);

/**
 * Subagent configuration in `~/.cosmew/config.toml` (`[agents]` and `[agents.<role>]`, Wave 2 S5).
 * Pure parser: invalid values emit diagnostics and fall back to Codex defaults (`max_threads = 6`, `max_depth = 1`).
 */
export function loadHostAgents(parsed: unknown): HostAgentsLoadedConfig {
  const result: HostAgentsLoadedConfig = {
    enabled: true,
    maxThreads: DEFAULT_AGENT_MAX_THREADS,
    maxDepth: DEFAULT_AGENT_MAX_DEPTH,
    roles: {},
    diagnostics: [],
  };
  if (!isRecord(parsed) || parsed.agents === undefined) return result;
  const agents = parsed.agents;
  if (!isRecord(agents)) {
    result.diagnostics.push({message: 'agents must be a table; using defaults.'});
    return result;
  }

  if (agents.enabled !== undefined) {
    if (typeof agents.enabled === 'boolean') result.enabled = agents.enabled;
    else result.diagnostics.push({message: 'agents.enabled must be true or false; using true.'});
  }

  const rawMaxThreads = agents.max_threads ?? agents.max_concurrent_threads_per_session;
  if (rawMaxThreads !== undefined) {
    if (
      typeof rawMaxThreads === 'number' &&
      Number.isSafeInteger(rawMaxThreads) &&
      rawMaxThreads >= 1 &&
      rawMaxThreads <= 64
    ) {
      result.maxThreads = rawMaxThreads;
    } else {
      result.diagnostics.push({
        message: `agents.max_threads must be an integer between 1 and 64; using ${DEFAULT_AGENT_MAX_THREADS}.`,
      });
    }
  }

  if (agents.max_depth !== undefined) {
    if (
      typeof agents.max_depth === 'number' &&
      Number.isSafeInteger(agents.max_depth) &&
      agents.max_depth >= 1 &&
      agents.max_depth <= 8
    ) {
      result.maxDepth = agents.max_depth;
    } else {
      result.diagnostics.push({
        message: `agents.max_depth must be an integer between 1 and 8; using ${DEFAULT_AGENT_MAX_DEPTH}.`,
      });
    }
  }

  const childLimit = (key: string, max: number, integer: boolean): number | undefined => {
    const raw = agents[key];
    if (raw === undefined) return undefined;
    if (
      typeof raw === 'number' &&
      Number.isFinite(raw) &&
      raw > 0 &&
      raw <= max &&
      (!integer || Number.isSafeInteger(raw))
    )
      return raw;
    result.diagnostics.push({
      message: `agents.${key} must be ${integer ? 'an integer' : 'a number'} greater than 0 and at most ${max}; no per-child limit.`,
    });
    return undefined;
  };
  const maxChildTokens = childLimit('max_child_tokens', 1_000_000_000, true);
  if (maxChildTokens !== undefined) result.maxChildTokens = maxChildTokens;
  const maxChildDurationMs = childLimit('max_child_duration_ms', 86_400_000, true);
  if (maxChildDurationMs !== undefined) result.maxChildDurationMs = Math.max(1000, maxChildDurationMs);
  const maxChildCostUSD = childLimit('max_child_cost_usd', 1000, false);
  if (maxChildCostUSD !== undefined) result.maxChildCostUSD = maxChildCostUSD;

  const rawDefaultModel = agents.default_model ?? agents.default_subagent_model ?? agents.model;
  if (rawDefaultModel !== undefined) {
    if (typeof rawDefaultModel === 'string' && modelIdSchema.safeParse(rawDefaultModel.trim()).success) {
      result.defaultModel = rawDefaultModel.trim();
    } else {
      result.diagnostics.push({message: 'agents.default_model must be a valid model id.'});
    }
  }

  const rawDefaultEffort =
    agents.default_reasoning_effort ?? agents.default_subagent_reasoning_effort ?? agents.reasoning_effort;
  if (rawDefaultEffort !== undefined) {
    if (typeof rawDefaultEffort === 'string' && VALID_REASONING_EFFORTS.has(rawDefaultEffort.trim().toLowerCase())) {
      result.defaultReasoningEffort = rawDefaultEffort.trim().toLowerCase();
    } else {
      result.diagnostics.push({
        message: 'agents.reasoning_effort must be one of none, minimal, low, medium, high, xhigh.',
      });
    }
  }

  for (const [key, value] of Object.entries(agents)) {
    if (AGENT_TOP_FIELDS.has(key)) continue;
    if (!isRecord(value) || !VALID_ROLE_NAMES.has(key.toLowerCase())) {
      result.diagnostics.push({message: `agents.${key} is not a recognized field or role table.`});
      continue;
    }
    const role: HostAgentRoleConfig = {};
    for (const [roleKey, roleVal] of Object.entries(value)) {
      if (!AGENT_ROLE_FIELDS.has(roleKey)) {
        result.diagnostics.push({message: `agents.${key}.${roleKey} is not a supported role field.`});
        continue;
      }
      if (roleKey === 'model') {
        if (typeof roleVal === 'string' && modelIdSchema.safeParse(roleVal.trim()).success) {
          role.model = roleVal.trim();
        } else {
          result.diagnostics.push({message: `agents.${key}.model must be a valid model id.`});
        }
      } else if (roleKey === 'reasoning_effort' || roleKey === 'model_reasoning_effort') {
        if (typeof roleVal === 'string' && VALID_REASONING_EFFORTS.has(roleVal.trim().toLowerCase())) {
          role.reasoningEffort = roleVal.trim().toLowerCase();
        } else {
          result.diagnostics.push({message: `agents.${key}.${roleKey} must be a valid reasoning effort.`});
        }
      } else if (roleKey === 'description') {
        if (typeof roleVal === 'string' && roleVal.trim().length > 0 && roleVal.trim().length <= 1000) {
          role.description = roleVal.trim();
        } else {
          result.diagnostics.push({message: `agents.${key}.description must be a string <= 1000 chars.`});
        }
      } else if (roleKey === 'developer_instructions') {
        if (typeof roleVal === 'string' && roleVal.trim().length > 0 && roleVal.trim().length <= 8000) {
          role.developerInstructions = roleVal.trim();
        } else {
          result.diagnostics.push({message: `agents.${key}.developer_instructions must be a string <= 8000 chars.`});
        }
      }
    }
    result.roles[key.toLowerCase()] = role;
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
  if (
    (provider.protocol === 'chat' || (provider.protocol === 'azure' && provider.azure?.apiMode === 'chat')) &&
    provider.streamUsage === false
  )
    lines.push('stream_usage = false');
  const defaultCatalog =
    provider.protocol === 'anthropic'
      ? 'anthropic'
      : provider.protocol === 'gemini'
        ? 'gemini'
        : provider.protocol === 'bedrock'
          ? 'bedrock'
          : provider.protocol === 'vertex' || provider.protocol === 'vertex-anthropic'
            ? 'manual'
            : 'openai';
  if (provider.catalog !== defaultCatalog && !(provider.catalog === 'manual' && provider.models?.length))
    lines.push(`catalog = ${tomlString(provider.catalog)}`);
  if (provider.envKey) lines.push(`env_key = ${tomlString(provider.envKey)}`);
  if (provider.envKeyInstructions) lines.push(`env_key_instructions = ${tomlString(provider.envKeyInstructions)}`);
  const defaultAuth =
    provider.protocol === 'bedrock'
      ? provider.envKey
        ? 'api-key'
        : 'aws-sigv4'
      : provider.protocol === 'vertex' || provider.protocol === 'vertex-anthropic'
        ? provider.envKey
          ? 'api-key'
          : 'google-adc'
        : 'api-key';
  if (provider.auth === 'none') lines.push('requires_auth = false');
  else if (!command && provider.auth !== 'oauth' && provider.auth !== 'command' && provider.auth !== defaultAuth)
    lines.push(`auth_mode = ${tomlString(provider.auth)}`);
  if (provider.vertex) {
    lines.push(`project_id = ${tomlString(provider.vertex.projectId)}`);
    lines.push(`location = ${tomlString(provider.vertex.location)}`);
    if (provider.vertex.credentialFile) lines.push(`credential_file = ${tomlString(provider.vertex.credentialFile)}`);
  }
  if (provider.streamIdleTimeoutMs !== undefined)
    lines.push(`stream_idle_timeout_ms = ${provider.streamIdleTimeoutMs}`);
  if (provider.requestMaxRetries !== undefined) lines.push(`request_max_retries = ${provider.requestMaxRetries}`);
  if (provider.streamMaxRetries !== undefined) lines.push(`stream_max_retries = ${provider.streamMaxRetries}`);
  if (provider.modelCatalogURL) lines.push(`model_catalog_url = ${tomlString(provider.modelCatalogURL)}`);
  if (provider.models?.length) lines.push(`models = [${provider.models.map(tomlString).join(', ')}]`);
  if (provider.replayReasoning) lines.push('replay_reasoning = true');
  if (provider.aws) {
    lines.push('', `[${head}.aws]`, `region = ${tomlString(provider.aws.region)}`);
    if (provider.aws.profile) lines.push(`profile = ${tomlString(provider.aws.profile)}`);
  }
  if (provider.azure) {
    lines.push('', `[${head}.azure]`);
    if (provider.azure.apiVersion) lines.push(`api_version = ${tomlString(provider.azure.apiVersion)}`);
    if (provider.azure.apiMode) lines.push(`api_mode = ${tomlString(provider.azure.apiMode)}`);
    if (provider.azure.useDeploymentBasedUrls !== undefined)
      lines.push(`use_deployment_based_urls = ${provider.azure.useDeploymentBasedUrls}`);
  }
  const table = (name: string, values: Record<string, string> | undefined) => {
    if (!values || !Object.keys(values).length) return;
    lines.push('', `[${head}.${name}]`);
    for (const [key, value] of Object.entries(values)) lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
  };
  table('query_params', provider.queryParams);
  table('http_headers', provider.httpHeaders);
  table('env_http_headers', provider.envHttpHeaders);
  const declaration = (name: string, value: NonNullable<Provider['reasoning']>) => {
    lines.push('', `[${head}.${name}]`);
    if (value.supported !== undefined) lines.push(`supported = ${value.supported}`);
    if (value.efforts) lines.push(`efforts = [${value.efforts.map(tomlString).join(', ')}]`);
    if (value.budgets) {
      lines.push('', `[${head}.${name}.budgets]`);
      for (const [level, tokens] of Object.entries(value.budgets)) lines.push(`${tomlKey(level)} = ${tokens}`);
    }
  };
  if (provider.reasoning) {
    declaration('reasoning', provider.reasoning);
    for (const [id, value] of Object.entries(provider.reasoning.models ?? {}))
      declaration(`reasoning.models.${tomlKey(id)}`, value);
  }
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
