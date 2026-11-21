import {expect, test} from 'bun:test';
import {emptySettings, providerSchema, type Account, type SettingsStore, type ModelRequest} from '@cosmew/contracts';
import {ModelCatalog, ProviderAdapter, ProviderTransport, loadHostConfig} from '@cosmew/models';
import {ConfiguredNetworkPolicy} from '@cosmew/security';
import {memoryVault} from '../fixtures';

// Capture the real adapter/AI SDK serialized body. This proves wire conversion, not live provider support.
function fixture(protocol: 'chat' | 'responses' | 'anthropic' | 'gemini' = 'chat') {
  const provider = providerSchema.parse({
    id: 'custom',
    name: 'Custom',
    protocol,
    baseURL: 'https://api.example.test/v1',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
  });
  const account: Account = {
    id: crypto.randomUUID(),
    providerId: provider.id,
    alias: 'custom',
    credential: {kind: 'none'},
    status: 'valid',
    validatedAt: null,
  };
  const state = emptySettings();
  state.providers.push(provider);
  state.accounts.push(account);
  const store: SettingsStore = {read: () => state, update: change => change(state)};
  let advertised: Record<string, unknown> = {};
  const bodies: Record<string, unknown>[] = [];
  const transport = new ProviderTransport(provider, account, memoryVault(), new ConfiguredNetworkPolicy(), (async (
    _url,
    init,
  ) => {
    if (!init?.body) return Response.json({data: [{id: 'fixture-model', ...advertised}]});
    bodies.push(JSON.parse(String(init.body)));
    return Response.json(
      protocol === 'responses'
        ? {
            id: 'resp_fixture',
            created_at: 1,
            model: 'fixture-model',
            output: [],
            status: 'completed',
            usage: {input_tokens: 1, output_tokens: 0},
          }
        : {
            id: 'fixture',
            model: 'fixture-model',
            choices: [{index: 0, message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 1, completion_tokens: 1},
          },
    );
  }) as typeof fetch);
  const request: ModelRequest = {
    requestId: crypto.randomUUID(),
    modelId: 'fixture-model',
    messages: [{role: 'user', content: 'hi'}],
    tools: [],
  };
  return {
    provider,
    account,
    transport,
    store,
    bodies,
    request,
    advertise: (data: Record<string, unknown>) => {
      advertised = data;
    },
  };
}

for (const protocol of ['chat', 'responses'] as const) {
  test(`${protocol}: user config reaches serialized effort without forcing a summary`, async () => {
    const x = fixture(protocol);
    x.provider.reasoning = loadHostConfig(
      Bun.TOML.parse(`
[model_providers.custom]
base_url = "https://api.example.test/v1"
[model_providers.custom.reasoning.models."fixture-model"]
supported = true
efforts = ["low", "high"]
`),
    ).providers[0]!.provider.reasoning;
    const catalog = new ModelCatalog(x.store, x.transport);
    const info = (await catalog.discover()).models[0]!;
    expect(info.reasoningEfforts).toEqual(['low', 'high']);
    expect(info.capabilities.reasoning).toBe('supported');
    expect(catalog.cached()[0]?.reasoningEfforts).toEqual(['low', 'high']);
    await new ProviderAdapter(x.transport, x.request.modelId, info).generate({...x.request, reasoningEffort: 'high'});
    const body = x.bodies.at(-1)!;
    if (protocol === 'chat') expect(body.reasoning_effort).toBe('high');
    else expect(body.reasoning).toEqual({effort: 'high'});
  });
}

test('reasoning config overrides discovery, and model config overrides provider defaults', async () => {
  const x = fixture();
  x.advertise({reasoning_efforts: ['medium'], capabilities: {reasoning: false}});
  x.provider.reasoning = {efforts: ['low'], models: {'fixture-model': {supported: true, efforts: ['high']}}};
  const info = (await new ModelCatalog(x.store, x.transport).discover()).models[0]!;
  expect(info.reasoningEfforts).toEqual(['high']);
  expect(info.capabilities.reasoning).toBe('supported');
  x.provider.reasoning = {supported: false, models: {'fixture-model': {efforts: ['high']}}};
  const modelOverride = (await new ModelCatalog(x.store, x.transport).discover()).models[0]!;
  expect(modelOverride.capabilities.reasoning).toBe('supported');
  expect(modelOverride.reasoningEfforts).toEqual(['high']);
  x.provider.reasoning = {efforts: ['low'], models: {'fixture-model': {supported: false}}};
  const disabled = (await new ModelCatalog(x.store, x.transport).discover()).models[0]!;
  expect(disabled.capabilities.reasoning).toBe('unsupported');
  expect(disabled.reasoningEfforts).toBeUndefined();
  expect(new ModelCatalog(x.store, x.transport).manual('grok-any-name').reasoningEfforts).toEqual(['low']);
});

test('discovered metadata beats unknown; model names never imply reasoning levels', async () => {
  const x = fixture();
  let info = (await new ModelCatalog(x.store, x.transport).discover()).models[0]!;
  expect(info.capabilities.reasoning).toBe('unknown');
  expect(info.reasoningEfforts).toBeUndefined();
  x.advertise({reasoning_efforts: ['medium'], capabilities: {reasoning: true}});
  info = (await new ModelCatalog(x.store, x.transport).discover()).models[0]!;
  expect(info.reasoningEfforts).toEqual(['medium']);
  expect(info.capabilities.reasoning).toBe('supported');
  expect(new ModelCatalog(x.store, x.transport).manual('grok-4.7').reasoningEfforts).toBeUndefined();
});

for (const protocol of ['anthropic', 'gemini'] as const) {
  test(`${protocol}: explicit effort names the missing wire mapping and sends nothing`, async () => {
    const x = fixture(protocol);
    x.provider.reasoning = {efforts: ['high']};
    const info = new ModelCatalog(x.store, x.transport).manual('fixture-model');
    await expect(
      new ProviderAdapter(x.transport, info.id, info).generate({...x.request, reasoningEffort: 'high'}),
    ).rejects.toMatchObject({code: 'UNSUPPORTED', message: expect.stringContaining(`${protocol} protocol`)});
    expect(x.bodies).toHaveLength(0);
  });
}

test('native OpenAI Responses retains auto summaries, compatible endpoints do not inherit them by id', async () => {
  for (const native of [true, false]) {
    const x = fixture('responses');
    x.provider.id = 'openai';
    x.account.providerId = 'openai';
    if (native) x.provider.baseURL = 'https://api.openai.com/v1';
    x.provider.reasoning = {efforts: ['high']};
    const info = new ModelCatalog(x.store, x.transport).manual('fixture-model');
    await new ProviderAdapter(x.transport, info.id, info).generate({...x.request, reasoningEffort: 'high'});
    expect(x.bodies.at(-1)?.reasoning).toEqual(native ? {effort: 'high', summary: 'auto'} : {effort: 'high'});
  }
});

test('explicit effort without resolved levels fails before sending a request', async () => {
  const x = fixture();
  const info = new ModelCatalog(x.store, x.transport).manual('fixture-model');
  await expect(
    new ProviderAdapter(x.transport, info.id, info).generate({...x.request, reasoningEffort: 'high'}),
  ).rejects.toMatchObject({code: 'UNSUPPORTED', message: expect.stringContaining('No effort levels known')});
  expect(x.bodies).toHaveLength(0);
});

test('manual host catalogs use the same resolved reasoning metadata', async () => {
  const x = fixture();
  x.provider.catalog = 'manual';
  x.provider.models = ['manual-model'];
  x.provider.reasoning = {efforts: ['low']};
  const catalog = new ModelCatalog(x.store, x.transport);
  expect((await catalog.discover()).models[0]?.reasoningEfforts).toEqual(['low']);
  expect(catalog.cached()[0]?.reasoningEfforts).toEqual(['low']);
});

for (const protocol of ['chat', 'responses'] as const) {
  test(`${protocol}: all models.dev efforts pass unchanged through the real serializer`, async () => {
    const x = fixture(protocol);
    const catalog = new ModelCatalog(x.store, x.transport);
    await catalog.discover();
    catalog.enrichModelsDev({
      custom: {
        models: {
          'fixture-model': {
            reasoning_options: [{type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']}],
          },
        },
      },
    });
    const info = catalog.cached()[0]!;
    for (const reasoningEffort of info.reasoningEfforts!) {
      await new ProviderAdapter(x.transport, info.id, info).generate({...x.request, reasoningEffort});
      const body = x.bodies.at(-1)!;
      expect(protocol === 'chat' ? body.reasoning_effort : (body.reasoning as {effort: string}).effort).toBe(
        reasoningEffort,
      );
    }
  });
}
