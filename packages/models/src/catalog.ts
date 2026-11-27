import {FutrynError, modelSchema, type ModelInfo, type Provider, type SettingsStore} from '@cosmew/contracts';
import {bedrockControlPlaneOrigin, ProviderTransport} from './http';
import {providerPresets} from './registry';
import {selectableReasoningEfforts} from './effort-wire';

export const providerFingerprint = (transport: ProviderTransport) => JSON.stringify(transport.provider);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FutrynError('PROTOCOL');
  return value as Record<string, unknown>;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const firstPositiveInteger = (...values: unknown[]): number | null => {
  for (const value of values) {
    const parsed = positiveInteger(value);
    if (parsed !== null) return parsed;
  }
  return null;
};
const nonNegativeNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
};
const capability = (value: unknown): ModelInfo['capabilities'][keyof ModelInfo['capabilities']] | null => {
  if (value === true || value === 'supported') return 'supported';
  if (value === false || value === 'unsupported') return 'unsupported';
  if (value === 'unknown') return 'unknown';
  return null;
};
/** Apply only capabilities explicitly advertised by a provider catalog. Model ids are not evidence. */
const applyAdvertisedCapabilities = (model: ModelInfo, item: Record<string, unknown>): void => {
  const advertised = record(item.capabilities);
  if (advertised) {
    for (const key of ['text', 'tools', 'streaming', 'vision', 'reasoning'] as const) {
      const value = capability(advertised[key]);
      if (value) model.capabilities[key] = value;
    }
    const controls: NonNullable<ModelInfo['reasoningOptions']> = {...model.reasoningOptions};
    if (advertised.thinkingCanDisable === true) controls.toggle = true;
    const range = record(advertised.thinkingRange);
    if (range && typeof range.min === 'number' && Number.isSafeInteger(range.min) && range.min >= 0) {
      controls.budgetMin = controls.budgetMin === undefined ? range.min : Math.max(controls.budgetMin, range.min);
    }
    if (Object.keys(controls).length) model.reasoningOptions = controls;
  }
  const input = Array.isArray(item.input_modalities) ? item.input_modalities : [];
  if (input.some(value => typeof value === 'string' && value.toLowerCase() === 'image'))
    model.capabilities.vision = 'supported';
  if (input.some(value => typeof value === 'string' && value.toLowerCase() === 'text'))
    model.capabilities.text = 'supported';
  const params = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
  const names = new Set(
    params.filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase()),
  );
  if (names.has('tools') || names.has('tool_choice')) model.capabilities.tools = 'supported';
  if (names.has('reasoning') || names.has('reasoning_effort') || names.has('reasoning_efforts'))
    model.capabilities.reasoning = 'supported';
  const modalities = record(item.modalities);
  const output = modalities ? modalities.output : item.output_modalities;
  if (Array.isArray(output)) model.capabilities.text = output.includes('text') ? 'supported' : 'unsupported';
  if (['image', 'embedding', 'video', 'transcription', 'speech', 'reranking', 'realtime'].includes(String(item.type)))
    model.capabilities.text = 'unsupported';
  if (typeof item.tool_call === 'boolean') model.capabilities.tools = item.tool_call ? 'supported' : 'unsupported';
  const efforts = item.reasoning_efforts;
  if (Array.isArray(efforts)) {
    const values = efforts.filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (values.length) {
      model.reasoningEfforts = [...new Set(values)].slice(0, 20);
      model.capabilities.reasoning = 'supported';
    }
  }
};
/**
 * Apply explicitly advertised limits, capabilities and pricing from any provider `/models` entry.
 * Only documented/explicit provider fields are read; model IDs are never guessed (ADR 0078, ADR 0113).
 */
