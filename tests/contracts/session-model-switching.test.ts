import {afterEach, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynError, type Message, type SessionRecord} from '@cosmew/contracts';
import {COMPACTION_PROMPT, SUMMARY_PREFIX} from '@cosmew/core';
import {SqliteConversations, openPrivateDatabase} from '@cosmew/persistence';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {messagesToTranscript} from '../../apps/tui/src/ink/features/transcript/logic';
import {
  account as fixtureAccount,
  dialogFixture,
  model as fixtureModel,
  selection as fixtureSelection,
} from '../../apps/tui/src/ink/features/picker/test-fixture';
import {memoryVault} from '../fixtures';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function makeMultiModelServices(
  modelsByHost: Record<string, string[]>,
  summaryText = 'HANDOFF-CHECKPOINT: keep recent context.',
) {
  const wire: {url: string; body: {model: string; messages: {role: string; content: unknown}[]}}[] = [];
  let summaryCalls = 0;
  const fetchImpl = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    const models = modelsByHost[host] ?? ['model-a', 'model-b'];
    if (!init?.body) {
      return Response.json({
        data: models.map(id => ({id, context_length: 128000, max_completion_tokens: 4096})),
      });
    }
    const body = JSON.parse(String(init.body));
    wire.push({url, body});
    const last = body.messages.at(-1);
    const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const summarizing = lastText.startsWith(COMPACTION_PROMPT.slice(0, 30));
    if (summarizing) summaryCalls++;
    const content = summarizing
      ? summaryText
      : lastText.startsWith('bulk-')
        ? `BULK(${body.model}) ` + 'historical detailed evidence '.repeat(500)
        : `reply(${body.model}):${lastText}`;
    const base = {id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model};
    return new Response(
      [
        {...base, choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: null}]},
        {
          ...base,
          choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 120, completion_tokens: 20, total_tokens: 140},
        },
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
      {headers: {'content-type': 'text/event-stream'}},
    );
  }) as typeof fetch;
  return {
    wire,
    get summaryCalls() {
      return summaryCalls;
    },
    services: {
      vault: memoryVault(),
      offline: true,
      fetch: fetchImpl,
    },
  };
}

async function drain(client: ReturnType<ReturnType<typeof startup>['createFutrynClient']>, text: string) {
  for await (const _event of client.sendMessage(text)) {
    /* consume stream */
  }
}

test('same-account default and session-only model switches update the active session in place and revoke session grants', async () => {
  const home = makeTempDir('cosmew-switch-same-');
  const ws = join(home, 'ws');
  mkdirSync(ws);
  const mock = makeMultiModelServices({'provider-a.example.test': ['model-a', 'model-b', 'model-c']});
  const app = startup(home, mock.services);
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add({
    id: 'provider-a',
    name: 'Provider A',
    baseURL: 'https://provider-a.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
    streamUsage: true,
  });
  const accountA = await app.accounts.add('provider-a', 'acct-a', {kind: 'none'});
  const client = app.createFutrynClient(ws);
  await client.discoverModels();
  client.selectModel('model-a');
  client.updateUserPreferences({autoCompact: false});

  await drain(client, 'turn 1 with model-a');
  const sessionId = client.activeSession()!.id;
  client.setPermissionMode('acceptEdits');
  client.setMode('plan');

  // Default scope switch updates both active session and persisted default selection without creating a second session.
  client.selectModel('model-b');
  expect(client.activeSession()?.id).toBe(sessionId);
  expect(client.status().selection).toEqual({accountId: accountA.id, modelId: 'model-b'});
  expect(app.settings.read().selection).toEqual({accountId: accountA.id, modelId: 'model-b'});
  expect(app.conversations.list(realpathSync(ws))).toHaveLength(1);
  expect(client.permissionMode()).toBe('default');
  expect(client.mode()).toBe('plan');

  await drain(client, 'turn 2 with model-b');
  expect(mock.wire.at(-1)!.body.model).toBe('model-b');

  // Session-only switch updates the same session ID without modifying persisted settings.
  const settingsBefore = JSON.stringify(app.settings.read());
  client.setPermissionMode('acceptEdits');
  client.selectModel('model-c', {scope: 'session'});
  expect(client.activeSession()?.id).toBe(sessionId);
  expect(client.status().selection).toEqual({accountId: accountA.id, modelId: 'model-c'});
  expect(JSON.stringify(app.settings.read())).toBe(settingsBefore);
  expect(app.conversations.get(sessionId)?.selection).toEqual({accountId: accountA.id, modelId: 'model-c'});
  expect(client.permissionMode()).toBe('default');
  expect(client.mode()).toBe('plan');

  await drain(client, 'turn 3 with model-c');
  expect(mock.wire.at(-1)!.body.model).toBe('model-c');
  expect(app.conversations.list(realpathSync(ws))).toHaveLength(1);
  expect(client.getSession(sessionId)?.turns?.map(t => t.modelId)).toEqual(['model-a', 'model-b', 'model-c']);
});

