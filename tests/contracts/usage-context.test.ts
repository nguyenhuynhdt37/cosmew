import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynError, type ModelPort} from '@cosmew/contracts';
import {Conversation} from '@cosmew/core';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {Redactor, redactModel} from '@cosmew/security';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-usage-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}
async function setup() {
  const dir = directory();
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  const vault = memoryVault();
  const app = startup(dir, {vault});
  cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', {id: 'usage', auth: 'none', streamUsage: true}));
  const account = await app.accounts.add('usage', 'first', {kind: 'none'});
  const client = app.createFutrynClient(dir);
  await client.discoverModels();
  client.selectModel('fixture-model');
  return {app, client, dir, account, server, vault};
}
async function send(
  client: ReturnType<typeof startup>['createFutrynClient'] extends (...args: any[]) => infer R ? R : never,
  text: string,
) {
  for await (const _event of client.sendMessage(text)) {
    /* real HTTP adapter */
  }
}

test('unknown usage stays unknown; old history is not backfilled with zero consumption', async () => {
  const c = await setup();
  c.server.set({includeUsage: false});
  expect(c.client.usage().inputTokens).toBeNull();
  expect(c.client.usage().costUSD).toBeNull();
  const old = c.app.conversations.create({accountId: c.account.id, modelId: 'fixture-model'});
  c.app.conversations.append(old, {role: 'user', content: 'Historical'}, 'committed');
  c.app.conversations.append(old, {role: 'assistant', content: 'Historical response'}, 'committed');
  c.client.resumeSession(old);
  expect(c.client.status().lastUsage).toBeNull();
  expect(c.client.usage().historicalTurns).toBe(1);
  expect(c.client.usage().inputTokens).toBeNull();
});

test('SQLite v1 migration preserves conversations; cancelled/failed usage persists atomically; future schemas fail closed', async () => {
  const dir = directory();
  const legacy = new Database(join(dir, 'provider-auth.sqlite'));
  legacy.exec(
    'CREATE TABLE conversations(id TEXT PRIMARY KEY, selection TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0); CREATE TABLE messages(conversation TEXT NOT NULL, revision INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(conversation,revision)); PRAGMA user_version=1',
  );
  const legacyId = crypto.randomUUID();
  const legacySelection = {accountId: crypto.randomUUID(), modelId: 'legacy-model'};
  legacy.query('INSERT INTO conversations VALUES(?,?,2)').run(legacyId, JSON.stringify(legacySelection));
  legacy.query('INSERT INTO messages VALUES(?,?,?,?,?)').run(legacyId, 1, 'user', 'Old question', 'committed');
  legacy.query('INSERT INTO messages VALUES(?,?,?,?,?)').run(legacyId, 2, 'assistant', 'Old answer', 'committed');
  legacy.close();
  const db = openPrivateDatabase(dir);
  cleanup.push(() => db.close());
  expect((db.query('PRAGMA user_version').get() as any).user_version).toBe(11);
  expect(
    (db.query('PRAGMA table_info(messages)').all() as {name: string}[]).some(column => column.name === 'parts'),
  ).toBe(true); // v3 tool parts
  const store = new SqliteConversations(db);
  expect(store.get(legacyId)?.messages.map(message => message.content)).toEqual(['Old question', 'Old answer']);
  expect(store.get(legacyId)?.turns).toEqual([]);
  const selection = {accountId: crypto.randomUUID(), modelId: 'fixture-model'};
  for (const code of ['CANCELLED', 'TRANSPORT', 'TIMEOUT', 'CONTEXT_LIMIT', 'PROTOCOL'] as const) {
    const model: ModelPort = {
      generate: async () => {
        throw new Error();
      },
      async *stream() {
        yield {type: 'started', requestId: crypto.randomUUID()};
        yield {type: 'usage', usage: {inputTokens: 9, outputTokens: null, costUSD: null}};
        if (code !== 'PROTOCOL') throw new FutrynError(code);
      },
    };
    const conv = new Conversation(selection, model, store);
    await expect(
      (async () => {
        for await (const event of conv.send('Private prompt')) {
          if (event.type === 'usage') {
            expect(store.get(conv.id)?.turns?.[0]?.usage?.inputTokens).toBe(9);
            expect(store.get(conv.id)?.turns?.[0]?.outcome).toBe('pending');
          }
        }
      })(),
    ).rejects.toMatchObject({code});
    const record = store.get(conv.id)!;
    expect(record.turns![0]!.outcome).toBe(code === 'CANCELLED' ? 'cancelled' : 'failed');
    expect(record.turns![0]!.stopReason).toBe(
      code === 'CANCELLED' ? 'cancelled' : code === 'CONTEXT_LIMIT' ? 'context_window' : 'failed',
    );
    expect(record.turns![0]!.errorCode).toBe(code);
    expect(record.recovery?.turns[0]?.events.map(event => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({type: 'model.finished', errorCode: code, inputTokens: 9, outputTokens: null}),
        expect.objectContaining({type: 'turn.finished', errorCode: code}),
      ]),
    );
    expect(record.turns![0]!.usage?.inputTokens).toBe(9);
    expect(JSON.stringify(record.turns)).not.toContain('Private prompt');
    expect(record.messages[0]!.state).toBe('interrupted');
  }
  const future = directory();
  const invalid = new Database(join(future, 'provider-auth.sqlite'));
  invalid.exec('PRAGMA user_version=12');
  invalid.close();
  expect(() => openPrivateDatabase(future)).toThrow();
});

