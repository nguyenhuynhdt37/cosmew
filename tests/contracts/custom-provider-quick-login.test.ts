import {afterEach, expect, setDefaultTimeout, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CONTEXT_COMPACTION_FRACTION} from '@cosmew/contracts';
import {
  applyCatalogMetadata,
  deriveProviderId,
  formatTokenCount,
  normalizeModel,
  parseQuickProviderInput,
} from '@cosmew/models';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

setDefaultTimeout(30_000);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-quick-provider-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function startMockGateway(handler: (req: Request, url: URL) => Response | Promise<Response>): {
  url: string;
  requests: {method: string; path: string; auth: string | null; body?: any}[];
} {
  const requests: {method: string; path: string; auth: string | null; body?: any}[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: any;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const cloned = req.clone();
        try {
          body = await cloned.json();
        } catch {
          body = undefined;
        }
      }
      requests.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get('authorization'),
        body,
      });
      return handler(req, url);
    },
  });
  cleanup.push(() => server.stop(true));
  return {url: `http://127.0.0.1:${server.port}`, requests};
}

function chatJsonReply(text = 'OK', promptTokens = 12, completionTokens = 4) {
  return Response.json({
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 1,
    model: 'fixture',
    choices: [{index: 0, message: {role: 'assistant', content: text}, finish_reason: 'stop'}],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function chatStreamReply(text = 'Hello from gateway', promptTokens = 100, completionTokens = 20) {
  const chunks = [
    {
      id: 'chatcmpl-s1',
      object: 'chat.completion.chunk',
      choices: [{index: 0, delta: {role: 'assistant', content: text}}],
    },
    {
      id: 'chatcmpl-s1',
      object: 'chat.completion.chunk',
      choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
  ];
  const payload = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(payload, {headers: {'content-type': 'text/event-stream'}});
}

test('parseQuickProviderInput, deriveProviderId and applyCatalogMetadata parse third-party gateway payloads accurately', () => {
  expect(
    parseQuickProviderInput('https://gateway.example.test/v1/ | sk-fixture-secret-only | ag/gemini-3-flash'),
  ).toEqual({
    baseURL: 'https://gateway.example.test/v1',
    apiKey: 'sk-fixture-secret-only',
    modelId: 'ag/gemini-3-flash',
  });
  expect(parseQuickProviderInput('http://127.0.0.1:8080/v1 | sk-fixture-secret-only')).toEqual({
    baseURL: 'http://127.0.0.1:8080/v1',
    apiKey: 'sk-fixture-secret-only',
  });
  expect(parseQuickProviderInput('https://gateway.example.test/v1')).toEqual({
    baseURL: 'https://gateway.example.test/v1',
  });
  expect(() => parseQuickProviderInput('http://remote.example.test/v1 | sk-fixture-secret-only')).toThrow(
    expect.objectContaining({code: 'POLICY'}),
  );
  expect(() => parseQuickProviderInput('https://user:pass@gateway.example.test/v1')).toThrow(
    expect.objectContaining({code: 'POLICY'}),
  );
  expect(() => parseQuickProviderInput('https://gateway.example.test/v1?key=1')).toThrow(
    expect.objectContaining({code: 'POLICY'}),
  );
  expect(() => parseQuickProviderInput('https://gateway.example.test/v1 | a | b | c')).toThrow(
    expect.objectContaining({code: 'INVALID_INPUT'}),
  );

  expect(deriveProviderId('https://9router.example.test/v1')).toBe('9router.example.test');
  expect(
    deriveProviderId('https://9router.example.test/v1', new Set(['9router.example.test']), new Set(['chatgpt-api'])),
  ).toBe('9router.example.test-2');
  expect(deriveProviderId('http://127.0.0.1:11434/v1')).toBe('127.0.0.1-11434');

  // 9Router-style payload with 1M context, 65536 output, thinkingCanDisable and thinkingRange
  const routerModel = normalizeModel('ag/gemini-3-flash', 'Gemini 3 Flash');
  applyCatalogMetadata(
    routerModel,
    {
      id: 'ag/gemini-3-flash',
      context_length: 1_048_576,
      max_completion_tokens: 65_536,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        thinkingCanDisable: true,
        thinkingRange: {min: 0, max: 24_576},
      },
      pricing: {input: 0.15, output: 0.6},
    },
    'https://9router.example.test/v1',
    'openai',
  );
  expect(routerModel.contextLimit).toBe(1_048_576);
  expect(routerModel.outputLimit).toBe(65_536);
  expect(routerModel.capabilities).toMatchObject({tools: 'supported', vision: 'supported', reasoning: 'supported'});
  expect(routerModel.reasoningOptions).toEqual({toggle: true, budgetMin: 0});
  expect(routerModel.pricing).toEqual({inputPerMillion: 0.15, outputPerMillion: 0.6, currency: 'USD'});
  expect(routerModel.metadataSource).toBe('https://9router.example.test/v1/models');
  expect(routerModel.metadataFetchedAt).toBe(routerModel.fetchedAt);

  // OpenRouter-style per-token pricing string works on any custom gateway too
  const orModel = normalizeModel('vendor/pro', 'Pro');
  applyCatalogMetadata(
    orModel,
    {
      id: 'vendor/pro',
      limits: {context: 200_000, output: 64_000},
      pricing: {prompt: '0.000003', completion: '0.000015'},
    },
    'https://proxy.example.test/v1',
    'openai',
  );
  expect(orModel.contextLimit).toBe(200_000);
  expect(orModel.outputLimit).toBe(64_000);
  expect(orModel.pricing).toEqual({inputPerMillion: 3, outputPerMillion: 15, currency: 'USD'});

  // Gateway with no limits keeps null contextLimit/outputLimit and null metadataSource
  const bare = normalizeModel('bare-model', 'Bare');
  applyCatalogMetadata(bare, {id: 'bare-model'}, 'https://bare.example.test/v1', 'openai');
  expect(bare.contextLimit).toBeNull();
  expect(bare.outputLimit).toBeNull();
  expect(bare.metadataSource).toBeNull();

  expect(formatTokenCount(1_048_576)).toBe('1M');
  expect(formatTokenCount(65_536)).toBe('64k');
  expect(formatTokenCount(200_000)).toBe('200k');
  expect(formatTokenCount(64_000)).toBe('64k');
});

test('quickConnectProvider one-line setup discovers full 1M/200k limits, keeps key out of config.toml, powers /context and full-window turns', async () => {
  const secret = 'sk-fixture-secret-only';
  const catalogData = [
    {
      id: 'ag/gemini-3-flash',
      name: 'Gemini 3 Flash',
      context_length: 1_048_576,
      max_completion_tokens: 65_536,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        thinkingCanDisable: true,
        thinkingRange: {min: 0, max: 24_576},
      },
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      context_length: 200_000,
      max_completion_tokens: 64_000,
      capabilities: {tools: true, vision: true, reasoning: true},
    },
    ...Array.from({length: 22}, (_, index) => ({
      id: `gw/model-${index + 1}`,
      name: `Gateway Model ${index + 1}`,
      context_length: 128_000,
      max_completion_tokens: 16_384,
      capabilities: {tools: true, vision: false, reasoning: false},
    })),
  ];
  const gw = startMockGateway((req, url) => {
    if (req.headers.get('authorization') !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({error: {message: `Rejected ${secret}`}}), {status: 401});
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({object: 'list', data: catalogData});
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return req
        .json()
        .then((body: any) => (body?.stream ? chatStreamReply('Gateway turn ok', 150_000, 120) : chatJsonReply('OK')));
    }
    return new Response('not found', {status: 404});
  });

  const dir = tempDir();
  const vault = memoryVault();
  const app = startup(dir, {vault, offline: true});
  cleanup.push(() => app.db.close());
  const client = app.createFutrynClient(dir);

  const result = await client.quickConnectProvider({
    raw: `${gw.url}/v1 | ${secret} | ag/gemini-3-flash`,
  });

  expect(result.protocol).toBe('chat');
  expect(result.catalog).toBe('openai');
  expect(result.modelsCount).toBe(24);
  expect(result.model.id).toBe('ag/gemini-3-flash');
  expect(result.model.contextLimit).toBe(1_048_576);
  expect(result.model.outputLimit).toBe(65_536);
  expect(result.model.capabilities).toMatchObject({tools: 'supported', vision: 'supported', reasoning: 'supported'});
  expect(result.model.reasoningOptions).toEqual({toggle: true, budgetMin: 0});
  expect(result.summary).toContain('1M ctx · 64k out');
  expect(result.summary).not.toContain(secret);

  // Verify config.toml has the provider and NEVER stores the API key.
  const configToml = readFileSync(join(dir, 'config.toml'), 'utf8');
  expect(configToml).toContain(`base_url = "${gw.url}/v1"`);
  expect(configToml).toContain('wire_api = "chat"');
  expect(configToml).not.toContain(secret);
  expect(JSON.stringify(app.settings.read())).not.toContain(secret);
  expect(result.account.credential.kind).toBe('keyring');
  expect([...vault.values.values()]).toEqual([secret]);

  // Verify 200k model in catalog preserved its exact limits too.
  const claude = client.cachedModels().find(m => m.id === 'claude-sonnet-4-6');
  expect(claude?.contextLimit).toBe(200_000);
  expect(claude?.outputLimit).toBe(64_000);

  // Manual re-pin of an existing catalog model preserves rich metadata instead of wiping it.
  const pinned = app.catalog(result.account).manual('ag/gemini-3-flash');
  expect(pinned.contextLimit).toBe(1_048_576);
  expect(pinned.outputLimit).toBe(65_536);

  // Verify /context reports 1,048,576 (never falls back to 128k) and auto-compaction threshold matches 85% of 1M.
  const ctx = client.context();
  expect(ctx.limitTokens).toBe(1_048_576);
  expect(ctx.outputLimit).toBe(65_536);
  expect(Math.floor(ctx.limitTokens! * CONTEXT_COMPACTION_FRACTION)).toBe(Math.floor(1_048_576 * 0.85));

  // Send a real turn over the configured gateway and confirm no premature auto-compaction at 150k tokens (>128k, <85% of 1M).
  let answer = '';
  const events: string[] = [];
  for await (const event of client.sendMessage('Say hello')) {
    events.push(event.type);
    if (event.type === 'textDelta') answer += event.text;
  }
  expect(answer).toBe('Gateway turn ok');
  expect(events).not.toContain('context.compacted');
  expect(client.context().limitTokens).toBe(1_048_576);

  // Reconnecting with another key reuses the same provider definition instead of duplicating config.toml tables.
  const second = await client
    .quickConnectProvider({
      baseURL: `${gw.url}/v1`,
      apiKey: secret,
      modelId: 'claude-sonnet-4-6',
    })
    .catch(error => error);
  // Same key on the same provider is rejected as duplicate identity, leaving the first account intact.
  expect(second).toMatchObject({code: 'INVALID_INPUT'});
  expect(app.registry.list()).toHaveLength(1);
  expect(app.accounts.list()).toHaveLength(1);
});

test('quickConnectProvider falls back from chat (404) to responses protocol automatically', async () => {
  const secret = 'sk-fixture-responses-only';
  const gw = startMockGateway((req, url) => {
    if (req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', {status: 401});
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({
        object: 'list',
        data: [{id: 'resp-model', context_length: 256_000, max_output_tokens: 32_768}],
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return new Response(JSON.stringify({error: {message: 'chat endpoint not supported'}}), {status: 404});
    }
    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      const response = {
        id: 'resp_fixture',
        object: 'response',
        created_at: 1,
        model: 'resp-model',
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{type: 'output_text', text: 'OK', annotations: []}],
          },
        ],
        usage: {input_tokens: 10, output_tokens: 2, total_tokens: 12},
      };
      const events = [
        {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
        {type: 'response.completed', response},
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: {'content-type': 'text/event-stream'},
      });
    }
    return new Response('not found', {status: 404});
  });

  const dir = tempDir();
  const app = startup(dir, {vault: memoryVault(), offline: true});
  cleanup.push(() => app.db.close());
  const client = app.createFutrynClient(dir);

  const result = await client.quickConnectProvider({raw: `${gw.url}/v1 | ${secret}`});
  expect(result.protocol).toBe('responses');
  expect(result.model.id).toBe('resp-model');
  expect(result.model.contextLimit).toBe(256_000);
  expect(result.model.outputLimit).toBe(32_768);
  expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('wire_api = "responses"');
});

