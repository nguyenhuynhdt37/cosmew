import {FutrynError, modelSchema, type ModelInfo, type SettingsStore} from '@cosmew/contracts';
import {ProviderTransport} from './http';
import {providerPresets} from './registry';
import {selectableReasoningEfforts} from './effort-wire';

export const providerFingerprint = (transport: ProviderTransport) => JSON.stringify(transport.provider);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FutrynError('PROTOCOL');
  return value as Record<string, unknown>;
};
const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
const capability = (value: unknown): ModelInfo['capabilities'][keyof ModelInfo['capabilities']] | null => {
  if (value === true || value === 'supported') return 'supported';
  if (value === false || value === 'unsupported') return 'unsupported';
  if (value === 'unknown') return 'unknown';
  return null;
};
/** Apply only capabilities explicitly advertised by a provider catalog. Model ids are not evidence. */
const applyAdvertisedCapabilities = (model: ModelInfo, item: Record<string, unknown>): void => {
  const advertised = item.capabilities;
  if (advertised && typeof advertised === 'object' && !Array.isArray(advertised)) {
    for (const key of ['text', 'tools', 'streaming', 'vision', 'reasoning'] as const) {
      const value = capability((advertised as Record<string, unknown>)[key]);
      if (value) model.capabilities[key] = value;
    }
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
  const modalities = item.modalities;
  const output =
    modalities && typeof modalities === 'object'
      ? (modalities as Record<string, unknown>).output
      : item.output_modalities;
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
    const model = normalizeModel(id, id, 'manual');
    model.manualOrigin = 'user';
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
      const models: ModelInfo[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const kind = this.transport.provider.catalog;
        const path = this.transport.provider.modelCatalogURL
          ? (() => {
              const url = new URL(this.transport.provider.modelCatalogURL!);
              if (cursor) url.searchParams.set(kind === 'gemini' ? 'pageToken' : 'after_id', cursor);
              return url.href;
            })()
          : kind === 'ollama'
            ? '/api/tags'
            : 'models' +
              (cursor
                ? kind === 'gemini'
                  ? '?pageToken=' + encodeURIComponent(cursor)
                  : '?after_id=' + encodeURIComponent(cursor)
                : '');
        const data = object(await this.transport.json(path, signal));
        const items = chatgpt || kind === 'ollama' || kind === 'gemini' ? data.models : data.data;
        if (!Array.isArray(items) || items.length > 10000) throw new FutrynError('PROTOCOL');
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
                : (item.id ?? item.name);
          const model = normalizeModel(
            rawID,
            chatgpt
              ? (item.display_name ?? item.displayName ?? rawID)
              : (item.display_name ?? item.displayName ?? item.name ?? rawID),
          );
          applyAdvertisedCapabilities(model, item);
          // Only documented provider fields; do not guess limits from model IDs.
          if (kind === 'gemini') {
            model.contextLimit = positiveInteger(item.inputTokenLimit);
            model.outputLimit = positiveInteger(item.outputTokenLimit);
            if (
              Array.isArray(item.supportedGenerationMethods) &&
              item.supportedGenerationMethods.includes('generateContent') &&
              model.capabilities.text !== 'unsupported'
            )
              model.capabilities.text = 'supported';
            else if (Array.isArray(item.supportedGenerationMethods)) model.capabilities.text = 'unsupported';
            if (model.contextLimit || model.outputLimit) {
              model.metadataSource = this.transport.provider.baseURL + '/models';
              model.metadataFetchedAt = model.fetchedAt;
            }
          }
          if (
            this.transport.provider.id === 'openrouter' &&
            this.transport.provider.baseURL === 'https://openrouter.ai/api/v1'
          ) {
            model.contextLimit = positiveInteger(item.context_length);
            const top =
              item.top_provider && typeof item.top_provider === 'object'
                ? (item.top_provider as Record<string, unknown>)
                : {};
            model.outputLimit = positiveInteger(top.max_completion_tokens);
            const pricing =
              item.pricing && typeof item.pricing === 'object' ? (item.pricing as Record<string, unknown>) : {};
            const price = (value: unknown) =>
              typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0
                ? Number(value) * 1000000
                : null;
            const input = price(pricing.prompt);
            const output = price(pricing.completion);
            if (input !== null && output !== null && Number.isFinite(input) && Number.isFinite(output))
              model.pricing = {inputPerMillion: input, outputPerMillion: output, currency: 'USD'};
            model.metadataSource = this.transport.provider.baseURL + '/models';
            model.metadataFetchedAt = model.fetchedAt;
          }
          models.push(model);
        }
        if (models.length > 10000) throw new FutrynError('PROTOCOL');
        const next = kind === 'gemini' ? data.nextPageToken : data.has_more === true ? data.last_id : undefined;
        if (data.has_more === true && typeof next !== 'string') throw new FutrynError('PROTOCOL');
        if (!next) break;
        if (typeof next !== 'string' || cursors.has(next) || page === 19) throw new FutrynError('PROTOCOL');
        cursors.add(next);
        cursor = next;
      }
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
        if (Object.keys(controls).length) enriched.reasoningOptions = controls;
        else delete enriched.reasoningOptions;
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
          contextLimit: positive(limit.context) ?? model.contextLimit,
          outputLimit: positive(limit.output) ?? model.outputLimit,
          pricing:
            input !== null && output !== null
              ? {inputPerMillion: input, outputPerMillion: output, currency: 'USD'}
              : model.pricing,
          metadataSource: 'https://models.dev/api.json',
          metadataFetchedAt: new Date().toISOString(),
        });
      }),
    );
  }
}