test('cross-account switch + compact + new turns survive SQLite restart on the exact same session ID with per-model attribution', async () => {
  const home = makeTempDir('cosmew-switch-restart-');
  const ws = join(home, 'ws');
  mkdirSync(ws);
  const mock = makeMultiModelServices({
    'provider-a.example.test': ['model-a'],
    'provider-b.example.test': ['model-b'],
  });
  let app = startup(home, mock.services);
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add({
    id: 'provider-a',
    name: 'Provider A',
    baseURL: 'https://provider-a.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
    streamUsage: true,
  });
  app.registry.add({
    id: 'provider-b',
    name: 'Provider B',
    baseURL: 'https://provider-b.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
    streamUsage: true,
  });
  const accountA = await app.accounts.add('provider-a', 'acct-a', {kind: 'none'});
  const accountB = await app.accounts.add('provider-b', 'acct-b', {kind: 'none'});

  let client = app.createFutrynClient(ws);
  await client.discoverModels({accountId: accountA.id});
  client.selectModel('model-a', {accountId: accountA.id});
  client.updateUserPreferences({autoCompact: false});

  for (let i = 0; i < 4; i++) await drain(client, `bulk-${i}`);
  const originalSessionId = client.activeSession()!.id;
  await client.renameCurrentSession('Pinned investigation');

  // Switch to another account & model while keeping history on the exact same session ID.
  await client.switchAccount(accountB.id, true, 'model-b');
  expect(client.activeSession()?.id).toBe(originalSessionId);
  expect(client.status().sessionTitle).toBe('Pinned investigation');
  expect(client.status().selection).toEqual({accountId: accountB.id, modelId: 'model-b'});
  expect(app.conversations.list(realpathSync(ws))).toHaveLength(1);

  // Compact on the same session using model-b, then chat further.
  expect(await client.compact()).toMatchObject({compacted: true, strategy: 'model'});
  expect(mock.summaryCalls).toBe(1);
  for (let i = 0; i < 3; i++) await drain(client, `after-compact-${i}`);

  const beforeClose = client.activeSession()!;
  const beforePreview = client.context();
  expect(beforeClose.id).toBe(originalSessionId);
  expect(beforeClose.messages).toHaveLength(14);
  expect(beforePreview.estimateSource).toBe('preview');

  // Close SQLite completely and reopen, then resume the original session ID.
  await app.shutdownCommands();
  app.db.close();
  app = startup(home, mock.services);
  client = app.createFutrynClient(ws);
  const resumed = client.resumeSession(originalSessionId);

  expect(resumed.id).toBe(originalSessionId);
  expect(resumed.selection).toEqual({accountId: accountB.id, modelId: 'model-b'});
  expect(resumed.messages).toEqual(beforeClose.messages);
  expect(client.status().sessionTitle).toBe('Pinned investigation');
  expect(app.conversations.recover(originalSessionId).compaction?.strategy).toBe('model');
  expect(client.context().estimateSource).toBe('preview');
  expect(client.context().estimateTokens).toBe(beforePreview.estimateTokens);

  // Per-turn receipts and usage breakdown retain both model-a and model-b in the same session.
  const record = client.getSession(originalSessionId)!;
  expect(record.turns?.map(t => t.modelId)).toEqual([
    'model-a',
    'model-a',
    'model-a',
    'model-a',
    'model-b',
    'model-b',
    'model-b',
  ]);
  const usage = client.usage();
  expect(usage.byModel.map(entry => entry.modelId).sort()).toEqual(['model-a', 'model-b']);

  // A post-resume turn must send the compacted handoff summary and recent turns to model-b, not bulk history.
  await drain(client, 'after-reopen');
  const lastWire = mock.wire.at(-1)!.body;
  expect(lastWire.model).toBe('model-b');
  expect(lastWire.messages.some(m => String(m.content).startsWith(SUMMARY_PREFIX))).toBe(true);
  expect(lastWire.messages.some(m => String(m.content).includes('BULK(model-a)'))).toBe(false);
  expect(lastWire.messages.slice(-7).map(m => m.content)).toEqual([
    'after-compact-0',
    'reply(model-b):after-compact-0',
    'after-compact-1',
    'reply(model-b):after-compact-1',
    'after-compact-2',
    'reply(model-b):after-compact-2',
    'after-reopen',
  ]);
});