test('quickConnectProvider handles manual-only gateways (404 /models) with explicit model and rejects without model', async () => {
  const gw = startMockGateway((req, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/models') return new Response('not found', {status: 404});
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return chatStreamReply('OK');
    return new Response('not found', {status: 404});
  });

  const dir = tempDir();
  const app = startup(dir, {vault: memoryVault(), offline: true});
  cleanup.push(() => app.db.close());
  const client = app.createFutrynClient(dir);

  // Without modelId on a 404 /models gateway -> NOT_FOUND and zero persisted artifacts.
  await expect(client.quickConnectProvider({baseURL: `${gw.url}/v1`})).rejects.toMatchObject({code: 'NOT_FOUND'});
  expect(app.registry.list()).toHaveLength(0);
  expect(app.accounts.list()).toHaveLength(0);
  expect(existsSync(join(dir, 'config.toml'))).toBe(false);

  // With explicit modelId (no-auth local loopback) -> succeeds with catalog='manual'.
  const result = await client.quickConnectProvider({raw: `${gw.url}/v1 | | local-manual-model`});
  expect(result.catalog).toBe('manual');
  expect(result.protocol).toBe('chat');
  expect(result.provider.auth).toBe('none');
  expect(result.model.id).toBe('local-manual-model');
  const toml = readFileSync(join(dir, 'config.toml'), 'utf8');
  expect(toml).toContain('requires_auth = false');
  expect(toml).toContain('models = ["local-manual-model"]');
});

