import {expect, test} from 'bun:test';
import {emptySettings, providerSchema, type Account, type SettingsStore, type ModelRequest} from '@cosmew/contracts';
import {ModelCatalog, ProviderAdapter, ProviderTransport, loadHostConfig} from '@cosmew/models';
import {ConfiguredNetworkPolicy} from '@cosmew/security';
import {memoryVault} from '../fixtures';

// Capture the real adapter/AI SDK serialized body. This proves wire conversion, not live provider support.
function fixture(protocol: 'chat' | 'responses' | 'anthropic' | 'gemini' = 'chat', modelId = 'fixture-model') {
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
  let streamed: unknown[];
  const bodies: Record<string, unknown>[] = [];
  const transport = new ProviderTransport(provider, account, memoryVault(), new ConfiguredNetworkPolicy(), (async (
    _url,
    init,
  ) => {
    if (!init?.body) return Response.json({data: [{id: modelId, ...advertised}]});
    bodies.push(JSON.parse(String(init.body)));
    if (streamed)
      return new Response(streamed.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: {'content-type': 'text/event-stream'},
      });
    if (protocol === 'anthropic')
      return Response.json({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [{type: 'text', text: 'ok'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      });
    if (protocol === 'gemini')
      return Response.json({
        candidates: [{content: {role: 'model', parts: [{text: 'ok'}]}, finishReason: 'STOP'}],
        usageMetadata: {promptTokenCount: 1, candidatesTokenCount: 1},
      });
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
    modelId,
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
    streamEvents: (events: unknown[]) => {
      streamed = events;
    },
    advertise: (data: Record<string, unknown>) => {
      advertised = data;
    },
  };
}

test('Anthropic budget thinking streams its summary and signed state alongside tool calls', async () => {
  const id = 'claude-sonnet-4-5-20250929';
  const x = fixture('anthropic', id);
  const catalog = new ModelCatalog(x.store, x.transport);
  catalog.manual(id);
  catalog.enrichModelsDev({custom: {models: {[id]: {reasoning_options: [{type: 'budget_tokens', min: 1024}]}}}});
  x.streamEvents([
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: id,
        content: [],
        stop_reason: null,
        usage: {input_tokens: 10, output_tokens: 1},
      },
    },
    {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: '', signature: ''}},
    {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'anthropic summary'}},
    {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'signed-claude'}},
    {type: 'content_block_stop', index: 0},
    {
      type: 'content_block_start',
      index: 1,
      content_block: {type: 'tool_use', id: 'call_fixture', name: 'lookup', input: {}},
    },
    {type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{}'}},
    {type: 'content_block_stop', index: 1},
    {type: 'message_delta', delta: {stop_reason: 'tool_use', stop_sequence: null}, usage: {output_tokens: 5}},
    {type: 'message_stop'},
  ]);
  const events = await Array.fromAsync(
    new ProviderAdapter(x.transport, id, catalog.cached()[0]).stream({
      ...x.request,
      reasoningEffort: 'low',
      tools: [{name: 'lookup', description: 'fixture', inputSchema: {type: 'object'}}],
    }),
  );
  expect(events).toContainEqual({type: 'reasoningDelta', text: 'anthropic summary'});
  expect(events).toContainEqual({type: 'toolCallComplete', call: {id: 'call_fixture', name: 'lookup', input: {}}});
  expect(events.at(-2)).toMatchObject({
    type: 'providerReplay',
    replay: {
      parts: [
        {type: 'reasoning', metadata: {signature: 'signed-claude'}},
        {type: 'tool-call', callId: 'call_fixture'},
      ],
    },
  });
});

