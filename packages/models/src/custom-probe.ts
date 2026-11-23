import {
  FutrynError,
  ProviderBillingError,
  idSchema,
  isCodingModel,
  modelIdSchema,
  providerSchema,
  type Account,
  type CredentialVault,
  type ModelInfo,
  type NetworkPolicy,
  type Provider,
} from '@cosmew/contracts';
import {ProviderAdapter} from './adapter';
import {normalizeModel, readCatalogPages} from './catalog';
import {normalizeError, ProviderTransport, retryAfter, statusError} from './http';

export interface ParsedQuickProviderInput {
  baseURL: string;
  apiKey?: string;
  modelId?: string;
}

export interface ProbeCustomProviderOptions {
  baseURL: string;
  apiKey?: string;
  modelId?: string;
  fetch?: typeof fetch;
  chooseModel?: (models: readonly ModelInfo[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  existingProviderIds?: ReadonlySet<string>;
  reservedProviderIds?: ReadonlySet<string>;
  providerId?: string;
}

export interface ProbeCustomProviderResult {
  provider: Provider;
  models: ModelInfo[];
  selectedModel: ModelInfo;
  protocol: Provider['protocol'];
  catalog: Provider['catalog'];
  validation: 'generation';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Validate a custom provider base URL using the same boundary as `@cosmew/security`'s
 * `validateEndpoint`: HTTPS only (loopback HTTP allowed), no credentials, query, or fragment.
 */
export function validateQuickBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FutrynError('INVALID_INPUT');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new FutrynError('POLICY');
  }
  return url.href.replace(/\/$/, '');
}

/**
 * Parse a one-line third-party provider string:
 * - `https://gateway.example/v1 | api-key | model-id`
 * - `https://gateway.example/v1 | api-key`
 * - `https://gateway.example/v1`
 */
export function parseQuickProviderInput(raw: string): ParsedQuickProviderInput {
  const trimmed = raw.trim();
  if (!trimmed) throw new FutrynError('INVALID_INPUT');
  const parts = trimmed.split('|');
  if (parts.length > 3) throw new FutrynError('INVALID_INPUT');
  const urlPart = parts[0]?.trim() ?? '';
  if (!urlPart) throw new FutrynError('INVALID_INPUT');
  const baseURL = validateQuickBaseURL(urlPart);

  const keyPart = parts[1]?.trim() ?? '';
  if (keyPart.length > 8192 || CONTROL_CHARS.test(keyPart)) throw new FutrynError('INVALID_INPUT');

  const modelPart = parts[2]?.trim() ?? '';
  if (modelPart && !modelIdSchema.safeParse(modelPart).success) throw new FutrynError('INVALID_INPUT');

  return {
    baseURL,
    ...(keyPart ? {apiKey: keyPart} : {}),
    ...(modelPart ? {modelId: modelPart} : {}),
  };
}

/** Derive a unique, host-config-safe provider ID from a validated base URL. */
export function deriveProviderId(
  baseURL: string,
  existingIds: ReadonlySet<string> = new Set(),
  reservedIds: ReadonlySet<string> = new Set(),
): string {
  const url = new URL(validateQuickBaseURL(baseURL));
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const rawBase = LOOPBACK_HOSTS.has(url.hostname) && url.port ? `${host}-${url.port}` : host;
  let base = rawBase
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!base || !/^[a-zA-Z0-9]/.test(base)) base = base ? `custom-${base}` : 'custom-provider';
  base = base.slice(0, 80);

