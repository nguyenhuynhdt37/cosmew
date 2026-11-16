import {afterEach, test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {
  FutrynError,
  type Account,
  type ConversationStore,
  type ModelPort,
  type ModelRequest,
  type Selection,
} from '@futryn/contracts';
import {Conversation} from '@futryn/core';
import {AccountManager, ModelCatalog, ProviderAdapter, ProviderTransport, normalizeModel} from '@futryn/models';
import {SqliteSettings} from '@futryn/persistence';
import {ConfiguredNetworkPolicy, Redactor} from '@futryn/security';
import {fixtureServer, memoryVault} from '../fixtures';

const fixtures: ReturnType<typeof fixtureServer>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.server.stop(true)));
const request: ModelRequest = {
  requestId: crypto.randomUUID(),
  modelId: 'fixture-model',
  messages: [{role: 'user', content: 'private prompt'}],
  maxOutputTokens: 16,
  tools: [],
};
function setup() {
  const f = fixtureServer();
  fixtures.push(f);
  const provider = f.provider();
  const account: Account = {
    id: crypto.randomUUID(),
    providerId: provider.id,
    alias: 'secret-account',
    status: 'unvalidated',
    validatedAt: null,
    credential: {kind: 'keyring', key: crypto.randomUUID()},
  };
  const vault = memoryVault();
  vault.values.set(account.credential.kind === 'keyring' ? account.credential.key : '', 'fixture-secret');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY,data TEXT)');
  const settings = new SqliteSettings(db);
  settings.update(s => {
    s.providers.push(provider);
    s.accounts.push(account);
  });
  return {
    f,
    provider,
    account,
    vault,
    db,
    settings,
    transport: new ProviderTransport(provider, account, vault, new ConfiguredNetworkPolicy()),
  };
}
test('redaction withholds only matching suffixes, blocks keys split across stream chunks', () => {
  const redactor = new Redactor();
  redactor.register('opaque-private-key');
  const stream = redactor.stream();
  expect(stream.push('Hello ')).toBe('Hello ');
  expect(stream.push('opaque-pri')).toBe('');
  expect(stream.push('vate-key end')).toBe('[REDACTED] end');
  expect(stream.finish()).toBe('');
  redactor.register('sk-fixture-secret');
  const api = redactor.stream();
  expect(api.push('sk-fixture-')).toBe('');
  expect(api.push('secret')).toBe('[REDACTED]');
});
for (const protocol of ['chat', 'responses', 'anthropic'] as const)
  test(`${protocol}: dropped terminal event cannot become a committed successful response`, async () => {
    const x = setup();
    x.f.set({dropped: true});
    const transport = new ProviderTransport(x.f.provider(protocol), x.account, x.vault, new ConfiguredNetworkPolicy());
    await expect(
      Array.fromAsync(new ProviderAdapter(transport, 'fixture-model').stream(request)),
    ).rejects.toMatchObject({code: 'PROTOCOL'});
    x.db.close();
  });