test('quickConnectProvider rolls back cleanly on 401 AUTH and never leaks the secret', async () => {
  const secret = 'sk-fixture-bad-secret';
  const gw = startMockGateway(
    () => new Response(JSON.stringify({error: {message: `Invalid key ${secret}`}}), {status: 401}),
  );

  const dir = tempDir();
  const vault = memoryVault();
  const app = startup(dir, {vault, offline: true});
  cleanup.push(() => app.db.close());
  const client = app.createFutrynClient(dir);

  const error = await client.quickConnectProvider({raw: `${gw.url}/v1 | ${secret} | any-model`}).catch(e => e);
  expect(error).toMatchObject({code: 'AUTH'});
  expect(String(error)).not.toContain(secret);
  expect(app.redactor.text(`Leak check ${secret}`)).toBe('Leak check [REDACTED]');
  expect(app.registry.list()).toHaveLength(0);
  expect(app.accounts.list()).toHaveLength(0);
  expect(vault.values.size).toBe(0);
  expect(existsSync(join(dir, 'config.toml'))).toBe(false);
});

test('quickConnectProvider and verifyAccount succeed against SSE-only gateways (e.g. 9Router)', async () => {
  const secret = 'sk-fixture-sse-only';
  const gw = startMockGateway((req, url) => {
    if (req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', {status: 401});
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({
        object: 'list',
        data: [
          {
            id: 'ag/gemini-3-flash',
            context_length: 1_048_576,
            max_completion_tokens: 65_536,
            capabilities: {tools: true, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 65_536},
          },
        ],
      });
    }
    // Always respond with SSE stream even when request omits stream=true (real 9Router behavior).
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return chatStreamReply('OK', 200, 4);
    }
    return new Response('not found', {status: 404});
  });

  const dir = tempDir();
  const vault = memoryVault();
  const app = startup(dir, {vault, offline: true});
  cleanup.push(() => app.db.close());
  const client = app.createFutrynClient(dir);

  const result = await client.quickConnectProvider({
    raw: `${gw.url}/v1 | ${secret} | ag/gemini-3-flash`,
  });
  expect(result.protocol).toBe('chat');
  expect(result.model.contextLimit).toBe(1_048_576);
  expect(result.model.outputLimit).toBe(65_536);

  const verified = await client.verifyAccount();
  expect(verified).toEqual({ok: true});
});