  if (!existingIds.has(base) && !reservedIds.has(base) && idSchema.safeParse(base).success) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base.slice(0, 99 - String(suffix).length - 1)}-${suffix}`;
    if (!existingIds.has(candidate) && !reservedIds.has(candidate) && idSchema.safeParse(candidate).success)
      return candidate;
  }
  throw new FutrynError('INVALID_INPUT');
}

/** Compact human-readable token budget label (e.g. `1M`, `200k`, `64k`). */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    if (tokens === 1_048_576 || tokens === 1_000_000) return '1M';
    if (tokens === 2_097_152 || tokens === 2_000_000) return '2M';
    const millions = tokens / 1_000_000;
    const rounded = Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace(/\.0$/, '');
    return `${rounded}M`;
  }
  if (tokens >= 1_000) {
    if (tokens >= 4096 && tokens % 1024 === 0 && tokens % 1000 !== 0) return `${tokens / 1024}k`;
    if (tokens % 1000 === 0) return `${tokens / 1000}k`;
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(tokens);
}

function protocolOrderFor(baseURL: string): Provider['protocol'][] {
  const url = new URL(baseURL);
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === 'api.anthropic.com' || path.includes('/anthropic')) return ['anthropic', 'chat', 'responses', 'gemini'];
  if (host === 'generativelanguage.googleapis.com' || path.includes('/gemini'))
    return ['gemini', 'chat', 'responses', 'anthropic'];
  return ['chat', 'responses', 'anthropic', 'gemini'];
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new FutrynError('PROTOCOL');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => {});
        throw new FutrynError('PROTOCOL');
      }
      text += decoder.decode(chunk.value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof FutrynError) throw error;
    throw new FutrynError('PROTOCOL');
  }
}

function detectCatalogKind(data: unknown, preferred: Provider['protocol']): Provider['catalog'] | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const envelope = data as Record<string, unknown>;
  if (Array.isArray(envelope.data)) {
    const first = envelope.data[0];
    if (
      preferred === 'anthropic' &&
      first &&
      typeof first === 'object' &&
      (first as Record<string, unknown>).type === 'model'
    ) {
      return 'anthropic';
    }
    return 'openai';
  }
  if (Array.isArray(envelope.models)) {
    const first = envelope.models[0];
    if (first && typeof first === 'object') {
      const item = first as Record<string, unknown>;
      if (
        'supportedGenerationMethods' in item ||
        'inputTokenLimit' in item ||
        (typeof item.name === 'string' && item.name.startsWith('models/'))
      ) {
        return 'gemini';
      }
    }
    return preferred === 'gemini' ? 'gemini' : 'ollama';
  }
  return null;
}

const STOP_PROBING_ERRORS = new Set(['AUTH', 'FORBIDDEN', 'CANCELLED', 'RATE_LIMIT', 'PROVIDER_BILLING']);
const FALLBACK_PROTOCOL_ERRORS = new Set(['NOT_FOUND', 'PROTOCOL', 'UNSUPPORTED', 'INVALID_INPUT']);

async function drainStreamProbe(adapter: ProviderAdapter, modelId: string, signal: AbortSignal): Promise<void> {
  let completed = false;
  for await (const event of adapter.stream(
    {
      requestId: crypto.randomUUID(),
      modelId,
      messages: [{role: 'user', content: 'Reply with OK.'}],
      maxOutputTokens: 16,
      tools: [],
    },
    signal,
  )) {
    if (event.type === 'completed') completed = true;
  }
  if (!completed) throw new FutrynError('PROTOCOL');
}

/**
 * Auto-probe a third-party provider endpoint:
 * 1. Fetch `GET <baseURL>/models` to detect catalog format and parse full metadata (context/output limits, capabilities, pricing).
 * 2. Pick target model (`modelId` if provided, otherwise first coding-capable model).
 * 3. Probe generation with `maxOutputTokens: 16` across candidate wire protocols (`chat` first for gateways).
 */
export async function probeCustomProvider(options: ProbeCustomProviderOptions): Promise<ProbeCustomProviderResult> {
  let baseURL = validateQuickBaseURL(options.baseURL);
  const apiKey = options.apiKey?.trim() || undefined;
  if (apiKey && (apiKey.length > 8192 || CONTROL_CHARS.test(apiKey))) throw new FutrynError('INVALID_INPUT');
  let modelId = options.modelId?.trim() || undefined;
  if (modelId && !modelIdSchema.safeParse(modelId).success) throw new FutrynError('INVALID_INPUT');

  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const existingIds = options.existingProviderIds ?? new Set<string>();
  const reservedIds = options.reservedProviderIds ?? new Set<string>();
  const providerId = options.providerId ?? deriveProviderId(baseURL, existingIds, reservedIds);
  if (!idSchema.safeParse(providerId).success) throw new FutrynError('INVALID_INPUT');

  const protocols = protocolOrderFor(baseURL);
  const firstProtocol = protocols[0]!;
  let detectedCatalog: Provider['catalog'] = 'manual';
  let discoveredModels: ModelInfo[] = [];

  // Step 1: Probe GET <baseURL>/models
  const catalogSignal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)]);
  const headers: Record<string, string> = {};
  if (apiKey) {
    if (firstProtocol === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (firstProtocol === 'gemini') {
      headers['x-goog-api-key'] = apiKey;
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
  }
  const fetchCatalog = async (url: string): Promise<Response> => {
    try {
      return await fetchImpl(url, {method: 'GET', headers, redirect: 'error', signal: catalogSignal});
    } catch (error) {
      throw catalogSignal.aborted ? normalizeError(error, catalogSignal) : new FutrynError('TRANSPORT', true);
    }
  };
  let response = await fetchCatalog(`${baseURL}/models`);
  if ((response.status === 404 || response.status === 405) && new URL(baseURL).pathname === '/') {
    const fallback = await fetchCatalog(`${baseURL}/v1/models`);
    if (fallback.status === 404 || fallback.status === 405) await fallback.body?.cancel().catch(() => {});
    else {
      await response.body?.cancel().catch(() => {});
      response = fallback;
      baseURL += '/v1';
    }
  }

  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    throw new FutrynError('AUTH');
  }
  if (response.status === 402) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderBillingError();
  }
  if (response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new FutrynError('FORBIDDEN');
  }
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    await response.body?.cancel().catch(() => {});
    throw new FutrynError('RATE_LIMIT', true, retryAfter(retry));
  }
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel().catch(() => {});
    detectedCatalog = 'manual';
    if (!modelId && !options.chooseModel) throw new FutrynError('NOT_FOUND');
  } else if (!response.ok) {
    const retry = response.headers.get('retry-after');
    await response.body?.cancel().catch(() => {});
    throw statusError(response.status, retry);
  } else {
    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      if ((!modelId && !options.chooseModel) || catalogSignal.aborted) throw error;
      detectedCatalog = 'manual';
      payload = null;
    }
    if (payload !== null) {
      const kind = detectCatalogKind(payload, firstProtocol);
      if (kind) {
        detectedCatalog = kind;
        discoveredModels = await readCatalogPages(payload, kind, baseURL, async cursor => {
          const next = new URL(`${baseURL}/models`);
          next.searchParams.set(kind === 'gemini' ? 'pageToken' : 'after_id', cursor);
          const page = await fetchCatalog(next.href);
          if (page.ok) return readBoundedJson(page);
          await page.body?.cancel().catch(() => {});
          throw statusError(page.status, page.headers.get('retry-after'));
        });
      } else if (modelId || options.chooseModel) {
        detectedCatalog = 'manual';
      } else {
        throw new FutrynError('PROTOCOL');
      }
    }
  }

  // Step 2: Choose target model (preserve rich catalog metadata when modelId exists in /models)
  if (!modelId && options.chooseModel) {
    modelId = (await options.chooseModel(structuredClone(discoveredModels), options.signal)).trim();
    if (options.signal?.aborted) throw new FutrynError('CANCELLED');
    if (!modelIdSchema.safeParse(modelId).success) throw new FutrynError('INVALID_INPUT');
  }
  let selectedModel: ModelInfo | undefined;
  if (modelId) {
    selectedModel = discoveredModels.find(model => model.id === modelId);
    if (!selectedModel) {
      selectedModel = normalizeModel(modelId, modelId, 'manual');
      selectedModel.manualOrigin = 'user';
    }
  } else {
    selectedModel = discoveredModels.find(model => isCodingModel(model)) ?? discoveredModels[0];
  }
  if (!selectedModel) throw new FutrynError('NOT_FOUND');

  // Step 3: Probe wire protocol with a lightweight generation request
  const probeKeyId = crypto.randomUUID();
  const probeAccount: Account = {
    id: crypto.randomUUID(),
    providerId,
    alias: providerId,
    credential: apiKey ? {kind: 'keyring', key: probeKeyId} : {kind: 'none'},
    status: 'unvalidated',
    validatedAt: null,
    authGeneration: 1,
  };
  const probeVault: CredentialVault = {
    get: async ref => (ref.kind === 'keyring' && ref.key === probeKeyId ? apiKey : undefined),
    set: async () => {},
    delete: async () => {},
  };
  const probePolicy: NetworkPolicy = {authorize: () => {}};

  const orderedProtocols: Provider['protocol'][] =
    detectedCatalog === 'anthropic'
      ? ['anthropic', 'chat', 'responses', 'gemini']
      : detectedCatalog === 'gemini'
        ? ['gemini', 'chat', 'responses', 'anthropic']
        : protocols;

  let workingProvider: Provider | undefined;
  let lastError: FutrynError | undefined;

  for (const protocol of orderedProtocols) {
    // Some Chat gateways stream successfully but reject the optional usage extension.
    for (const streamUsage of protocol === 'chat' ? [true, false] : [undefined]) {
      if (options.signal?.aborted) throw new FutrynError('CANCELLED');
      const probeSignal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ]);
      const candidate = providerSchema.parse({
        id: providerId,
        name: providerId,
        protocol,
        baseURL,
        auth: apiKey ? 'api-key' : 'none',
        catalog: detectedCatalog,
        metadataVersion: 1,
        timeoutMs,
        requestMaxRetries: 0,
        streamUsage,
        ...(detectedCatalog === 'manual' ? {models: [selectedModel.id]} : {}),
      });
      try {
        const transport = new ProviderTransport(candidate, probeAccount, probeVault, probePolicy, fetchImpl);
        await drainStreamProbe(
          new ProviderAdapter(transport, selectedModel.id, selectedModel),
          selectedModel.id,
          probeSignal,
        );
        workingProvider = candidate;
        break;
      } catch (error) {
        const safe = normalizeError(error, probeSignal);
        lastError = safe;
        if (options.signal?.aborted) throw new FutrynError('CANCELLED');
        if (STOP_PROBING_ERRORS.has(safe.code) || safe.code === 'TIMEOUT') throw safe;
        if (!FALLBACK_PROTOCOL_ERRORS.has(safe.code) && safe.code !== 'TRANSPORT') throw safe;
        if (!['INVALID_INPUT', 'PROTOCOL', 'UNSUPPORTED'].includes(safe.code)) break;
      }
    }
    if (workingProvider) break;
  }

  if (!workingProvider) throw lastError ?? new FutrynError('PROTOCOL');

  const displayName = new URL(baseURL).host.replace(CONTROL_CHARS, '').slice(0, 100) || providerId;
  const provider = providerSchema.parse({
    ...workingProvider,
    name: displayName,
    timeoutMs: 60000,
    requestMaxRetries: undefined,
    source: 'config',
  });

  return {
    provider,
    models: discoveredModels,
    selectedModel,
    protocol: provider.protocol,
    catalog: detectedCatalog,
    validation: 'generation',
  };
}