test('bounded response rejects flood and redirects without credential forwarding', async () => {
  const x = setup();
  let forwarded = 0;
  const evil = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      forwarded++;
      return new Response('unexpected');
    },
  });
  const source = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).pathname.endsWith('redirect'))
        return Response.redirect(`http://127.0.0.1:${evil.port}/steal`);
      return new Response('x'.repeat(200));
    },
  });
  try {
    x.provider.baseURL = `http://127.0.0.1:${source.port}/v1`;
    const transport = new ProviderTransport(x.provider, x.account, x.vault, new ConfiguredNetworkPolicy());
    await expect((await transport.request(x.provider.baseURL + '/flood', {}, 100)).text()).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
    await expect(transport.request(x.provider.baseURL + '/redirect')).rejects.toMatchObject({code: 'TRANSPORT'});
    expect(forwarded).toBe(0);
  } finally {
    source.stop(true);
    evil.stop(true);
    x.db.close();
  }
});
test('model/account mismatch and foreign origin fail before fetch; no fallback requests happen', async () => {
  const x = setup();
  const adapter = new ProviderAdapter(x.transport, 'selected-model');
  await expect(adapter.generate(request)).rejects.toMatchObject({code: 'INVALID_INPUT'});
  await expect(x.transport.request('https://unapproved.example/v1/chat/completions')).rejects.toMatchObject({
    code: 'POLICY',
  });
  expect(x.f.requests).toHaveLength(0);
  x.db.close();
});
test('failed key deletion fences account immediately and removal remains retryable', async () => {
  const x = setup();
  let fail = true;
  const vault = {
    ...x.vault,
    async delete() {
      if (fail) throw new FutrynError('STORAGE');
    },
  };
  const accounts = new AccountManager(x.settings, vault);
  await expect(accounts.logout(x.account.id, true)).rejects.toMatchObject({code: 'STORAGE'});
  expect(accounts.get(x.account.id).status).toBe('logged-out');
  expect(x.settings.read().accounts).toHaveLength(1);
  fail = false;
  await accounts.logout(x.account.id, true);
  expect(x.settings.read().accounts).toHaveLength(0);
  x.db.close();
});
test('account insertion failure rolls back only its newly created credential', async () => {
  const x = setup();
  const manager = new AccountManager(x.settings, x.vault);
  const key = crypto.randomUUID();
  await expect(
    manager.add(x.provider.id, x.account.alias, {kind: 'keyring', key}, 'second-secret'),
  ).rejects.toMatchObject({code: 'INVALID_INPUT'});
  expect(x.vault.values.has(key)).toBe(false);
  expect(x.vault.values.size).toBe(1);
  x.db.close();
});
test('cancelled stream has one attempt and never retries partial output', async () => {
  const x = setup();
  const control = new AbortController();
  let sawText = false;
  try {
    for await (const event of new ProviderAdapter(x.transport, 'fixture-model').stream(request, control.signal)) {
      if (event.type === 'textDelta') {
        sawText = true;
        control.abort();
      }
    }
  } catch (e) {
    expect(e).toMatchObject({code: 'CANCELLED'});
  }
  expect(sawText).toBe(true);
  expect(x.f.requests).toHaveLength(1);
  x.db.close();
});
test('malformed catalog rejects without replacing known manual cache', async () => {
  const x = setup();
  const catalog = new ModelCatalog(x.settings, x.transport);
  catalog.manual('explicit-model');
  x.f.set({malformed: true});
  await expect(catalog.discover()).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(catalog.cached()[0]?.id).toBe('explicit-model');
  x.db.close();
});
test('invalid tool-call input is passed to the Futryn router, never executed or validated by the adapter (ADR 0029)', async () => {
  const x = setup();
  x.f.set({tools: true, invalidTool: true});
  const info = normalizeModel('fixture-model', 'fixture');
  info.capabilities.tools = 'supported';
  const events = await Array.fromAsync(
    new ProviderAdapter(x.transport, 'fixture-model', info).stream({
      ...request,
      tools: [
        {
          name: 'lookup',
          description: 'fixture',
          inputSchema: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']},
        },
      ],
    }),
  );
  // The adapter only converts: the call arrives as data, and the ToolRouter answers INVALID_INPUT
  // to the model (tests/end-to-end/hannes-agent-matrix.test.ts proves the round trip).
  const call = events.find(e => e.type === 'toolCallComplete');
  expect(call?.type === 'toolCallComplete' && typeof (call.call.input as {query?: unknown}).query === 'string').toBe(
    false,
  );
  x.db.close();
});
test('reauthentication preserves ID and refuses another account credential reference', async () => {
  const x = setup();
  const manager = new AccountManager(x.settings, x.vault);
  const replacement = crypto.randomUUID();
  const updated = await manager.reauthenticate(x.account.id, {kind: 'keyring', key: replacement}, 'new-fixture-key');
  expect(updated.id).toBe(x.account.id);
  expect(x.vault.values.size).toBe(1);
  await expect(
    manager.add(x.provider.id, 'another', {kind: 'keyring', key: replacement}, 'overwrite-attempt'),
  ).rejects.toMatchObject({code: 'INVALID_INPUT'});
  expect(x.vault.values.get(replacement)).toBe('new-fixture-key');
  x.db.close();
});
test('late validation cannot revive logged-out accounts or validate a replacement credential', async () => {
  const x = setup();
  const manager = new AccountManager(x.settings, x.vault);
  await manager.logout(x.account.id);
  expect(() => manager.validation(x.account.id, true, x.account)).toThrow();
  await manager.reauthenticate(x.account.id, {kind: 'keyring', key: crypto.randomUUID()}, 'rotated-key');
  expect(() => manager.validation(x.account.id, true, x.account)).toThrow();
  expect(manager.get(x.account.id).status).toBe('unvalidated');
  x.db.close();
});
function recordingStore() {
  const actions: string[] = [];
  let rev = 0;
  const store: ConversationStore = {
    create(_s: Selection) {
      return 'conversation';
    },
    append() {
      actions.push('pending');
      return ++rev;
    },
    complete() {
      actions.push('complete');
    },
    interrupt() {
      actions.push('interrupted');
    },
  };
  return {store, actions};
}
test('core persists intent before provider request; failed user intent remains visible without inventing successful output', async () => {
  const r = recordingStore();
  let attempts = 0;
  const inputs: ModelRequest[] = [];
  const model: ModelPort = {
    generate: async () => {
      throw new Error('unused');
    },
    async *stream(input) {
      inputs.push(input);
      expect(r.actions.at(-1)).toBe('pending');
      attempts++;
      yield {type: 'started', requestId: input.requestId};
      yield {type: 'textDelta', text: 'hello'};
      if (attempts === 1) throw new FutrynError('TRANSPORT');
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: null, outputTokens: null, costUSD: null}};
    },
  };
  const conversation = new Conversation({accountId: crypto.randomUUID(), modelId: 'fixture-model'}, model, r.store);
  await expect(Array.fromAsync(conversation.send('failed-private-turn'))).rejects.toMatchObject({code: 'TRANSPORT'});
  expect(conversation.history()).toEqual([{role: 'user', content: 'failed-private-turn'}]);
  await Array.fromAsync(conversation.send('retry-explicitly'));
  expect(inputs[1]?.messages).toEqual([
    {role: 'user', content: 'failed-private-turn'},
    {role: 'user', content: 'retry-explicitly'},
  ]);
  expect(r.actions).toEqual(['pending', 'interrupted', 'pending', 'complete']);
});
test('core rejects tool execution and concurrent turns', async () => {
  const r = recordingStore();
  const model: ModelPort = {
    generate: async () => {
      throw new Error('unused');
    },
    async *stream(input) {
      yield {type: 'started', requestId: input.requestId};
      yield {type: 'toolCallComplete', call: {id: 'call', name: 'shell', input: {command: 'never-run'}}};
    },
  };
  const c = new Conversation({accountId: crypto.randomUUID(), modelId: 'fixture-model'}, model, r.store);
  const turn = c.send('one')[Symbol.asyncIterator]();
  await turn.next();
  await expect(Array.fromAsync(c.send('two'))).rejects.toMatchObject({code: 'POLICY'});
  await expect(turn.next()).rejects.toMatchObject({code: 'UNSUPPORTED'});
  expect(r.actions).toEqual(['pending', 'interrupted']);
});
test('provider timeout bounds silence, not the length of a streamed response (Codex stream idle timeout)', async () => {
  const x = setup();
  // Every chunk arrives well inside the timeout, but the whole response takes several timeouts.
  x.f.set({streamDelay: 60});
  const provider = x.f.provider('chat', {streamIdleTimeoutMs: 150});
  const transport = new ProviderTransport(provider, x.account, x.vault, new ConfiguredNetworkPolicy());
  const started = performance.now();
  const events = await Array.fromAsync(new ProviderAdapter(transport, 'fixture-model').stream(request));
  expect(performance.now() - started).toBeGreaterThan(150);
  expect(events.at(-1)).toMatchObject({type: 'completed'});

  // A provider that goes silent longer than the timeout still fails as TIMEOUT.
  x.f.set({streamDelay: 0, delay: 400});
  await expect(Array.fromAsync(new ProviderAdapter(transport, 'fixture-model').stream(request))).rejects.toMatchObject({
    code: 'TIMEOUT',
  });
  x.db.close();
});

test('one tool call may carry hundreds of KiB of arguments (a whole file), as on Codex', async () => {
  const x = setup();
  const patchText =
    '*** Begin Patch\n*** Add File: page.html\n' + '+<p>generated</p>\n'.repeat(20000) + '*** End Patch';
  x.f.set({toolCall: {name: 'apply_patch', args: JSON.stringify({patch: patchText})}});
  const transport = new ProviderTransport(x.f.provider('chat'), x.account, x.vault, new ConfiguredNetworkPolicy());
  const events = await Array.fromAsync(
    new ProviderAdapter(transport, 'fixture-model').stream({
      ...request,
      tools: [{name: 'apply_patch', description: 'patch', inputSchema: {type: 'object'}}],
    }),
  );
  const call = events.find(e => e.type === 'toolCallComplete');
  expect(call).toMatchObject({call: {name: 'apply_patch', input: {patch: patchText}}});
  expect(Buffer.byteLength(patchText)).toBeGreaterThan(256 * 1024);
  x.db.close();
});