test('interactive gateway login chooses from all pages before probing and persists the working stream mode', async () => {
  const gw = startMockGateway(async (req, url) => {
    if (url.pathname === '/v1/models') {
      if (url.searchParams.get('after_id') === 'unavailable') {
        return Response.json({data: [{id: 'chosen', context_length: 200_000, max_output_tokens: 64_000}]});
      }
      return Response.json({has_more: true, last_id: 'unavailable', data: [{id: 'unavailable'}]});
    }
    if (url.pathname === '/v1/chat/completions') {
      const body = await req.json();
      if (body.model === 'chosen' && body.stream && !body.stream_options) return chatStreamReply('OK');
      return Response.json({error: {message: 'Unsupported request options'}}, {status: 400});
    }
    return new Response(null, {status: 404});
  });
  const dir = tempDir();
  const app = startup(dir, {vault: memoryVault(), offline: true});
  cleanup.push(() => app.db.close());
  const client = app.createFutrynClient(dir);
  const result = await client.quickConnectProvider({
    baseURL: gw.url,
    chooseModel: async models => {
      expect(models.map(model => model.id)).toEqual(['unavailable', 'chosen']);
      expect(models[1]).toMatchObject({contextLimit: 200_000, outputLimit: 64_000});
      expect(gw.requests.every(request => request.method === 'GET')).toBe(true);
      expect(client.listAccounts()).toEqual([]);
      expect(existsSync(join(dir, 'config.toml'))).toBe(false);
      return 'chosen';
    },
  });

  expect(result.provider).toMatchObject({baseURL: gw.url + '/v1', streamUsage: false});
  expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('stream_usage = false');
  expect(client.context()).toMatchObject({limitTokens: 200_000, outputLimit: 64_000});
  const events = await Array.fromAsync(client.sendMessage('Reply OK'));
  expect(events.some(event => event.type === 'completed')).toBe(true);
  expect(gw.requests.filter(request => request.method === 'GET')).toHaveLength(3);
  expect(gw.requests.filter(request => request.method === 'POST').map(request => request.body.model)).toEqual([
    'chosen',
    'chosen',
    'chosen',
  ]);

  client.clearSessionView();
  client.selectModel('chosen', {scope: 'session'});
  const replacement = await client.quickConnectProvider({
    baseURL: gw.url + '/v1',
    apiKey: 'sk-fixture-second-account',
    modelId: 'chosen',
  });
  expect(replacement.account.id).not.toBe(result.account.id);
  expect(client.status().selection).toEqual({accountId: replacement.account.id, modelId: 'chosen'});
});

test('cancelling model selection leaves a manual-only gateway and its key unsaved', async () => {
  const gw = startMockGateway(() => new Response(null, {status: 404}));
  const dir = tempDir();
  const vault = memoryVault();
  const app = startup(dir, {vault, offline: true});
  cleanup.push(() => app.db.close());
  const signal = new AbortController();
  const client = app.createFutrynClient(dir);
  await expect(
    client.quickConnectProvider(
      {
        baseURL: gw.url + '/v1',
        apiKey: 'sk-fixture-cancelled',
        chooseModel: async models => {
          expect(models).toEqual([]);
          signal.abort();
          return 'manual-model';
        },
      },
      signal.signal,
    ),
  ).rejects.toMatchObject({code: 'CANCELLED'});
  expect(gw.requests.map(request => request.method)).toEqual(['GET']);
  expect(client.listAccounts()).toEqual([]);
  expect(vault.values.size).toBe(0);
  expect(existsSync(join(dir, 'config.toml'))).toBe(false);
});