test('switching account with continueHistory=true preserves an empty session ID too, while logout still clears currentSession', async () => {
  const home = makeTempDir('cosmew-switch-empty-');
  const ws = join(home, 'ws');
  mkdirSync(ws);
  const mock = makeMultiModelServices({'provider.example.test': ['model-a', 'model-b']});
  const app = startup(home, mock.services);
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add({
    id: 'provider',
    name: 'Provider',
    baseURL: 'https://provider.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
  });
  const accountA = await app.accounts.add('provider', 'acct-a', {kind: 'none'});
  const accountB = await app.accounts.add('provider', 'acct-b', {kind: 'none'});
  const client = app.createFutrynClient(ws);
  await client.discoverModels({accountId: accountA.id});
  client.selectModel('model-a', {accountId: accountA.id});

  const created = client.createSession();
  await client.switchAccount(accountB.id, true, 'model-b');
  expect(client.activeSession()?.id).toBe(created.id);
  expect(client.activeSession()?.selection).toEqual({accountId: accountB.id, modelId: 'model-b'});

  // Logging out the active account must clear the active session and never transfer to accountA.
  await client.logoutAccount(accountB.id);
  expect(client.activeSession()).toBeNull();
});

test('security invariants: cross-workspace updateSelection, active turn guard, rollback on error, and explicit fork compaction preservation', async () => {
  const home = makeTempDir('cosmew-switch-security-');
  const wsA = join(home, 'ws-a');
  const wsB = join(home, 'ws-b');
  mkdirSync(wsA);
  mkdirSync(wsB);

  // 1. SQLite store updateSelection guards: NOT_FOUND and active turn POLICY.
  const db = openPrivateDatabase(join(home, 'store-only'));
  cleanups.push(() => db.close());
  const store = new SqliteConversations(db);
  const selA = {accountId: crypto.randomUUID(), modelId: 'model-a'};
  const selB = {accountId: selA.accountId, modelId: 'model-b'};
  expect(() => store.updateSelection(crypto.randomUUID(), selB)).toThrow(FutrynError);
  const id = store.create(selA);
  store.beginExecution(
    id,
    {role: 'user', content: 'in-flight'},
    {
      requestId: crypto.randomUUID(),
      ...selA,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: 'pending',
      usage: null,
      context: null,
    },
  );
  expect(() => store.updateSelection(id, selB)).toThrow(expect.objectContaining({code: 'POLICY'}));

  // 2. Rollback when ports.selectModel fails during default-scope in-place switch.
  const m2 = {...fixtureModel, id: 'model-b'};
  let persistedSelection = {...fixtureSelection};
  const updates: string[] = [];
  const f = dialogFixture({
    cachedModels: () => [fixtureModel, m2],
    startSession: () => ({id: 'sess-1', selection: persistedSelection, messages: [{role: 'user', content: 'hi'}]}),
    setSessionSelection: (sid, next) => {
      updates.push(`${sid}:${next.modelId}`);
      persistedSelection = {...next};
      return {id: sid, selection: {...next}, messages: [{role: 'user', content: 'hi'}]};
    },
    selectModel: () => {
      throw new FutrynError('STORAGE');
    },
  });
  f.client.createSession();
  expect(() => f.client.selectModel('model-b')).toThrow(expect.objectContaining({code: 'STORAGE'}));
  expect(updates).toEqual(['sess-1:model-b', 'sess-1:sample-model']);
  expect(persistedSelection).toEqual(fixtureSelection);
  expect(f.client.activeSession()?.id).toBe('sess-1');
  expect(f.client.activeSession()?.selection).toEqual(fixtureSelection);

  // 3. Cross-workspace isolation & explicit /fork compaction preservation.
  const mock = makeMultiModelServices({'provider.example.test': ['model-a', 'model-b']});
  const app = startup(home, mock.services);
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add({
    id: 'provider',
    name: 'Provider',
    baseURL: 'https://provider.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
  });
  await app.accounts.add('provider', 'acct', {kind: 'none'});
  const clientA = app.createFutrynClient(wsA);
  const clientB = app.createFutrynClient(wsB);
  await clientA.discoverModels();
  clientA.selectModel('model-a');
  clientA.updateUserPreferences({autoCompact: false});
  for (let i = 0; i < 4; i++) await drain(clientA, `bulk-${i}`);
  const sidA = clientA.activeSession()!.id;
  expect(await clientA.compact()).toMatchObject({compacted: true, strategy: 'model'});
  const sourceCompaction = app.conversations.recover(sidA).compaction!;

  // Cross-workspace client cannot resume or mutate wsA's session.
  expect(() => clientB.resumeSession(sidA)).toThrow(expect.objectContaining({code: 'POLICY'}));

  // Explicit /fork creates a new session ID and preserves the verified compaction snapshot.
  const forked = clientA.forkSession(sidA);
  expect(forked.id).not.toBe(sidA);
  expect(app.conversations.recover(forked.id).compaction).toEqual(sourceCompaction);
  expect(clientA.context().estimateSource).toBe('preview');

  // Target validation before SQLite mutation: logged-out account -> AUTH, unknown model -> NOT_FOUND.
  const loggedOut = await app.accounts.add('provider', 'logged-out-acct', {kind: 'none'});
  await app.accounts.logout(loggedOut.id, false);
  expect(() => clientA.selectModel('model-a', {accountId: loggedOut.id})).toThrow(
    expect.objectContaining({code: 'AUTH'}),
  );
  expect(() => clientA.selectModel('does-not-exist')).toThrow(expect.objectContaining({code: 'NOT_FOUND'}));
  expect(app.conversations.get(forked.id)?.selection.modelId).toBe('model-a');

  // Redaction mismatch on fork omits stale compaction snapshot instead of corrupting the fork.
  const redactionDb = openPrivateDatabase(join(home, 'fork-redact-mismatch'));
  cleanups.push(() => redactionDb.close());
  const rawStore = new SqliteConversations(redactionDb);
  const srcId = rawStore.create(selA);
  rawStore.append(srcId, {role: 'user', content: 'contains secret-token'}, 'committed');
  rawStore.append(srcId, {role: 'assistant', content: 'ok'}, 'committed');
  const srcMsgs = rawStore.recover(srcId).messages;
  rawStore.saveContextSnapshot(srcId, {
    version: 1,
    throughRevision: srcMsgs.length,
    sourceHash: createHash('sha256').update(JSON.stringify(srcMsgs)).digest('hex'),
    createdAt: new Date().toISOString(),
    strategy: 'model',
    summary: 'summary',
    retainedUserRequests: ['contains secret-token'],
  });
  const redactingStore = new SqliteConversations(redactionDb, v => v.replaceAll('secret-token', '[REDACTED]'));
  const redactedFork = redactingStore.fork(srcId, selB);
  expect(redactingStore.recover(redactedFork.id).compaction).toBeUndefined();

  // Active turn in client blocks selectModel and switchAccount with POLICY.
  let releaseTurn!: () => void;
  const hold = new Promise<void>(resolve => {
    releaseTurn = resolve;
  });
  const blocked = dialogFixture({
    cachedModels: () => [fixtureModel, m2],
    startSession: () => ({id: 'live-sess', selection: fixtureSelection, messages: []}),
    setSessionSelection: (sid, next) => ({id: sid, selection: next, messages: []}),
    async *sendTurn() {
      yield {type: 'started', requestId: crypto.randomUUID()};
      await hold;
      yield {type: 'textDelta', text: 'done'};
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 1, costUSD: null}};
    },
  });
  const iter = blocked.client.sendMessage('running')[Symbol.asyncIterator]();
  await iter.next();
  expect(() => blocked.client.selectModel('model-b')).toThrow(expect.objectContaining({code: 'POLICY'}));
  expect(() => blocked.client.selectModel('model-b', {scope: 'session'})).toThrow(
    expect.objectContaining({code: 'POLICY'}),
  );
  await expect(blocked.client.switchAccount(fixtureAccount.id, true, 'model-b')).rejects.toMatchObject({
    code: 'POLICY',
  });
  releaseTurn();
  while (!(await iter.next()).done) {
    /* finish turn */
  }
});