test('reasoning summaries use streaming redaction independently of answer text', async () => {
  const redactor = new Redactor();
  redactor.register('fixture-private-secret');
  const model: ModelPort = {
    generate: async () => {
      throw new Error();
    },
    async *stream() {
      yield {type: 'reasoningDelta', text: 'Summary fixture-pri'};
      yield {type: 'textDelta', text: 'Answer'};
      yield {type: 'reasoningDelta', text: 'vate-secret'};
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 0, outputTokens: 0, costUSD: 0}};
    },
  };
  const output = [];
  for await (const event of redactModel(model, redactor).stream({
    requestId: crypto.randomUUID(),
    modelId: 'model',
    messages: [{role: 'user', content: 'Hi'}],
    maxOutputTokens: 100,
    tools: [],
  }))
    output.push(event);
  expect(JSON.stringify(output)).not.toContain('fixture-private-secret');
  expect(
    output
      .filter(e => e.type === 'reasoningDelta')
      .map(e => e.text)
      .join(''),
  ).toBe('Summary [REDACTED]');
});

test('documented provider catalog metadata preserves limits and converts OpenRouter per-token prices once', async () => {
  const dir = directory();
  const vault = memoryVault();
  const app = startup(dir, {
    vault,
    fetch: Object.assign(
      async () =>
        Response.json({
          data: [
            {
              id: 'provider/model',
              name: 'Model',
              context_length: 128000,
              top_provider: {max_completion_tokens: 4096},
              pricing: {prompt: '0.000003', completion: '0.000007'},
            },
          ],
        }),
      {preconnect: fetch.preconnect},
    ),
  });
  cleanup.push(() => app.db.close());
  app.registry.add({
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'chat',
    baseURL: 'https://openrouter.ai/api/v1',
    catalog: 'openai',
    auth: 'none',
    metadataVersion: 1,
    timeoutMs: 1000,
  });
  const account = await app.accounts.add('openrouter', 'catalog', {kind: 'none'});
  const result = await app.discoverModels(account);
  expect(result.models[0]!.contextLimit).toBe(128000);
  expect(result.models[0]!.outputLimit).toBe(4096);
  expect(result.models[0]!.pricing).toEqual({inputPerMillion: 3, outputPerMillion: 7, currency: 'USD'});
  expect(result.models[0]!.reasoningEfforts).toBeUndefined();
});

