import { HannesError, modelSchema, type ModelInfo, type SettingsStore } from '@hannes/contracts';
import { ProviderTransport } from './http';

export const providerFingerprint = (transport: ProviderTransport) => JSON.stringify(transport.provider);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HannesError('PROTOCOL');
  return value as Record<string, unknown>;
};
export function normalizeModel(id: unknown, name: unknown, source: 'provider' | 'manual' = 'provider'): ModelInfo {
  try {
    return modelSchema.parse({ id, name: typeof name === 'string' ? name : id,
      capabilities: {}, contextLimit: null, outputLimit: null, pricing: null, source,
      fetchedAt: new Date().toISOString(), metadataSource: null, metadataFetchedAt: null });
  } catch { throw new HannesError('PROTOCOL'); }
}
export class ModelCatalog {
  constructor(private readonly store: SettingsStore, private readonly transport: ProviderTransport) {}
  cached(): ModelInfo[] {
    return this.store.read().catalogs.find(c => c.accountId === this.transport.account.id && c.providerFingerprint === providerFingerprint(this.transport))?.models ?? [];
  }
  private save(models: ModelInfo[]): void {
    this.store.update(s => {
      s.catalogs = s.catalogs.filter(c => c.accountId !== this.transport.account.id);
      s.catalogs.push({ accountId: this.transport.account.id, providerFingerprint: providerFingerprint(this.transport), fetchedAt: new Date().toISOString(), models });
    });
  }
  manual(id: string): ModelInfo {
    const model = normalizeModel(id, id, 'manual'); const cache = this.cached().filter(m => m.id !== id); this.save([...cache, model]); return model;
  }
  async discover(signal?: AbortSignal): Promise<{ models: ModelInfo[]; stale: boolean; warning?: string }> {
    if (this.transport.provider.catalog === 'manual') return { models: this.cached(), stale: false, warning: 'Manual catalog; model availability is unverified until generation succeeds.' };
    try {
      const models: ModelInfo[] = []; let cursor: string | undefined; const cursors = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const kind = this.transport.provider.catalog;
        const path = kind === 'ollama' ? '/api/tags' : 'models' + (cursor ? kind === 'gemini' ? '?pageToken=' + encodeURIComponent(cursor) : '?after_id=' + encodeURIComponent(cursor) : '');
        const data = object(await this.transport.json(path, signal));
        const items = kind === 'ollama' || kind === 'gemini' ? data.models : data.data;
        if (!Array.isArray(items) || items.length > 10000) throw new HannesError('PROTOCOL');
        for (const value of items) {
          const item = object(value);
          // Gemini lists embedding and generation models together; only expose generateContent models.
          if (kind === 'gemini' && Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes('generateContent')) continue;
          const rawID = kind === 'ollama' ? item.name : kind === 'gemini' ? String(item.name).replace(/^models\//, '') : item.id;
          models.push(normalizeModel(rawID, item.displayName ?? item.name ?? rawID));
        }
        if (models.length > 10000) throw new HannesError('PROTOCOL');
        const next = kind === 'gemini' ? data.nextPageToken : data.has_more === true ? data.last_id : undefined;
        if (!next) break;
        if (typeof next !== 'string' || cursors.has(next) || page === 19) throw new HannesError('PROTOCOL');
        cursors.add(next); cursor = next;
      }
      const merged = new Map(this.cached().filter(m => m.source === 'manual').map(m => [m.id, m]));
      for (const model of models) merged.set(model.id, model);
      const result = [...merged.values()]; this.save(result); return { models: result, stale: false };
    } catch (error) {
      if (error instanceof HannesError && ['TRANSPORT', 'TIMEOUT'].includes(error.code) && this.cached().length && !signal?.aborted) {
        return { models: this.cached(), stale: true, warning: 'Offline cached catalog; availability and entitlements may have changed.' };
      }
      throw error;
    }
  }
  search(query: string, models = this.cached()): ModelInfo[] {
    const q = query.toLowerCase(); return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }
  // Advisory metadata never elevates a capability to verified support.
  enrichModelsDev(data: unknown): void {
    const provider = object(data)[this.transport.provider.id];
    if (!provider) throw new HannesError('NOT_FOUND');
    const entries = object(object(provider).models);
    const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    this.save(this.cached().map(model => {
      const raw = entries[model.id]; if (!raw) return model;
      const item = object(raw); const limit = item.limit ? object(item.limit) : {}; const cost = item.cost ? object(item.cost) : {};
      const input = typeof cost.input === 'number' && Number.isFinite(cost.input) && cost.input >= 0 ? cost.input : null;
      const output = typeof cost.output === 'number' && Number.isFinite(cost.output) && cost.output >= 0 ? cost.output : null;
      return modelSchema.parse({ ...model, contextLimit: positive(limit.context), outputLimit: positive(limit.output),
        pricing: input !== null && output !== null ? { inputPerMillion: input, outputPerMillion: output, currency: 'USD' } : null,
        metadataSource: 'https://models.dev/api.json', metadataFetchedAt: new Date().toISOString() });
    }));
  }
}
