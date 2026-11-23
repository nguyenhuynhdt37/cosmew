import {afterEach, test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {FutrynError, GENERATION_LIMITS, type Account, type ModelRequest} from '@cosmew/contracts';
import {ConfiguredNetworkPolicy} from '@cosmew/security';
import {SqliteSettings} from '@cosmew/persistence';
import {
  AccountManager,
  ModelCatalog,
  ModelRouter,
  ProviderAdapter,
  ProviderRegistry,
  ProviderTransport,
  normalizeModel,
  normalizeError,
  retryAfter,
  retryDelay,
} from '@cosmew/models';
import {fixtureServer, memoryVault} from '../fixtures';

const servers: ReturnType<typeof fixtureServer>[] = [];
afterEach(() => {
  for (const f of servers.splice(0)) f.server.stop(true);
});

test('provider SDK errors with status or response.status preserve auth and HTTP codes', () => {
  expect(normalizeError({status: 401}).code).toBe('AUTH');
  expect(normalizeError({response: {status: 403}}).code).toBe('FORBIDDEN');
  expect(normalizeError({statusCode: 404}).code).toBe('NOT_FOUND');
});
const setup = (protocol: 'chat' | 'responses' | 'anthropic' | 'gemini' = 'chat') => {
  const f = fixtureServer();
  servers.push(f);
  const provider = f.provider(protocol);
  const vault = memoryVault();
  const key = crypto.randomUUID();
  vault.values.set(key, 'fixture-secret-only');
  const account: Account = {
    id: crypto.randomUUID(),
    providerId: provider.id,
    alias: 'test',
    credential: {kind: 'keyring', key},
    status: 'unvalidated',
    validatedAt: null,
  };
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT)');
  const store = new SqliteSettings(db);
  store.update(s => {
    s.providers.push(provider);
    s.accounts.push(account);
  });
  const transport = new ProviderTransport(provider, account, vault, new ConfiguredNetworkPolicy());
  const request: ModelRequest = {
    requestId: crypto.randomUUID(),
    modelId: 'fixture-model',
    messages: [{role: 'user', content: 'hi'}],
    maxOutputTokens: 20,
    tools: [],
  };
  return {f, provider, vault, account, db, store, transport, request};
};

test('Chat adapter sends a large MCP catalog to the provider', async () => {
  const x = setup();
  try {
    const tools = Array.from({length: 209}, (_, index) => ({
      name: `mcp__fixture__tool_${index}`,
      description: 'Fixture tool',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    }));
    const adapter = new ProviderAdapter(x.transport, x.request.modelId);
    const events = await Array.fromAsync(adapter.stream({...x.request, tools}));
    expect(events.at(-1)?.type).toBe('completed');
    expect(x.f.requests.at(-1)?.body.tools.map((tool: {function: {name: string}}) => tool.function.name)).toEqual(
      tools.map(tool => tool.name),
    );
  } finally {
    x.db.close();
  }
});

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as const) {
  test(`${protocol}: real HTTP discovery, nonstream and normalized stream with auth`, async () => {
    const x = setup(protocol);
    const catalog = new ModelCatalog(x.store, x.transport);
    expect((await catalog.discover()).models[0]?.id).toBe('fixture-model');
    const adapter = new ProviderAdapter(x.transport, x.request.modelId);
    const generated = await adapter.generate(x.request);
    expect(generated.text).toBe('Hello fixture');
    expect(generated.usage.inputTokens).toBe(4);
    expect(generated.usage.breakdown?.[0]).toMatchObject({
      accountId: x.account.id,
      providerId: x.provider.id,
      modelId: x.request.modelId,
      inputTokens: 4,
    });
    const events = await Array.fromAsync(adapter.stream(x.request));
    expect(
      events
        .filter(e => e.type === 'textDelta')
        .map(e => e.text)
        .join(''),
    ).toBe('Hello fixture');
    expect(events.at(-1)?.type).toBe('completed');
    const completion = events.find(event => event.type === 'completed');
    expect(completion?.type === 'completed' && completion.usage.breakdown?.[0]).toMatchObject({
      accountId: x.account.id,
      providerId: x.provider.id,
      modelId: x.request.modelId,
    });
    expect(
      x.f.requests.every(r =>
        protocol === 'anthropic' || protocol === 'gemini'
          ? r.apiKey === 'fixture-secret-only'
          : r.authorization === 'Bearer fixture-secret-only',
      ),
    ).toBe(true);
    expect(catalog.cached()[0]?.capabilities.tools).toBe('unknown');
    x.db.close();
  });
  test(`${protocol}: tool calls normalize as data, never execute callbacks`, async () => {
    const x = setup(protocol);
    x.f.set({tools: true});
    const info = normalizeModel('fixture-model', 'fixture');
    info.capabilities.tools = 'supported';
    const events = await Array.fromAsync(
      new ProviderAdapter(x.transport, 'fixture-model', info).stream({
        ...x.request,
        tools: [
          {
            name: 'lookup',
            description: 'fixture',
            inputSchema: {
              type: 'object',
              properties: {query: {type: 'string'}},
              required: ['query'],
              additionalProperties: false,
            },
          },
        ],
      }),
    );
    const call = events.find(e => e.type === 'toolCallComplete');
    expect(call?.type === 'toolCallComplete' && call.call.input).toEqual({query: 'hello'});
    x.db.close();
  });
}