test('an explicit output cap over context capacity fails before a provider request; no cap is sent by default (Codex)', async () => {
  const c = await setup();
  c.app.settings.update(settings => {
    const model = settings.catalogs[0]!.models[0]!;
    model.contextLimit = 100;
    model.outputLimit = 100;
  });
  const before = c.server.requests.filter(request => request.body).length;
  const over = async () => {
    for await (const _event of c.client.sendMessage('Over limit', {maxOutputTokens: 100})) {
      /* refused before sending */
    }
  };
  await expect(over()).rejects.toMatchObject({code: 'CONTEXT_LIMIT'});
  expect(c.server.requests.filter(request => request.body)).toHaveLength(before);
  // A window that holds the input: nothing is reserved and no cap is sent.
  c.app.settings.update(settings => {
    settings.catalogs[0]!.models[0]!.contextLimit = 100_000;
  });
  for await (const _event of c.client.sendMessage('No cap')) {
    /* real request without max tokens */
  }
  expect(c.server.requests.filter(request => request.body).at(-1)!.body).not.toHaveProperty('max_tokens');
  for await (const _event of c.client.sendMessage('Explicit reserve', {maxOutputTokens: 30})) {
    /* real request */
  }
  expect(c.client.usage().last?.outcome).toBe('completed');
});

test('signed-out switch target offers sign-in for the same profile and preserves source history', async () => {
  const c = await setup();
  await send(c.client, 'Keep this history');
  const second = await c.app.accounts.add('usage', 'expired', {kind: 'none'});
  await c.app.accounts.logout(second.id);
  const session = c.client.activeSession()!.id;
  expect(c.client.activeSession()!.id).toBe(session);
  expect(c.client.status().activeAccount?.id).toBe(c.account.id);
  const restored = await c.client.connectAccount({
    providerId: 'usage',
    alias: 'expired',
    credential: {kind: 'none'},
    reauthenticateAccountId: second.id,
  });
  expect(restored.id).toBe(second.id);
  expect(c.client.activeSession()!.id).toBe(session);
  await c.client.switchAccount(second.id, true);
  expect(c.client.activeSession()!.selection.accountId).toBe(second.id);
  expect(c.client.activeSession()!.messages.length).toBe(2);
});

test('late account discovery cannot overwrite a newer explicit selection', async () => {
  const c = await setup();
  await send(c.client, 'Source history');
  const second = await c.app.accounts.add('usage', 'target', {kind: 'none'});
  const third = await c.app.accounts.add('usage', 'newer', {kind: 'none'});
  c.server.set({delay: 100});
  const switching = c.client.switchAccount(second.id, true);
  const outcome = switching.then(
    () => null,
    error => error,
  );
  c.client.useAccount(third.id);
  expect(await outcome).toMatchObject({code: 'POLICY'});
  expect(c.client.status().activeAccount?.id).toBe(third.id);
  expect(c.app.conversations.list()).toHaveLength(1);
});

test('logout of an inactive account preserves the current model and conversation', async () => {
  const c = await setup();
  await send(c.client, 'Keep current chat');
  await c.app.accounts.add('usage', 'inactive', {kind: 'none'});
  const session = c.client.activeSession()!.id;
  expect(c.client.activeSession()!.id).toBe(session);
  expect(c.client.status().activeAccount?.id).toBe(c.account.id);
});

test('cancelled reconnect of the current account clears the unusable selection but retains durable history', async () => {
  const c = await setup();
  await send(c.client, 'Retain on disk');
  const session = c.client.activeSession()!.id;
  c.server.set({delay: 150});
  const abort = new AbortController();
  const reconnect = c.client
    .connectAccount(
      {providerId: 'usage', alias: 'first', credential: {kind: 'none'}, reauthenticateAccountId: c.account.id},
      abort.signal,
    )
    .then(
      () => null,
      error => error,
    );
  await Bun.sleep(20);
  abort.abort();
  expect(await reconnect).toMatchObject({code: 'CANCELLED'});
  expect(c.client.status().activeAccount).toBeNull();
  expect(c.client.status().selection).toBeNull();
  expect(c.client.activeSession()).toBeNull();
  expect(c.app.conversations.get(session)?.messages).toHaveLength(2);
});

test('empty permissions is a compact manager with no grant actions or transcript bleed', async () => {
  const c = await setup();
  // Digits are not decisions here, and Escape leaves any half-typed rule unsaved.
  expect(c.client.listPermissions()).toHaveLength(0);
  expect(c.client.permissionRules()).toEqual({allow: [], ask: [], deny: []});
});