test('Gemini level thinking streams thought summaries, usage, and tool replay separately', async () => {
  const id = 'gemini-3-flash-preview';
  const x = fixture('gemini', id);
  const catalog = new ModelCatalog(x.store, x.transport);
  catalog.manual(id);
  catalog.enrichModelsDev({custom: {models: {[id]: {reasoning_options: [{type: 'effort', values: ['low']}]}}}});
  x.streamEvents([
    {
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              {text: 'gemini summary', thought: true, thoughtSignature: 'signed-gemini'},
              {functionCall: {name: 'lookup', args: {}}, thoughtSignature: 'signed-tool'},
            ],
          },
        },
      ],
      usageMetadata: {promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 5, totalTokenCount: 10},
    },
  ]);
  const events = await Array.fromAsync(
    new ProviderAdapter(x.transport, id, catalog.cached()[0]).stream({
      ...x.request,
      reasoningEffort: 'low',
      tools: [{name: 'lookup', description: 'fixture', inputSchema: {type: 'object'}}],
    }),
  );
  expect(events).toContainEqual({type: 'reasoningDelta', text: 'gemini summary'});
  expect(events.find(event => event.type === 'toolCallComplete')).toMatchObject({call: {name: 'lookup', input: {}}});
  expect(events.at(-2)).toMatchObject({
    type: 'providerReplay',
    replay: {
      parts: [
        {type: 'reasoning', metadata: {thoughtSignature: 'signed-gemini'}},
        {type: 'tool-call', metadata: {thoughtSignature: 'signed-tool'}},
      ],
    },
  });
  expect(events.at(-1)).toMatchObject({type: 'completed', usage: {reasoningTokens: 5}});
});

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
  test(`${protocol}: unknown and toggle-only capability reject a positive effort before fetch`, async () => {
    const x = fixture(protocol);
    const catalog = new ModelCatalog(x.store, x.transport);
    const info = catalog.manual('fixture-model');
    await expect(
      new ProviderAdapter(x.transport, info.id, info).generate({...x.request, reasoningEffort: 'high'}),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining(`${protocol} protocol: reasoning capability is unknown`),
    });
    catalog.enrichModelsDev({custom: {models: {'fixture-model': {reasoning_options: [{type: 'toggle'}]}}}});
    await expect(
      new ProviderAdapter(x.transport, info.id, catalog.cached()[0]).generate({...x.request, reasoningEffort: 'high'}),
    ).rejects.toMatchObject({code: 'UNSUPPORTED', message: expect.stringContaining('no wire mapping')});
    expect(x.bodies).toHaveLength(0);
  });
}

const budgetFixtures = [
  {protocol: 'anthropic', id: 'claude-sonnet-4-5-20250929'},
  {protocol: 'gemini', id: 'gemini-2.5-flash'},
] as const;

test('Gemini without an evidenced output limit needs an explicit request cap for budget thinking', async () => {
  const id = 'gemini-2.5-flash';
  const x = fixture('gemini', id);
  const catalog = new ModelCatalog(x.store, x.transport);
  catalog.manual(id);
  catalog.enrichModelsDev({custom: {models: {[id]: {reasoning_options: [{type: 'budget_tokens', min: 100}]}}}});
  const info = catalog.cached()[0]!;
  expect(info.reasoningEfforts).toEqual(['none']);
  const adapter = new ProviderAdapter(x.transport, id, info);
  await expect(adapter.generate({...x.request, reasoningEffort: 'high'})).rejects.toMatchObject({
    code: 'UNSUPPORTED',
    message: expect.stringContaining('output limit is unknown'),
  });
  expect(x.bodies).toHaveLength(0);
  await adapter.generate({...x.request, reasoningEffort: 'high', maxOutputTokens: 1000});
  expect(x.bodies[0]?.generationConfig).toMatchObject({
    maxOutputTokens: 1000,
    thinkingConfig: {thinkingBudget: 500, includeThoughts: true},
  });
});