test('TUI transcript restores per-turn item.model from SessionRecord and prefers item.model over current session model', async () => {
  const turn1Id = crypto.randomUUID();
  const shellId = crypto.randomUUID();
  const turn2Id = crypto.randomUUID();
  const steerId = crypto.randomUUID();
  const messages: Message[] = [
    {role: 'user', content: 'Question 1'},
    {role: 'assistant', content: 'Answer from A'},
    {role: 'user', content: '!echo hi'},
    {role: 'assistant', content: '', toolCalls: [{id: 'sh-1', name: 'exec_command', input: {cmd: 'echo hi'}}]},
    {role: 'tool', toolCallId: 'sh-1', toolName: 'exec_command', content: 'hi'},
    {role: 'user', content: 'Question 2'},
    {role: 'assistant', content: 'Initial B'},
    {role: 'user', content: 'Steer B'},
    {role: 'assistant', content: 'Final B'},
  ];
  const record: SessionRecord = {
    id: 'session-multi',
    title: 'Multi-model',
    selection: {accountId: fixtureAccount.id, modelId: 'model-b'},
    revision: 9,
    messageCount: messages.length,
    lastState: 'committed',
    preview: 'Final B',
    messages: messages.map((m, i) => ({...m, revision: i + 1, state: 'committed'})),
    turns: [
      {
        requestId: turn1Id,
        accountId: fixtureAccount.id,
        modelId: 'model-a',
        startedAt: '2026-11-22T00:00:00.000Z',
        finishedAt: '2026-11-22T00:00:01.000Z',
        outcome: 'completed',
        usage: null,
        context: null,
      },
      {
        requestId: shellId,
        accountId: fixtureAccount.id,
        modelId: 'model-a',
        kind: 'user-shell',
        startedAt: '2026-11-22T00:00:02.000Z',
        finishedAt: '2026-11-22T00:00:03.000Z',
        outcome: 'completed',
        usage: null,
        context: null,
      },
      {
        requestId: turn2Id,
        accountId: fixtureAccount.id,
        modelId: 'model-b',
        startedAt: '2026-11-22T00:00:04.000Z',
        finishedAt: '2026-11-22T00:00:06.000Z',
        outcome: 'completed',
        usage: null,
        context: null,
      },
    ],
    recovery: {
      messages,
      turns: [
        {
          id: turn1Id,
          userRevision: 1,
          state: 'completed',
          events: [
            {
              seq: 1,
              turnId: turn1Id,
              at: '2026-11-22T00:00:00.000Z',
              data: {type: 'user.accepted', message: {role: 'user', content: 'Question 1'}},
            },
            {
              seq: 2,
              turnId: turn1Id,
              at: '2026-11-22T00:00:00.100Z',
              data: {type: 'model.requested', stepId: crypto.randomUUID()},
            },
            {
              seq: 3,
              turnId: turn1Id,
              at: '2026-11-22T00:00:00.500Z',
              data: {type: 'assistant.text', text: 'Answer from A'},
            },
            {
              seq: 4,
              turnId: turn1Id,
              at: '2026-11-22T00:00:01.000Z',
              data: {type: 'turn.finished', state: 'completed'},
            },
          ],
        },
        {
          id: shellId,
          userRevision: 3,
          state: 'completed',
          events: [
            {
              seq: 5,
              turnId: shellId,
              at: '2026-11-22T00:00:02.000Z',
              data: {type: 'user.accepted', message: {role: 'user', content: '!echo hi'}},
            },
            {
              seq: 6,
              turnId: shellId,
              at: '2026-11-22T00:00:03.000Z',
              data: {type: 'turn.finished', state: 'completed'},
            },
          ],
        },
        {
          id: turn2Id,
          userRevision: 6,
          state: 'completed',
          events: [
            {
              seq: 7,
              turnId: turn2Id,
              at: '2026-11-22T00:00:04.000Z',
              data: {type: 'user.accepted', message: {role: 'user', content: 'Question 2'}},
            },
            {
              seq: 8,
              turnId: turn2Id,
              at: '2026-11-22T00:00:04.100Z',
              data: {type: 'model.requested', stepId: crypto.randomUUID()},
            },
            {
              seq: 9,
              turnId: turn2Id,
              at: '2026-11-22T00:00:04.200Z',
              data: {type: 'assistant.text', text: 'Initial B'},
            },
            {
              seq: 10,
              turnId: turn2Id,
              at: '2026-11-22T00:00:04.300Z',
              data: {type: 'user.steered', steerId, message: {role: 'user', content: 'Steer B'}},
            },
            {
              seq: 11,
              turnId: turn2Id,
              at: '2026-11-22T00:00:05.000Z',
              data: {type: 'model.requested', stepId: crypto.randomUUID()},
            },
            {seq: 12, turnId: turn2Id, at: '2026-11-22T00:00:05.500Z', data: {type: 'assistant.text', text: 'Final B'}},
            {
              seq: 13,
              turnId: turn2Id,
              at: '2026-11-22T00:00:06.000Z',
              data: {type: 'turn.finished', state: 'completed'},
            },
          ],
        },
      ],
    },
  };

  const items = messagesToTranscript(messages, record.id, record);
  const assistants = items.filter(item => item.role === 'assistant');
  expect(assistants.map(item => [item.content, item.model])).toEqual([
    ['Answer from A', 'model-a'],
    ['', undefined],
    ['Initial B', 'model-b'],
    ['Final B', 'model-b'],
  ]);
});