for (const protocol of ['chat', 'responses'] as const) {
  for (const suffix of ['', '#']) {
    test(`${protocol}: OpenAI Docs JSON Schema 2020-12${suffix} reaches HTTP unchanged`, async () => {
      const x = setup(protocol);
      try {
        const inputSchema = {
          $schema: `https://json-schema.org/draft/2020-12/schema${suffix}`,
          type: 'object',
          properties: {
            query: {type: 'string', minLength: 1},
            limit: {type: 'integer', minimum: 1, maximum: 50},
            cursor: {type: 'string'},
          },
          required: ['query'],
        };
        const result = await new ProviderAdapter(x.transport, x.request.modelId).generate({
          ...x.request,
          tools: [{name: 'mcp__docs__search', description: 'Search documentation', inputSchema}],
        });
        expect(result.text).toBe('Hello fixture');
        expect(x.f.requests).toHaveLength(1);
        const tool = x.f.requests[0]!.body.tools[0];
        expect(protocol === 'chat' ? tool.function.parameters : tool.parameters).toEqual(inputSchema);
      } finally {
        x.db.close();
      }
    });
  }
  test(`${protocol}: tool schema dialect validation rejects unknown, async, invalid and duplicate definitions before HTTP`, async () => {
    const x = setup(protocol);
    try {
      const tool = (inputSchema: Record<string, unknown>) => ({name: 'lookup', description: '', inputSchema});
      const schema2020 = {$schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object'};
      const invalidTools = [
        [tool({$schema: 'https://example.invalid/unknown-schema', type: 'object'})],
        [tool({...schema2020, $async: true})],
        [tool({...schema2020, properties: {query: {type: 'invalid'}}})],
        [tool(schema2020), tool({type: 'object'})],
      ];
      for (const tools of invalidTools) {
        await expect(
          new ProviderAdapter(x.transport, x.request.modelId).generate({...x.request, tools}),
        ).rejects.toMatchObject({code: 'INVALID_INPUT'});
      }
      expect(x.f.requests).toHaveLength(0);
    } finally {
      x.db.close();
    }
  });
}

test('malformed provider tool identity fails before it can enter the core loop', async () => {
  const x = setup('chat');
  x.f.set({toolCall: {name: 'lookup with spaces', args: '{}'}});
  const info = normalizeModel('fixture-model', 'fixture');
  info.capabilities.tools = 'supported';
  await expect(
    Array.fromAsync(
      new ProviderAdapter(x.transport, 'fixture-model', info).stream({
        ...x.request,
        tools: [{name: 'lookup', description: 'fixture', inputSchema: {type: 'object'}}],
      }),
    ),
  ).rejects.toMatchObject({code: 'PROTOCOL'});
  x.db.close();
});

test('missing keys do not invoke HTTP; a model known to reject tools fails before network', async () => {
  const x = setup();
  x.vault.values.clear();
  await expect(new ProviderAdapter(x.transport, 'fixture-model').generate(x.request)).rejects.toMatchObject({
    code: 'AUTH',
  });
  expect(x.f.requests).toHaveLength(0);
  const info = normalizeModel('fixture-model', 'fixture');
  info.capabilities.tools = 'unsupported';
  await expect(
    new ProviderAdapter(x.transport, 'fixture-model', info).generate({
      ...x.request,
      tools: [{name: 'a', description: '', inputSchema: {}}],
    }),
  ).rejects.toMatchObject({code: 'UNSUPPORTED'});
  expect(x.f.requests).toHaveLength(0);
  x.db.close(); // ADR 0017: only 'unsupported' is refused up front; 'unknown' is tried
});
test('auth, invalid model, rate limit errors are safe; only 5xx/transport is resent (Codex request_max_retries, not 429)', async () => {
  const x = setup();
  const adapter = new ProviderAdapter(x.transport, 'fixture-model');
  for (const [status, code] of [
    [401, 'AUTH'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMIT'],
    [503, 'TRANSPORT'],
  ] as const) {
    x.f.set({status});
    const before = x.f.requests.length;
    await expect(adapter.generate(x.request)).rejects.toMatchObject({code});
    expect(x.f.requests.length - before).toBe(status === 503 ? 1 + GENERATION_LIMITS.requestMaxRetries : 1);
    try {
      await adapter.generate(x.request);
    } catch (e) {
      expect(JSON.stringify(e)).not.toContain('RAW-SENSITIVE');
    }
  }
  x.db.close();
}, 30_000);
test('stream idle timeout and caller cancellation propagate', async () => {
  const x = setup();
  x.f.set({delay: 500});
  x.provider.streamIdleTimeoutMs = 100;
  const adapter = new ProviderAdapter(x.transport, 'fixture-model');
  await expect(adapter.generate(x.request)).rejects.toMatchObject({code: 'TIMEOUT'});
  const controller = new AbortController();
  const result = adapter.generate(x.request, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await expect(result).rejects.toMatchObject({code: 'CANCELLED'});
  x.db.close();
});
test('malformed responses reject and unavailable usage stays null', async () => {
  const x = setup();
  const adapter = new ProviderAdapter(x.transport, 'fixture-model');
  x.f.set({malformed: true});
  await expect(adapter.generate(x.request)).rejects.toBeInstanceOf(FutrynError);
  x.f.set({malformed: false, includeUsage: false});
  expect((await adapter.generate(x.request)).usage).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    costUSD: null,
    breakdown: [
      {
        accountId: x.account.id,
        providerId: x.provider.id,
        modelId: x.request.modelId,
        inputTokens: null,
        outputTokens: null,
        costUSD: null,
      },
    ],
  });
  x.db.close();
});
test('catalog pagination, manual entries, unknown metadata and account-isolated cache', async () => {
  const x = setup();
  x.f.set({pages: true});
  const catalog = new ModelCatalog(x.store, x.transport);
  catalog.manual('gateway/custom-model');
  expect((await catalog.discover()).models.map(m => m.id)).toEqual([
    'gateway/custom-model',
    'fixture-model',
    'page-two',
  ]);
  const other = {...x.account, id: crypto.randomUUID()};
  const otherCatalog = new ModelCatalog(
    x.store,
    new ProviderTransport(x.provider, other, x.vault, new ConfiguredNetworkPolicy()),
  );
  expect(otherCatalog.cached()).toEqual([]);
  x.f.set({status: 503});
  expect((await catalog.discover()).stale).toBe(true);
  x.f.set({status: 429});
  expect((await catalog.discover()).stale).toBe(true);
  x.f.set({status: 401});
  await expect(catalog.discover()).rejects.toMatchObject({code: 'AUTH'});
  x.db.close();
});
test('catalog normalizes compatible metadata and accepts ChatGPT entries without visibility', async () => {
  const x = setup('chat');
  const provider = {...x.provider, modelCatalogURL: x.provider.baseURL + '/catalog'};
  const transport = new ProviderTransport(provider, x.account, x.vault, new ConfiguredNetworkPolicy(), (async () =>
    Response.json({
      data: [
        {
          id: 'vision-model',
          name: 'Vision model',
          input_modalities: ['text', 'image'],
          supported_parameters: ['tools', 'reasoning'],
          reasoning_efforts: ['low', 'high'],
        },
      ],
    })) as unknown as typeof fetch);
  const model = (await new ModelCatalog(x.store, transport).discover()).models[0]!;
  expect(model.id).toBe('vision-model');
  expect(model.capabilities).toMatchObject({
    text: 'supported',
    vision: 'supported',
    tools: 'supported',
    reasoning: 'supported',
  });
  expect(model.reasoningEfforts).toEqual(['low', 'high']);
  x.db.close();
});

test('OpenAI-compatible chat sends an advertised reasoning effort through its native option', async () => {
  const x = setup('chat');
  try {
    const info = normalizeModel('fixture-model', 'fixture');
    info.reasoningEfforts = ['low', 'high'];
    info.capabilities.reasoning = 'supported';
    const adapter = new ProviderAdapter(x.transport, x.request.modelId, info);
    await adapter.generate({...x.request, reasoningEffort: 'high'});
    expect(x.f.requests.at(-1)?.body?.reasoning_effort).toBe('high');
  } finally {
    x.db.close();
  }
});

test('Anthropic and Gemini reject advertised effort levels when reasoning capability is unknown', async () => {
  for (const protocol of ['anthropic', 'gemini'] as const) {
    const x = setup(protocol);
    try {
      const info = normalizeModel('fixture-model', 'fixture');
      info.reasoningEfforts = ['high'];
      await expect(
        new ProviderAdapter(x.transport, x.request.modelId, info).generate({...x.request, reasoningEffort: 'high'}),
      ).rejects.toMatchObject({code: 'UNSUPPORTED'});
      expect(x.f.requests).toHaveLength(0);
    } finally {
      x.db.close();
    }
  }
});

test('metadata provenance never upgrades capability claims', () => {
  const x = setup();
  const catalog = new ModelCatalog(x.store, x.transport);
  catalog.manual('fixture-model');
  const before = catalog.cached()[0]!;
  before.contextLimit = 1234;
  before.pricing = {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'};
  x.store.update(s => {
    s.catalogs[0]!.models[0] = before;
  });
  catalog.enrichModelsDev({
    fixture: {models: {'fixture-model': {tool_call: true, cost: {input: 3}}}},
  });
  const model = catalog.cached()[0]!;
  expect(model.capabilities.tools).toBe('unknown');
  expect(model.contextLimit).toBe(1234);
  expect(model.pricing).toEqual({inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'});
  expect(model.metadataSource).toContain('models.dev');
  x.db.close();
});
test('multiple accounts, selection, rename, local logout fencing and no implicit fallback', async () => {
  const x = setup();
  const manager = new AccountManager(x.store, x.vault);
  const key = crypto.randomUUID();
  const second = await manager.add(x.provider.id, 'work', {kind: 'keyring', key}, 'fixture-second-secret');
  const router = new ModelRouter(x.store);
  const personalModel = new ModelCatalog(x.store, x.transport).manual('fixture-model');
  router.select(x.account, personalModel);
  expect(router.resolve().accountId).toBe(x.account.id);
  manager.use(second.id);
  expect(() => router.resolve()).toThrow();
  manager.rename(second.id, 'work-new');
  expect(manager.get('work-new').id).toBe(second.id);
  const secondModel = new ModelCatalog(
    x.store,
    new ProviderTransport(x.provider, second, x.vault, new ConfiguredNetworkPolicy()),
  ).manual('fixture-model');
  router.select(second, secondModel, '/project');
  await manager.logout(second.id, true);
  expect(x.vault.values.has(key)).toBe(false);
  expect(() => router.resolve('/project')).toThrow();
  expect(x.store.read().accounts).toHaveLength(1);
  x.db.close();
});
test('registry rejects duplicate identities, removal with accounts and unknown fields', () => {
  const x = setup();
  const registry = new ProviderRegistry(x.store);
  expect(() => registry.add(x.provider)).toThrow();
  expect(() => registry.remove(x.provider.id)).toThrow();
  expect(() => registry.add({...x.provider, id: 'new', shell: 'evil'})).toThrow();
  x.db.close();
});
test('retry policy respects Retry-After, bounded jitter and nonretriable auth', () => {
  expect(retryAfter('120')).toBe(30000);
  expect(retryAfter('invalid')).toBeNull();
  expect(retryDelay(0, 1000, () => 0)).toBe(1000);
  expect(retryDelay(99, null, () => 1)).toBe(30000);
});
test('estimated cost guard rejects unknown/unaffordable models before network and marks cost estimates', async () => {
  const x = setup();
  await expect(
    new ProviderAdapter(x.transport, 'fixture-model').generate({...x.request, maxEstimatedCostUSD: 1}),
  ).rejects.toMatchObject({code: 'BUDGET'});
  const info = normalizeModel('fixture-model', 'fixture');
  info.pricing = {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'};
  const adapter = new ProviderAdapter(x.transport, 'fixture-model', info);
  await expect(adapter.generate({...x.request, maxEstimatedCostUSD: 0.000000001})).rejects.toMatchObject({
    code: 'BUDGET',
  });
  expect(x.f.requests).toHaveLength(0);
  const response = await adapter.generate({...x.request, maxEstimatedCostUSD: 1});
  expect(response.usage.costUSD).toBe(0.000008);
  expect(response.usage.costEstimated).toBe(true);
  x.db.close();
});

test('chat HTTP usage preserves explicit zero breakdowns without inventing missing counters', async () => {
  const x = setup();
  let reported: Record<string, unknown> = {};
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {stream?: boolean};
      const base = {id: 'usage-fixture', object: 'chat.completion', created: 1234567890, model: 'fixture-model'};
      if (!body.stream)
        return Response.json({
          ...base,
          choices: [{index: 0, message: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}],
          usage: reported,
        });
      return new Response(
        [
          {
            ...base,
            object: 'chat.completion.chunk',
            choices: [{index: 0, delta: {role: 'assistant', content: 'Done'}, finish_reason: null}],
          },
          {...base, object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]},
          {...base, object: 'chat.completion.chunk', choices: [], usage: reported},
        ]
          .map(value => `data: ${JSON.stringify(value)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
        {headers: {'content-type': 'text/event-stream'}},
      );
    },
  });
  try {
    const transport = new ProviderTransport(
      {...x.provider, baseURL: `http://127.0.0.1:${server.port}/v1`},
      x.account,
      x.vault,
      new ConfiguredNetworkPolicy(),
    );
    const adapter = new ProviderAdapter(transport, x.request.modelId);
    for (const stream of [false, true]) {
      const read = async () =>
        stream
          ? (await Array.fromAsync(adapter.stream(x.request))).find(event => event.type === 'completed')!.usage
          : (await adapter.generate(x.request)).usage;
      reported = {
        prompt_tokens: 4,
        completion_tokens: 2,
        prompt_tokens_details: {cached_tokens: 0},
        completion_tokens_details: {reasoning_tokens: 0},
      };
      expect(await read()).toMatchObject({inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0});
      reported = {prompt_tokens: 4, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 4};
      expect((await read()).cacheReadTokens).toBe(0);
      reported = {prompt_tokens: 4, completion_tokens: 2};
      const missing = await read();
      expect(missing.cacheReadTokens).toBeUndefined();
      expect(missing.cacheWriteTokens).toBeUndefined();
      expect(missing.reasoningTokens).toBeUndefined();
      reported = {
        inputTokens: 7,
        outputTokens: 3,
        inputTokenDetails: {cacheReadTokens: 1},
        outputTokenDetails: {reasoningTokens: 2},
      };
      expect(await read()).toMatchObject({inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, reasoningTokens: 2});
      reported = {};
      expect(await read()).toMatchObject({inputTokens: null, outputTokens: null});
    }
    // Cache counters are a breakdown of the reported input total. They must not make the
    // aggregate cost disappear: without cache-specific prices this remains an explicitly marked
    // estimate at the model's normal input rate.
    const info = normalizeModel('fixture-model', 'fixture');
    info.pricing = {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'};
    reported = {
      prompt_tokens: 10,
      completion_tokens: 4,
      prompt_tokens_details: {cached_tokens: 6, cache_write_tokens: 2},
      completion_tokens_details: {reasoning_tokens: 1},
    };
    const priced = await new ProviderAdapter(transport, x.request.modelId, info).generate(x.request);
    expect(priced.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      costUSD: 0.000018,
      costEstimated: true,
    });
    // A broken provider counter cannot create a negative usage value or fail an otherwise valid
    // response; the cache detail stays visible while the non-cached remainder is clamped.
    reported = {prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: {cached_tokens: 8}};
    const malformedBreakdown = await new ProviderAdapter(transport, x.request.modelId, info).generate(x.request);
    expect(malformedBreakdown.usage.cacheReadTokens).toBe(8);
    expect(malformedBreakdown.usage.costUSD).toBe(0.000008);
  } finally {
    server.stop(true);
    x.db.close();
  }
});

test('Responses HTTP usage retains explicitly reported zero cache reads', async () => {
  const x = setup('responses');
  try {
    x.f.set({cacheTokens: 0});
    const adapter = new ProviderAdapter(x.transport, x.request.modelId);
    expect((await adapter.generate(x.request)).usage.cacheReadTokens).toBe(0);
    const events = await Array.fromAsync(adapter.stream(x.request));
    expect(events.find(event => event.type === 'completed')!.usage.cacheReadTokens).toBe(0);
  } finally {
    x.db.close();
  }
});

test('F5: Responses sends a hashed prompt_cache_key, stable per session and different across sessions', async () => {
  const x = setup('responses');
  try {
    const adapter = new ProviderAdapter(x.transport, x.request.modelId);
    const sent = async (cacheKey: string | undefined) => {
      const before = x.f.requests.length;
      await Array.fromAsync(
        adapter.stream({...x.request, requestId: crypto.randomUUID(), ...(cacheKey ? {cacheKey} : {})}),
      );
      const bodies = x.f.requests.slice(before).map(r => r.body as Record<string, unknown>);
      return bodies.at(-1)!.prompt_cache_key as string | undefined;
    };
    const a1 = await sent('session-A');
    const a2 = await sent('session-A');
    const b = await sent('session-B');
    expect(a1).toMatch(/^futryn-[0-9a-f]{32}$/);
    expect(a2).toBe(a1);
    expect(b).toMatch(/^futryn-[0-9a-f]{32}$/);
    expect(b).not.toBe(a1);
    expect(a1).not.toContain('session-A');
    expect(await sent(undefined)).toBeUndefined();
  } finally {
    x.db.close();
  }
});

test('F5: chat protocol never receives prompt_cache_key', async () => {
  const x = setup('chat');
  try {
    const adapter = new ProviderAdapter(x.transport, x.request.modelId);
    const before = x.f.requests.length;
    await Array.fromAsync(adapter.stream({...x.request, cacheKey: 'session-A'}));
    expect(JSON.stringify(x.f.requests.slice(before).map(r => r.body))).not.toContain('cache_key');
  } finally {
    x.db.close();
  }
});