for (const {protocol, id} of budgetFixtures) {
  test(`${protocol}: catalog budget, min/output clamp, user overrides and none reach the wire`, async () => {
    const x = fixture(protocol, id);
    x.provider.reasoning = loadHostConfig(
      Bun.TOML.parse(`
[model_providers.custom]
base_url = "https://api.example.test/v1"
[model_providers.custom.reasoning.budgets]
medium = 3200
high = 5000
[model_providers.custom.reasoning.models."${id}".budgets]
high = 6000
xhigh = 999999
`),
    ).providers[0]!.provider.reasoning;
    const catalog = new ModelCatalog(x.store, x.transport);
    await catalog.discover();
    catalog.enrichModelsDev({
      custom: {models: {[id]: {reasoning_options: [{type: 'budget_tokens', min: 1500}], limit: {output: 10000}}}},
    });
    const info = new ModelCatalog(x.store, x.transport).cached()[0]!;
    const adapter = new ProviderAdapter(x.transport, id, info);
    for (const [reasoningEffort, budget, maxOutputTokens] of [
      ['minimal', 1500, undefined],
      ['low', 2000, undefined],
      ['medium', 3200, undefined],
      ['high', 6000, undefined],
      ['xhigh', 9999, undefined],
      ['high', 2999, 3000],
      ['none', 0, undefined],
    ] as const) {
      await adapter.generate({...x.request, reasoningEffort, maxOutputTokens});
      const body = x.bodies.at(-1)!;
      const total = maxOutputTokens ?? 10000;
      if (protocol === 'anthropic') {
        expect(body.thinking).toEqual(budget ? {type: 'enabled', budget_tokens: budget} : {type: 'disabled'});
        expect(body.max_tokens).toBe(total);
        expect(body.temperature).toBeUndefined();
      } else {
        expect(body.generationConfig).toMatchObject({
          thinkingConfig: {thinkingBudget: budget, includeThoughts: budget > 0},
          ...(budget > 0 ? {maxOutputTokens: total} : {}),
        });
      }
    }
    expect(info.reasoningEfforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    await expect(adapter.generate({...x.request, reasoningEffort: 'low', maxOutputTokens: 1500})).rejects.toMatchObject(
      {
        code: 'UNSUPPORTED',
        message: expect.stringContaining('no room for the minimum thinking budget'),
      },
    );
    expect(x.bodies).toHaveLength(7);
  });
}

for (const [protocol, id] of [
  ['anthropic', 'claude-opus-4-7'],
  ['gemini', 'gemini-3-flash-preview'],
] as const) {
  test(`${protocol}: advertised effort uses the native SDK option even alongside budget metadata`, async () => {
    const x = fixture(protocol, id);
    const catalog = new ModelCatalog(x.store, x.transport);
    await catalog.discover();
    catalog.enrichModelsDev({
      custom: {
        models: {
          [id]: {
            reasoning_options: [
              {type: 'effort', values: ['none', 'low', 'high']},
              {type: 'budget_tokens', min: 1024},
            ],
            limit: {output: 10000},
          },
        },
      },
    });
    const info = catalog.cached()[0]!;
    const adapter = new ProviderAdapter(x.transport, id, info);
    await adapter.generate({...x.request, reasoningEffort: 'high'});
    if (protocol === 'anthropic') {
      expect(x.bodies[0]).toMatchObject({
        thinking: {type: 'adaptive', display: 'summarized'},
        output_config: {effort: 'high'},
      });
      await adapter.generate({...x.request, reasoningEffort: 'none'});
      expect(x.bodies[1]).toMatchObject({thinking: {type: 'disabled'}});
    } else {
      expect(x.bodies[0]?.generationConfig).toMatchObject({
        thinkingConfig: {thinkingLevel: 'high', includeThoughts: true},
      });
      await expect(adapter.generate({...x.request, reasoningEffort: 'none'})).rejects.toMatchObject({
        code: 'UNSUPPORTED',
        message: expect.stringContaining('thinking cannot be disabled'),
      });
      expect(info.reasoningEfforts).toEqual(['low', 'high']);
      expect(x.bodies).toHaveLength(1);
    }
  });
}

for (const [protocol, id, options] of [
  ['anthropic', 'claude-opus-5-5', [{type: 'effort', values: ['none', 'low']}]],
  ['gemini', 'gemini-2.5-pro', [{type: 'budget_tokens', min: 128}]],
] as const) {
  test(`${protocol}: none fails before fetch when the model requires thinking`, async () => {
    const x = fixture(protocol, id);
    const catalog = new ModelCatalog(x.store, x.transport);
    catalog.manual(id);
    catalog.enrichModelsDev({custom: {models: {[id]: {reasoning_options: options, limit: {output: 10000}}}}});
    const info = catalog.cached()[0]!;
    expect(info.reasoningEfforts).not.toContain('none');
    await expect(
      new ProviderAdapter(x.transport, id, info).generate({...x.request, reasoningEffort: 'none'}),
    ).rejects.toMatchObject({code: 'UNSUPPORTED', message: expect.stringContaining('thinking cannot be disabled')});
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
