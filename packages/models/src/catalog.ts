import {FutrynError, modelSchema, type ModelInfo, type SettingsStore} from '@futryn/contracts';
import {ProviderTransport} from './http';

export const providerFingerprint = (transport: ProviderTransport) => JSON.stringify(transport.provider);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FutrynError('PROTOCOL');
  return value as Record<string, unknown>;
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
  ) {}
  cached(): ModelInfo[] {
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
    this.store.update(s => {
      s.catalogs = s.catalogs.filter(c => c.accountId !== this.transport.account.id);
      s.catalogs.push({
        accountId: this.transport.account.id,
        providerFingerprint: providerFingerprint(this.transport),
        fetchedAt: new Date().toISOString(),
        models,
      });
    });
  }
  /** Remember that the provider rejected tool use for this model (ADR 0017); rediscovery resets it. */
  markToolsUnsupported(id: string): void {
    this.save(
      this.cached().map(model =>
        model.id === id
          ? modelSchema.parse({...model, capabilities: {...model.capabilities, tools: 'unsupported'}})
          : model,
      ),
    );
  }
  manual(id: string): ModelInfo {
    const model = normalizeModel(id, id, 'manual');
    const cache = this.cached().filter(m => m.id !== id);
    this.save([...cache, model]);
    return model;
  }
  /** Models listed in the host config (`models = [...]`) join the catalog as manual entries. */
  private configured(): ModelInfo[] {
    const cached = this.cached();
    const missing = (this.transport.provider.models ?? []).filter(id => !cached.some(m => m.id === id));
    if (!missing.length) return cached;
    const merged = [...cached, ...missing.map(id => normalizeModel(id, id, 'manual'))];
    this.save(merged);
    return merged;
  }
  async discover(signal?: AbortSignal): Promise<{models: ModelInfo[]; stale: boolean; warning?: string}> {
    const chatgpt = this.transport.provider.auth === 'oauth' && this.transport.provider.protocol === 'responses';
    if (this.transport.provider.catalog === 'manual' && !chatgpt)
      return {
        models: this.configured(),
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
          ? this.transport.provider.modelCatalogURL
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
          if (chatgpt && item.visibility !== 'list') continue;
          // Gemini lists embedding and generation models together; only expose generateContent models.
          if (
            kind === 'gemini' &&
            Array.isArray(item.supportedGenerationMethods) &&
            !item.supportedGenerationMethods.includes('generateContent')
          )
            continue;
          const rawID = chatgpt
            ? item.slug
            : kind === 'ollama'
              ? item.name
              : kind === 'gemini'
                ? String(item.name).replace(/^models\//, '')
                : item.id;
          const model = normalizeModel(rawID, chatgpt ? item.display_name : (item.displayName ?? item.name ?? rawID));
          // Only documented provider fields; do not guess limits from model IDs.
          if (kind === 'gemini') {
            if (Number.isInteger(item.inputTokenLimit) && Number(item.inputTokenLimit) > 0)
              model.contextLimit = Number(item.inputTokenLimit);
            if (Number.isInteger(item.outputTokenLimit) && Number(item.outputTokenLimit) > 0)
              model.outputLimit = Number(item.outputTokenLimit);
            if (model.contextLimit || model.outputLimit) {
              model.metadataSource = this.transport.provider.baseURL + '/models';
              model.metadataFetchedAt = model.fetchedAt;
            }
          }
          if (
            this.transport.provider.id === 'openrouter' &&
            this.transport.provider.baseURL === 'https://openrouter.ai/api/v1'
          ) {
            if (Number.isInteger(item.context_length) && Number(item.context_length) > 0)
              model.contextLimit = Number(item.context_length);
            const top =
              item.top_provider && typeof item.top_provider === 'object'
                ? (item.top_provider as Record<string, unknown>)
                : {};
            if (Number.isInteger(top.max_completion_tokens) && Number(top.max_completion_tokens) > 0)
              model.outputLimit = Number(top.max_completion_tokens);
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
        if (!next) break;
        if (typeof next !== 'string' || cursors.has(next) || page === 19) throw new FutrynError('PROTOCOL');
        cursors.add(next);
        cursor = next;
      }
      const merged = new Map((chatgpt ? [] : this.configured()).filter(m => m.source === 'manual').map(m => [m.id, m]));
      for (const model of models) merged.set(model.id, model);
      const result = [...merged.values()];
      if (chatgpt && !result.length) throw new FutrynError('NOT_FOUND');
      this.save(result);
      return {models: result, stale: false};
    } catch (error) {
      if (
        error instanceof FutrynError &&
        ['TRANSPORT', 'TIMEOUT'].includes(error.code) &&
        this.cached().length &&
        !signal?.aborted
      ) {
        return {
          models: this.cached(),
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
    const provider = object(data)[this.transport.provider.id];
    if (!provider) throw new FutrynError('NOT_FOUND');
    const entries = object(object(provider).models);
    const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    this.save(
      this.cached().map(model => {
        const raw = entries[model.id];
        if (!raw) return model;
        const item = object(raw);
        const limit = item.limit ? object(item.limit) : {};
        const cost = item.cost ? object(item.cost) : {};
        const input =
          typeof cost.input === 'number' && Number.isFinite(cost.input) && cost.input >= 0 ? cost.input : null;
        const output =
          typeof cost.output === 'number' && Number.isFinite(cost.output) && cost.output >= 0 ? cost.output : null;
        return modelSchema.parse({
          ...model,
          contextLimit: positive(limit.context),
          outputLimit: positive(limit.output),
          pricing:
            input !== null && output !== null
              ? {inputPerMillion: input, outputPerMillion: output, currency: 'USD'}
              : null,
          metadataSource: 'https://models.dev/api.json',
          metadataFetchedAt: new Date().toISOString(),
        });
      }),
    );
  }
}