export function applyCatalogMetadata(
  model: ModelInfo,
  item: Record<string, unknown>,
  baseURL: string,
  kind?: Provider['catalog'],
): void {
  applyAdvertisedCapabilities(model, item);
  if (kind === 'gemini' && Array.isArray(item.supportedGenerationMethods)) {
    if (item.supportedGenerationMethods.includes('generateContent') && model.capabilities.text !== 'unsupported')
      model.capabilities.text = 'supported';
    else model.capabilities.text = 'unsupported';
  }
  if (kind === 'bedrock') {
    const inputMods = Array.isArray(item.inputModalities)
      ? item.inputModalities.filter((v): v is string => typeof v === 'string').map(v => v.toUpperCase())
      : [];
    const outputMods = Array.isArray(item.outputModalities)
      ? item.outputModalities.filter((v): v is string => typeof v === 'string').map(v => v.toUpperCase())
      : [];
    if (outputMods.length) model.capabilities.text = outputMods.includes('TEXT') ? 'supported' : 'unsupported';
    if (inputMods.includes('IMAGE')) model.capabilities.vision = 'supported';
    if (typeof item.responseStreamingSupported === 'boolean') {
      model.capabilities.streaming = item.responseStreamingSupported ? 'supported' : 'unsupported';
    }
  }
  const caps = record(item.capabilities);
  const limits = record(item.limits);
  const limit = record(item.limit);
  const top = record(item.top_provider);

  const contextLimit = firstPositiveInteger(
    item.context_length,
    item.context_window,
    item.max_context_length,
    item.input_token_limit,
    item.inputTokenLimit,
    item.max_input_tokens,
    caps?.contextWindow,
    caps?.context_window,
    limits?.context,
    limit?.context,
    top?.context_length,
  );
  if (contextLimit !== null) model.contextLimit = contextLimit;

  const outputLimit = firstPositiveInteger(
    item.max_completion_tokens,
    item.max_output_tokens,
    item.output_token_limit,
    item.outputTokenLimit,
    caps?.maxOutput,
    caps?.max_output_tokens,
    limits?.output,
    limit?.output,
    top?.max_completion_tokens,
    top?.max_output_tokens,
  );
  if (outputLimit !== null) model.outputLimit = outputLimit;

  const pricing = record(item.pricing);
  if (pricing) {
    const promptPerToken = nonNegativeNumber(pricing.prompt);
    const completionPerToken = nonNegativeNumber(pricing.completion);
    if (promptPerToken !== null && completionPerToken !== null) {
      const inputPerMillion = promptPerToken * 1_000_000;
      const outputPerMillion = completionPerToken * 1_000_000;
      if (Number.isFinite(inputPerMillion) && Number.isFinite(outputPerMillion))
        model.pricing = {inputPerMillion, outputPerMillion, currency: 'USD'};
    } else {
      const inputPerMillion = nonNegativeNumber(pricing.input);
      const outputPerMillion = nonNegativeNumber(pricing.output);
      if (inputPerMillion !== null && outputPerMillion !== null)
        model.pricing = {inputPerMillion, outputPerMillion, currency: 'USD'};
    }
  }

  if (model.contextLimit !== null || model.outputLimit !== null || model.pricing !== null) {
    model.metadataSource = (baseURL.replace(/\/$/, '') + '/models').slice(0, 2048);
    model.metadataFetchedAt = model.fetchedAt;
  }
}

