import {expect, test} from 'bun:test';
import {
  emptySettings,
  modelSchema,
  providerSchema,
  isCodingModel,
  type Account,
  type SettingsStore,
} from '@cosmew/contracts';
import {ModelCatalog, ProviderTransport, normalizeModel} from '@cosmew/models';
import {ConfiguredNetworkPolicy} from '@cosmew/security';
import {memoryVault} from '../fixtures';

const metadata = {
  xai: {
    models: {
      'grok-4.7': {
        reasoning: true,
        reasoning_options: [{type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'low']}],
      },
      toggle: {reasoning_options: [{type: 'toggle'}]},
      budget: {reasoning_options: [{type: 'budget_tokens', min: 1024}]},
      unknown: {},
    },
  },
};
function fixture(id = 'xai', baseURL = 'https://api.x.ai/v1') {
  const provider = providerSchema.parse({
    id,
    name: 'Fixture',
    baseURL,
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
  });
  const account: Account = {
    id: crypto.randomUUID(),
    providerId: id,
    alias: id,
    credential: {kind: 'none'},
    status: 'valid',
    validatedAt: null,
  };
  const state = emptySettings();
  state.providers.push(provider);
  state.accounts.push(account);
  const store: SettingsStore = {read: () => state, update: change => change(state)};
  let items: Record<string, unknown>[] = Object.keys(metadata.xai.models).map(id => ({id}));
  const transport = new ProviderTransport(provider, account, memoryVault(), new ConfiguredNetworkPolicy(), (async () =>
    Response.json({data: items})) as unknown as typeof fetch);
  return {
    provider,
    state,
    store,
    transport,
    advertise: (value: Record<string, unknown>[]) => {
      items = value;
    },
  };
}
test('models.dev enriches old cached models, effort/toggle/budget/unknown and configured endpoint identity', async () => {
  const x = fixture('my_xai');
  const catalog = new ModelCatalog(x.store, x.transport);
  await catalog.discover();
  catalog.enrichModelsDev(metadata);
  const models = new ModelCatalog(x.store, x.transport).cached();
  expect(models[0]?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  for (const id of ['toggle', 'budget']) {
    expect(models.find(m => m.id === id)?.capabilities.reasoning).toBe('supported');
    expect(models.find(m => m.id === id)?.reasoningEfforts).toBeUndefined();
  }
  expect(models.find(m => m.id === 'toggle')?.reasoningOptions).toEqual({toggle: true});
  expect(models.find(m => m.id === 'budget')?.reasoningOptions).toEqual({budgetMin: 1024});
  expect(models.find(m => m.id === 'unknown')?.capabilities.reasoning).toBe('unknown');
});
test('user > advertised efforts > models.dev; explicit unsupported is retained', async () => {
  const x = fixture();
  x.advertise([
    {id: 'grok-4.7', reasoning_efforts: ['none', 'max']},
    {id: 'toggle', capabilities: {reasoning: false}},
  ]);
  const catalog = new ModelCatalog(x.store, x.transport);
  await catalog.discover();
  catalog.enrichModelsDev(metadata);
  expect(catalog.cached()[0]?.reasoningEfforts).toEqual(['none', 'max']);
  expect(catalog.cached()[1]?.capabilities.reasoning).toBe('unsupported');
  x.provider.reasoning = {efforts: ['minimal']};
  expect((await catalog.discover()).models[0]?.reasoningEfforts).toEqual(['minimal']);
});
test('automatic enrichment is nonfatal on offline metadata failure and cached() never fetches', async () => {
  const x = fixture();
  let calls = 0;
  const catalog = new ModelCatalog(x.store, x.transport, async () => {
    calls++;
    throw new Error('offline');
  });
  expect((await catalog.discover()).models).toHaveLength(4);
  catalog.cached();
  expect(calls).toBe(1);
});
for (const type of ['image', 'embedding', 'video', 'transcription', 'speech', 'reranking', 'realtime']) {
  test(`filter excludes explicit ${type}; manual and selected survive`, async () => {
    const x = fixture();
    x.advertise([{id: 'excluded', type}]);
    const catalog = new ModelCatalog(x.store, x.transport);
    const model = (await catalog.discover()).models[0]!;
    expect(isCodingModel(model)).toBe(false);
    expect(isCodingModel(model, model.id)).toBe(true);
    expect(isCodingModel({...model, source: 'manual'})).toBe(true);
  });
}
test('filter uses output and tools metadata; unknown and text chat stay visible', async () => {
  const x = fixture();
  x.advertise([
    {id: 'audio', modalities: {output: ['audio']}},
    {id: 'no-tools', tool_call: false},
    {id: 'unsupported', capabilities: {tools: 'unsupported'}},
    {id: 'chat', type: 'chat', tool_call: true, modalities: {output: ['text']}},
  ]);
  const models = (await new ModelCatalog(x.store, x.transport).discover()).models;
  expect(models.map(m => isCodingModel(m))).toEqual([false, false, false, true]);
  expect(isCodingModel(normalizeModel('image-embedding-name', 'Unknown'))).toBe(true);
});

test('automatic refresh enriches an old cache without provider discovery or account replacement', async () => {
  const x = fixture();
  await new ModelCatalog(x.store, x.transport).discover();
  let calls = 0;
  const catalog = new ModelCatalog(x.store, x.transport, async () => {
    calls++;
    return metadata;
  });
  expect(catalog.cached()[0]?.reasoningEfforts).toBeUndefined();
  expect(calls).toBe(0);
  expect((await catalog.refreshMetadata())[0]?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(new ModelCatalog(x.store, x.transport).cached()[0]?.reasoningEfforts).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
  expect(x.state.accounts).toHaveLength(1);
});
test('display names and partial URLs never map a custom endpoint to models.dev', async () => {
  const x = fixture('my_xai', 'https://api.x.ai/v1/proxy');
  const catalog = new ModelCatalog(x.store, x.transport);
  await catalog.discover();
  expect(() => catalog.enrichModelsDev(metadata)).toThrow();
  expect(catalog.cached()[0]?.reasoningEfforts).toBeUndefined();
});
test('models.dev output and tools exclusions apply even when provider input text is supported', async () => {
  const x = fixture();
  x.advertise([{id: 'grok-4.7', input_modalities: ['text']}]);
  const catalog = new ModelCatalog(x.store, x.transport);
  await catalog.discover();
  catalog.enrichModelsDev({xai: {models: {'grok-4.7': {type: 'image', modalities: {output: ['image']}}}}});
  expect(isCodingModel(catalog.cached()[0]!)).toBe(false);
});
test('rediscovery preserves manually added model provenance even if the provider lists it', async () => {
  const x = fixture();
  const catalog = new ModelCatalog(x.store, x.transport);
  catalog.manual('grok-4.7');
  x.advertise([{id: 'grok-4.7', reasoning_efforts: ['high'], type: 'image'}]);
  const model = (await catalog.discover()).models.find(m => m.id === 'grok-4.7')!;
  expect(model.source).toBe('manual');
  expect(model.reasoningEfforts).toEqual(['high']);
  expect(isCodingModel(model)).toBe(true);
});

test('advisory filter evidence survives cache validation without changing capability claims', async () => {
  const x = fixture();
  x.advertise([
    {id: 'grok-4.7', capabilities: {text: true, tools: true, streaming: false, vision: false}},
    {id: 'unknown'},
  ]);
  const catalog = new ModelCatalog(x.store, x.transport);
  const before = (await catalog.discover()).models.map(model => model.capabilities);
  catalog.enrichModelsDev({
    xai: {
      models: {
        'grok-4.7': {tool_call: false, type: 'image', modalities: {input: ['image'], output: ['image']}},
        unknown: {
          tool_call: true,
          capabilities: {streaming: true, vision: true},
          modalities: {input: ['image'], output: ['text']},
        },
      },
    },
  });
  const models = new ModelCatalog(x.store, x.transport).cached().map(model => modelSchema.parse(model));
  expect(models.map(model => model.capabilities)).toEqual(before);
  expect(models.map(model => isCodingModel(model))).toEqual([false, true]);
});

test('successful ChatGPT discovery drops configured fallbacks but preserves user manual IDs', async () => {
  const x = fixture();
  x.provider.auth = 'oauth';
  x.provider.protocol = 'responses';
  x.provider.catalog = 'manual';
  x.provider.models = ['obsolete-fallback-model'];
  x.transport.account.credential = {kind: 'keyring', key: crypto.randomUUID()};
  const transport = new ProviderTransport(
    x.provider,
    x.transport.account,
    memoryVault(),
    new ConfiguredNetworkPolicy(),
    (async () => Response.json({models: [{slug: 'available-model'}]})) as unknown as typeof fetch,
    async () => 'fixture-token',
  );
  const catalog = new ModelCatalog(x.store, transport);
  expect((await catalog.discover()).models.map(model => model.id)).toEqual(['available-model']);
  catalog.manual('user-model');
  catalog.manual('obsolete-fallback-model');
  expect((await catalog.discover()).models.map(model => model.id)).toEqual([
    'user-model',
    'obsolete-fallback-model',
    'available-model',
  ]);
});