test('cross-provider in-place switch never leaks providerReplay signatures from model A into model B requests', async () => {
  const home = makeTempDir('cosmew-switch-replay-');
  const ws = join(home, 'ws');
  mkdirSync(ws);
  const mock = makeMultiModelServices({
    'provider-a.example.test': ['model-a'],
    'provider-b.example.test': ['model-b'],
  });
  const app = startup(home, mock.services);
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add({
    id: 'provider-a',
    name: 'Provider A',
    baseURL: 'https://provider-a.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
    replayReasoning: true,
  });
  app.registry.add({
    id: 'provider-b',
    name: 'Provider B',
    baseURL: 'https://provider-b.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
    replayReasoning: true,
  });
  const accountA = await app.accounts.add('provider-a', 'acct-a', {kind: 'none'});
  const accountB = await app.accounts.add('provider-b', 'acct-b', {kind: 'none'});
  const client = app.createFutrynClient(ws);
  await client.discoverModels({accountId: accountA.id});
  client.selectModel('model-a', {accountId: accountA.id});

  const sessionId = app.conversations.create({accountId: accountA.id, modelId: 'model-a'});
  app.conversations.bindWorkspace(sessionId, realpathSync(ws));
  app.conversations.append(sessionId, {role: 'user', content: 'Turn A'}, 'committed');
  app.conversations.append(
    sessionId,
    {
      role: 'assistant',
      content: 'Reply A',
      providerReplay: {
        version: 1,
        providerId: 'provider-a',
        accountId: accountA.id,
        protocol: 'chat',
        modelId: 'model-a',
        endpointHash: createHash('sha256').update('https://provider-a.example.test/v1').digest('hex'),
        parts: [
          {type: 'reasoning', text: 'PRIVATE-REASONING-ONLY-FOR-A'},
          {type: 'text', text: 'Reply A'},
        ],
      },
    },
    'committed',
  );
  client.resumeSession(sessionId);
  await client.switchAccount(accountB.id, true, 'model-b');
  expect(client.activeSession()?.id).toBe(sessionId);
  await drain(client, 'Turn B');
  const wireToB = JSON.stringify(mock.wire.at(-1)!.body);
  expect(wireToB).not.toContain('PRIVATE-REASONING-ONLY-FOR-A');
  expect(wireToB).toContain('Reply A');
});