/** Parse one `/models` (or `/api/tags`) JSON response page into normalized `ModelInfo` records. */
export function parseCatalogPage(
  raw: unknown,
  kind: Provider['catalog'],
  baseURL: string,
  chatgpt = false,
): {models: ModelInfo[]; data: Record<string, unknown>} {
  const data = object(raw);
  const items =
    chatgpt || kind === 'ollama' || kind === 'gemini'
      ? data.models
      : kind === 'bedrock'
        ? data.modelSummaries
        : data.data;
  if (!Array.isArray(items) || items.length > 10000) throw new FutrynError('PROTOCOL');
  const models: ModelInfo[] = [];
  for (const value of items) {
    const item = object(value);
    // Compatible ChatGPT endpoints may omit visibility; hide only an explicit non-list entry.
    if (chatgpt && item.visibility !== undefined && item.visibility !== 'list') continue;
    const rawID = chatgpt
      ? item.slug
      : kind === 'ollama'
        ? item.name
        : kind === 'gemini'
          ? String(item.name).replace(/^models\//, '')
          : kind === 'bedrock'
            ? (item.modelId ?? item.inferenceProfileId ?? item.id)
            : (item.id ?? item.name);
    const model = normalizeModel(
      rawID,
      chatgpt
        ? (item.display_name ?? item.displayName ?? rawID)
        : kind === 'bedrock'
          ? (item.modelName ?? item.inferenceProfileName ?? rawID)
          : (item.display_name ?? item.displayName ?? item.name ?? rawID),
    );
    applyCatalogMetadata(model, item, baseURL, kind);
    models.push(modelSchema.parse(model));
  }
  return {models, data};
}

/** Shared pagination for login and catalog refresh. */
export async function readCatalogPages(
  first: unknown,
  kind: Provider['catalog'],
  baseURL: string,
  nextPage: (cursor: string) => Promise<unknown>,
  chatgpt = false,
): Promise<ModelInfo[]> {
  const models = new Map<string, ModelInfo>();
  const cursors = new Set<string>();
  let payload = first;
  let count = 0;
  for (let page = 0; page < 20; page++) {
    const {models: entries, data} = parseCatalogPage(payload, kind, baseURL, chatgpt);
    count += entries.length;
    if (count > 10000) throw new FutrynError('PROTOCOL');
    for (const model of entries) models.set(model.id, model);
    const next = kind === 'gemini' ? data.nextPageToken : data.has_more === true ? data.last_id : undefined;
    if (data.has_more === true && typeof next !== 'string') throw new FutrynError('PROTOCOL');
    if (!next) return [...models.values()];
    if (typeof next !== 'string' || cursors.has(next) || page === 19) throw new FutrynError('PROTOCOL');
    cursors.add(next);
    payload = await nextPage(next);
  }
  throw new FutrynError('PROTOCOL');
}
export function normalizeModel(id: unknown, name: unknown, source: 'provider' | 'manual' = 'provider'): ModelInfo {
  try {
    return modelSchema.parse({
      id,
      name: typeof name === 'string' ? name : id,
      capabilities: {},
      contextLimit: null,
      outputLimit: null,
      pricing: null,
      source,
      fetchedAt: new Date().toISOString(),
      metadataSource: null,
      metadataFetchedAt: null,
    });
  } catch {
    throw new FutrynError('PROTOCOL');
  }
}
export class ModelCatalog {
  constructor(
    private readonly store: SettingsStore,
    private readonly transport: ProviderTransport,
    private readonly loadMetadata?: (signal?: AbortSignal) => Promise<unknown>,
  ) {}
  /** One resolution boundary for discovery, cache and manual IDs; user config wins. */
  private resolve(model: ModelInfo): ModelInfo {
    const config = this.transport.provider.reasoning;
    const local = config?.models?.[model.id];
    const supported =
      local?.supported ?? (local?.efforts ? true : (config?.supported ?? (config?.efforts ? true : undefined)));
    const efforts = local?.efforts ?? config?.efforts ?? model.reasoningEfforts ?? model.reasoningOptions?.efforts;
    const resolved = {...model, capabilities: {...model.capabilities}};
    if (supported !== undefined) resolved.capabilities.reasoning = supported ? 'supported' : 'unsupported';
    if (resolved.capabilities.reasoning === 'unsupported') {
      delete resolved.reasoningEfforts;
      delete resolved.defaultReasoningEffort;
    } else if (efforts) {
      resolved.reasoningEfforts = [...efforts];
      if (resolved.defaultReasoningEffort && !efforts.includes(resolved.defaultReasoningEffort))
        delete resolved.defaultReasoningEffort;
    }
    return resolved;
  }
  cached(): ModelInfo[] {
    return this.rawCache().map(model => this.selectable(model));
  }
  private selectable(model: ModelInfo): ModelInfo {
    return selectableReasoningEfforts(this.transport.provider, this.resolve(model));
  }
  private rawCache(): ModelInfo[] {
    return (
      this.store
        .read()
        .catalogs.find(
          c =>
            c.accountId === this.transport.account.id && c.providerFingerprint === providerFingerprint(this.transport),
        )?.models ?? []
    );
  }
  private save(models: ModelInfo[]): void {
    const accountId = this.transport.account.id;
    const fingerprint = providerFingerprint(this.transport);
    this.store.update(s => {
      // One account can legitimately have several providers/endpoints. Replacing the whole
      // account catalog made rediscovering one provider silently erase the others.
      s.catalogs = s.catalogs.filter(c => !(c.accountId === accountId && c.providerFingerprint === fingerprint));
      s.catalogs.push({
        accountId,
        providerFingerprint: fingerprint,
        fetchedAt: new Date().toISOString(),
        models,
      });
    });
  }
  /** Seed a newly connected account with the catalog used to choose and verify its model. */
  async seedVerifiedCatalog(models: readonly ModelInfo[], selected: ModelInfo, signal?: AbortSignal) {
    this.save(models.some(model => model.id === selected.id) ? [...models] : [...models, selected]);
    return this.refreshMetadata(signal);
  }
  /** Remember that the provider rejected tool use for this model (ADR 0017); rediscovery resets it. */
  markToolsUnsupported(id: string): void {
    this.save(
      this.rawCache().map(model =>
        model.id === id
          ? modelSchema.parse({...model, capabilities: {...model.capabilities, tools: 'unsupported'}})
          : model,
      ),
    );
  }
  manual(id: string): ModelInfo {
    const existing = this.rawCache().find(m => m.id === id);
    const model = existing
      ? modelSchema.parse({
          ...existing,
          source: 'manual',
          manualOrigin: 'user',
        })
      : {
          ...normalizeModel(id, id, 'manual'),
          manualOrigin: 'user' as const,
        };
    const cache = this.rawCache().filter(m => m.id !== id);
    this.save([...cache, model]);
    return this.selectable(model);
  }
  /** Models listed in the host config (`models = [...]`) join the catalog as manual entries. */
  private configured(): ModelInfo[] {
    const cached = this.rawCache();
    const missing = (this.transport.provider.models ?? []).filter(id => !cached.some(m => m.id === id));
    if (!missing.length) return cached;
    const merged = [
      ...cached,
      ...missing.map(id => ({...normalizeModel(id, id, 'manual'), manualOrigin: 'provider-config' as const})),
    ];
    this.save(merged);
    return merged;
  }
  private async enriched(models: ModelInfo[], signal?: AbortSignal): Promise<ModelInfo[]> {
    if (!this.loadMetadata) return models;
    try {
      this.enrichModelsDev(await this.loadMetadata(signal));
      return this.cached();
    } catch {
      // Advisory metadata failure must never prevent using the provider or its cache.
      return models;
    }
  }
  /** Refresh advisory metadata on existing catalogs without rediscovering provider models. */
  async refreshMetadata(signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.enriched(this.cached(), signal);
  }
  async discover(signal?: AbortSignal): Promise<{models: ModelInfo[]; stale: boolean; warning?: string}> {
    const chatgpt = this.transport.provider.auth === 'oauth' && this.transport.provider.protocol === 'responses';
    if (this.transport.provider.catalog === 'manual' && !chatgpt)
      return {
        models: await this.enriched(
          this.configured().map(model => this.selectable(model)),
          signal,
        ),
        stale: false,
        warning: 'Manual catalog; model availability is unverified until generation succeeds.',
      };
    try {
      const kind = this.transport.provider.catalog;
      const readPage = (cursor?: string) => {
        const path = this.transport.provider.modelCatalogURL
          ? (() => {
              const url = new URL(this.transport.provider.modelCatalogURL!);
              if (cursor) url.searchParams.set(kind === 'gemini' ? 'pageToken' : 'after_id', cursor);
              return url.href;
            })()
          : kind === 'ollama'
            ? '/api/tags'
            : kind === 'bedrock'
              ? (() => {
                  const controlOrigin = bedrockControlPlaneOrigin(this.transport.provider);
                  const query = 'foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND';
                  return controlOrigin ? `${controlOrigin}/${query}` : query;
                })()
              : this.transport.provider.protocol === 'azure' && this.transport.provider.azure?.useDeploymentBasedUrls
                ? 'openai/models'
                : 'models' +
                  (cursor
                    ? kind === 'gemini'
                      ? '?pageToken=' + encodeURIComponent(cursor)
                      : '?after_id=' + encodeURIComponent(cursor)
                    : '');
        return this.transport.json(path, signal);
      };
      const models = await readCatalogPages(await readPage(), kind, this.transport.provider.baseURL, readPage, chatgpt);
      const merged = new Map(
        // ChatGPT's account catalog supersedes configured preset fallbacks. Keep explicit
        // user IDs, including legacy manual IDs that are not configured fallbacks.
        (chatgpt
          ? this.rawCache().filter(
              m =>
                m.manualOrigin === 'user' ||
                (m.manualOrigin === undefined && !this.transport.provider.models?.includes(m.id)),
            )
          : this.configured()
        )
          .filter(m => m.source === 'manual')
          .map(m => [m.id, m]),
      );
      for (const model of models) {
        const previous = merged.get(model.id);
        if (previous?.source === 'manual') {
          model.source = 'manual';
          if (previous.manualOrigin) model.manualOrigin = previous.manualOrigin;
        }
        merged.set(model.id, model);
      }
      const result = [...merged.values()];
      if (chatgpt && !result.length) throw new FutrynError('NOT_FOUND');
      this.save(result);
      return {
        models: await this.enriched(
          result.map(model => this.selectable(model)),
          signal,
        ),
        stale: false,
      };
    } catch (error) {
      if (
        error instanceof FutrynError &&
        ['TRANSPORT', 'TIMEOUT', 'RATE_LIMIT'].includes(error.code) &&
        this.cached().length &&
        !signal?.aborted
      ) {
        return {
          models: await this.enriched(this.cached(), signal),
          stale: true,
          warning: 'Offline cached catalog; availability and entitlements may have changed.',
        };
      }
      throw error;
    }
  }
  search(query: string, models = this.cached()): ModelInfo[] {
    const q = query.toLowerCase();
    return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }
  // Advisory metadata never elevates a capability to verified support.
  enrichModelsDev(data: unknown): void {
    const providers = object(data);
    // Exact provider key first; custom aliases may match an explicitly advertised API URL.
    // No model names, display names, host substrings or provider-family guesses.
    const endpoint = this.transport.provider.baseURL.replace(/\/$/, '');
    const matches = Object.values(providers).filter(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const api = (value as Record<string, unknown>).api;
      return typeof api === 'string' && api.replace(/\/$/, '') === endpoint;
    });
    const presetKeys = [
      ...new Set(
        providerPresets.filter(p => p.baseURL.replace(/\/$/, '') === endpoint && providers[p.id]).map(p => p.id),
      ),
    ];
    const provider =
      providers[this.transport.provider.id] ??
      (matches.length === 1
        ? matches[0]
        : matches.length === 0 && presetKeys.length === 1
          ? providers[presetKeys[0]!]
          : undefined);
    if (!provider) throw new FutrynError('NOT_FOUND');
    const entries = object(object(provider).models);
    const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    this.save(
      this.rawCache().map(model => {
        const raw = entries[model.id];
        if (!raw) return model;
        const item = object(raw);
        const enriched = {...model, capabilities: {...model.capabilities}};
        const advisory = normalizeModel(model.id, model.name);
        applyAdvertisedCapabilities(advisory, item);
        // Advisory evidence may exclude a model from listing without rewriting provider
        // or user capability claims. Only reasoning follows ADR 0078's precedence below.
        enriched.codingEvidence = {text: advisory.capabilities.text, tools: advisory.capabilities.tools};
        const options = Array.isArray(item.reasoning_options) ? item.reasoning_options : [];
        const efforts: string[] = [];
        const controls: NonNullable<ModelInfo['reasoningOptions']> = {};
        let reasoning = item.reasoning === true;
        for (const option of options) {
          if (!option || typeof option !== 'object') continue;
          const entry = option as Record<string, unknown>;
          if (['effort', 'toggle', 'budget_tokens'].includes(String(entry.type))) reasoning = true;
          if (entry.type === 'toggle') controls.toggle = true;
          if (
            entry.type === 'budget_tokens' &&
            typeof entry.min === 'number' &&
            Number.isSafeInteger(entry.min) &&
            entry.min >= 0
          )
            controls.budgetMin = Math.max(controls.budgetMin ?? 0, entry.min);
          if (entry.type === 'effort' && Array.isArray(entry.values)) {
            for (const value of entry.values) {
              if (
                typeof value === 'string' &&
                ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value) &&
                !efforts.includes(value) &&
                efforts.length < 20
              )
                efforts.push(value);
            }
          }
        }
        if (efforts.length) controls.efforts = efforts;
        if (Object.keys(controls).length) enriched.reasoningOptions = {...enriched.reasoningOptions, ...controls};
        else if (!model.reasoningOptions) delete enriched.reasoningOptions;
        if (reasoning && enriched.capabilities.reasoning !== 'unsupported')
          enriched.capabilities.reasoning = 'supported';
        const limit = item.limit ? object(item.limit) : {};
        const cost = item.cost ? object(item.cost) : {};
        const input =
          typeof cost.input === 'number' && Number.isFinite(cost.input) && cost.input >= 0 ? cost.input : null;
        const output =
          typeof cost.output === 'number' && Number.isFinite(cost.output) && cost.output >= 0 ? cost.output : null;
        return modelSchema.parse({
          ...enriched,
          // Advisory metadata fills gaps but never erases provider-reported values.
          contextLimit: model.contextLimit ?? positive(limit.context),
          outputLimit: model.outputLimit ?? positive(limit.output),
          pricing:
            model.pricing ??
            (input !== null && output !== null
              ? {inputPerMillion: input, outputPerMillion: output, currency: 'USD'}
              : null),
          metadataSource: model.metadataSource ?? 'https://models.dev/api.json',
          metadataFetchedAt: model.metadataFetchedAt ?? new Date().toISOString(),
        });
      }),
    );
  }
}
