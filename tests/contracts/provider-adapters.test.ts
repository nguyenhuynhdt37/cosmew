import { afterEach, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HannesError, type Account, type ModelRequest } from '@hannes/contracts';
import { ConfiguredNetworkPolicy } from '@hannes/security';
import { SqliteSettings } from '@hannes/persistence';
import { AccountManager, ModelCatalog, ModelRouter, ProviderAdapter, ProviderRegistry, ProviderTransport, normalizeModel, retryAfter, retryDelay } from '@hannes/models';
import { fixtureServer, memoryVault } from '../fixtures';

const servers: ReturnType<typeof fixtureServer>[] = [];
afterEach(() => { for (const f of servers.splice(0)) f.server.stop(true); });
const setup = (protocol: 'chat' | 'responses' | 'anthropic' | 'gemini' = 'chat') => {
  const f = fixtureServer(); servers.push(f); const provider = f.provider(protocol);
  const vault = memoryVault(); const key = crypto.randomUUID(); vault.values.set(key, 'fixture-secret-only');
  const account: Account = { id: crypto.randomUUID(), providerId: provider.id, alias: 'test', credential: { kind: 'keyring', key }, status: 'unvalidated', validatedAt: null };
  const db = new Database(':memory:'); db.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT)');
  const store = new SqliteSettings(db); store.update(s => { s.providers.push(provider); s.accounts.push(account); });
  const transport = new ProviderTransport(provider, account, vault, new ConfiguredNetworkPolicy());
  const request: ModelRequest = { requestId: crypto.randomUUID(), modelId: 'fixture-model', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 20, tools: [] };
  return { f, provider, vault, account, db, store, transport, request };
};
for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as const) {
  test(`${protocol}: real HTTP discovery, nonstream and normalized stream with auth`, async () => {
    const x = setup(protocol); const catalog = new ModelCatalog(x.store, x.transport);
    expect((await catalog.discover()).models[0]?.id).toBe('fixture-model');
    const adapter = new ProviderAdapter(x.transport, x.request.modelId);
    const generated = await adapter.generate(x.request); expect(generated.text).toBe('Hello fixture'); expect(generated.usage.inputTokens).toBe(4);
    const events = await Array.fromAsync(adapter.stream(x.request));
    expect(events.filter(e => e.type === 'textDelta').map(e => e.text).join('')).toBe('Hello fixture');
    expect(events.at(-1)?.type).toBe('completed');
    expect(x.f.requests.every(r => protocol === 'anthropic' || protocol === 'gemini' ? r.apiKey === 'fixture-secret-only' : r.authorization === 'Bearer fixture-secret-only')).toBe(true);
    expect(catalog.cached()[0]?.capabilities.tools).toBe('unknown'); x.db.close();
  });
  test(`${protocol}: tool calls normalize as data, never execute callbacks`, async () => {
    const x = setup(protocol); x.f.set({ tools: true });
    const info = normalizeModel('fixture-model', 'fixture'); info.capabilities.tools = 'supported';
    const events = await Array.fromAsync(new ProviderAdapter(x.transport, 'fixture-model', info).stream({ ...x.request, tools: [{ name: 'lookup', description: 'fixture', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] }));
    const call = events.find(e => e.type === 'toolCallComplete'); expect(call?.type === 'toolCallComplete' && call.call.input).toEqual({ query: 'hello' }); x.db.close();
  });
}
test('missing keys do not invoke HTTP; unsupported tool capability fails before network', async () => {
  const x = setup(); x.vault.values.clear();
  await expect(new ProviderAdapter(x.transport, 'fixture-model').generate(x.request)).rejects.toMatchObject({ code: 'AUTH' });
  expect(x.f.requests).toHaveLength(0);
  await expect(new ProviderAdapter(x.transport, 'fixture-model').generate({ ...x.request, tools: [{ name: 'a', description: '', inputSchema: {} }] })).rejects.toMatchObject({ code: 'UNSUPPORTED' }); x.db.close();
});
test('auth, invalid model, rate limit errors are safe; generation never retries uncertain acceptance', async () => {
  const x = setup(); const adapter = new ProviderAdapter(x.transport, 'fixture-model');
  for (const [status, code] of [[401, 'AUTH'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'RATE_LIMIT'], [503, 'TRANSPORT']] as const) {
    x.f.set({ status }); const before = x.f.requests.length;
    await expect(adapter.generate(x.request)).rejects.toMatchObject({ code }); expect(x.f.requests.length - before).toBe(1);
    try { await adapter.generate(x.request); } catch (e) { expect(JSON.stringify(e)).not.toContain('RAW-SENSITIVE'); }
  } x.db.close();
});
test('total timeout and caller cancellation propagate', async () => {
  const x = setup(); x.f.set({ delay: 500 }); x.provider.timeoutMs = 100;
  const adapter = new ProviderAdapter(x.transport, 'fixture-model');
  await expect(adapter.generate(x.request)).rejects.toMatchObject({ code: 'TIMEOUT' });
  const controller = new AbortController(); const result = adapter.generate(x.request, controller.signal); setTimeout(() => controller.abort(), 10);
  await expect(result).rejects.toMatchObject({ code: 'CANCELLED' }); x.db.close();
});
test('malformed responses reject and unavailable usage stays null', async () => {
  const x = setup(); const adapter = new ProviderAdapter(x.transport, 'fixture-model');
  x.f.set({ malformed: true }); await expect(adapter.generate(x.request)).rejects.toBeInstanceOf(HannesError);
  x.f.set({ malformed: false, includeUsage: false }); expect((await adapter.generate(x.request)).usage).toEqual({ inputTokens: null, outputTokens: null, costUSD: null }); x.db.close();
});
test('catalog pagination, manual entries, unknown metadata and account-isolated cache', async () => {
  const x = setup(); x.f.set({ pages: true }); const catalog = new ModelCatalog(x.store, x.transport);
  catalog.manual('gateway/custom-model'); expect((await catalog.discover()).models.map(m => m.id)).toEqual(['gateway/custom-model', 'fixture-model', 'page-two']);
  const other = { ...x.account, id: crypto.randomUUID() }; const otherCatalog = new ModelCatalog(x.store, new ProviderTransport(x.provider, other, x.vault, new ConfiguredNetworkPolicy())); expect(otherCatalog.cached()).toEqual([]);
  x.f.set({ status: 503 }); expect((await catalog.discover()).stale).toBe(true);
  x.f.set({ status: 401 }); await expect(catalog.discover()).rejects.toMatchObject({ code: 'AUTH' }); x.db.close();
});
test('metadata provenance never upgrades capability claims', () => {
  const x = setup(); const catalog = new ModelCatalog(x.store, x.transport); catalog.manual('fixture-model');
  catalog.enrichModelsDev({ fixture: { models: { 'fixture-model': { tool_call: true, limit: { context: 20000 }, cost: { input: 1, output: 2 } } } } });
  const model = catalog.cached()[0]!; expect(model.capabilities.tools).toBe('unknown'); expect(model.contextLimit).toBe(20000); expect(model.metadataSource).toContain('models.dev'); x.db.close();
});
test('multiple accounts, selection, rename, local logout fencing and no implicit fallback', async () => {
  const x = setup(); const manager = new AccountManager(x.store, x.vault); const key = crypto.randomUUID();
  const second = await manager.add(x.provider.id, 'work', { kind: 'keyring', key }, 'fixture-second-secret');
  const router = new ModelRouter(x.store); const personalModel = new ModelCatalog(x.store, x.transport).manual('fixture-model'); router.select(x.account, personalModel);
  expect(router.resolve().accountId).toBe(x.account.id);
  manager.use(second.id); expect(() => router.resolve()).toThrow();
  manager.rename(second.id, 'work-new'); expect(manager.get('work-new').id).toBe(second.id);
  const secondModel = new ModelCatalog(x.store, new ProviderTransport(x.provider, second, x.vault, new ConfiguredNetworkPolicy())).manual('fixture-model');
  router.select(second, secondModel, '/project');
  await manager.logout(second.id, true); expect(x.vault.values.has(key)).toBe(false);
  expect(() => router.resolve('/project')).toThrow(); expect(x.store.read().accounts).toHaveLength(1); x.db.close();
});
test('registry rejects duplicate identities, removal with accounts and unknown fields', () => {
  const x = setup(); const registry = new ProviderRegistry(x.store);
  expect(() => registry.add(x.provider)).toThrow(); expect(() => registry.remove(x.provider.id)).toThrow();
  expect(() => registry.add({ ...x.provider, id: 'new', shell: 'evil' })).toThrow(); x.db.close();
});
test('retry policy respects Retry-After, bounded jitter and nonretriable auth', () => {
  expect(retryAfter('120')).toBe(30000); expect(retryAfter('invalid')).toBeNull(); expect(retryDelay(0, 1000, () => 0)).toBe(1000); expect(retryDelay(99, null, () => 1)).toBe(30000);
});
test('estimated cost guard rejects unknown/unaffordable models before network and marks cost estimates', async () => {
  const x = setup();
  await expect(new ProviderAdapter(x.transport, 'fixture-model').generate({ ...x.request, maxEstimatedCostUSD: 1 })).rejects.toMatchObject({ code: 'BUDGET' });
  const info = normalizeModel('fixture-model', 'fixture'); info.pricing = { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' };
  const adapter = new ProviderAdapter(x.transport, 'fixture-model', info);
  await expect(adapter.generate({ ...x.request, maxEstimatedCostUSD: 0.000000001 })).rejects.toMatchObject({ code: 'BUDGET' }); expect(x.f.requests).toHaveLength(0);
  const response = await adapter.generate({ ...x.request, maxEstimatedCostUSD: 1 }); expect(response.usage.costUSD).toBe(0.000008); expect(response.usage.costEstimated).toBe(true); x.db.close();
});
