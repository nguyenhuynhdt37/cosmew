import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attributeUsage, combineUsage, type ModelPort} from '@cosmew/contracts';
import {Conversation} from '@cosmew/core';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {
  inheritChildLimits,
  reserveForChildren,
  parentCapsExceeded,
  NO_RESERVATION,
  defaultAgentsConfig,
} from '@cosmew/agents';
import {summarizeUsage} from '../../packages/sdk/src/telemetry';

const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
const billed = attributeUsage(
  {inputTokens: 1000, outputTokens: 100, costUSD: 0.123},
  {
    providerId: 'fixture',
    accountId: selection.accountId,
    modelId: 'actual-summary',
  },
);

test('receiptless fork summary billing survives reopen without inventing turns or copying source charges', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-standalone-usage-'));
  let db = openPrivateDatabase(root);
  try {
    let store = new SqliteConversations(db);
    const source = store.create(selection);
    store.appendContext(source, {role: 'user', content: 'copied history'});
    store.addUsage(source, attributeUsage(billed, {sessionId: source}));
    const fork = store.fork(source, selection).id;
    expect(store.get(fork)?.additionalUsage).toBeUndefined();
    for (let i = 0; i < 2; i++) store.addUsage(fork, attributeUsage(billed, {sessionId: fork}));
    db.close();
    db = openPrivateDatabase(root);
    store = new SqliteConversations(db);
    const saved = store.get(fork)!;
    expect(saved.turns).toEqual([]);
    expect(saved.messages).toHaveLength(1);
    expect(saved.additionalUsage).toMatchObject({inputTokens: 2000, outputTokens: 200, costUSD: 0.246});
    expect(saved.additionalUsage?.breakdown?.[0]).toMatchObject({sessionId: fork, modelId: 'actual-summary'});
    const summary = summarizeUsage(saved.turns!, 1, saved.additionalUsage);
    expect(summary).toMatchObject({turns: 0, historicalTurns: 1, inputTokens: 2000, reportedCostUSD: 0.246});
    expect(summary.byProvider).toMatchObject([{providerId: 'fixture', turns: 0, inputTokens: 2000}]);
    expect(store.get(source)!.additionalUsage?.inputTokens).toBe(1000);
    expect(store.delete(fork)).toBe(true);
    expect(db.query('SELECT count(*) AS n FROM session_usage WHERE conversation=?').get(fork)).toEqual({n: 0});
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test.each(['usage', 'completed'] as const)(
  'already-yielded %s billing is durable when cancellation races delivery',
  async type => {
    const root = mkdtempSync(join(tmpdir(), 'cosmew-cancel-billing-'));
    const db = openPrivateDatabase(root);
    try {
      const controller = new AbortController();
      const store = new SqliteConversations(db);
      const model: ModelPort = {
        generate: async () => {
          throw new Error('stream only');
        },
        async *stream() {
          controller.abort();
          if (type === 'usage') yield {type: 'usage', usage: billed};
          else yield {type: 'completed', usage: billed, finishReason: 'stop'};
        },
      };
      const conversation = new Conversation(selection, model, store);
      await expect(
        (async () => {
          for await (const _e of conversation.send('cancel race', controller.signal)) {
          }
        })(),
      ).rejects.toBeDefined();
      const receipt = store.get(conversation.id)!.turns![0]!;
      expect(receipt.outcome).toBe('cancelled');
      expect(receipt.usage).toMatchObject({inputTokens: 1000, costUSD: 0.123});
      expect(receipt.usage?.breakdown?.[0]?.sessionId).toBe(conversation.id);
    } finally {
      db.close();
      rmSync(root, {recursive: true, force: true});
    }
  },
);

test('mixed known and unknown costs enforce child reservations, inherited caps and sibling shutdown', () => {
  const mixed = combineUsage(billed, {inputTokens: 1, outputTokens: 1, costUSD: null});
  expect(mixed.costUSD).toBeNull();
  expect(reserveForChildren([{usage: mixed}])).toMatchObject({budgetCostUSD: 0.123, capCostUSD: 0.123});
  for (const cap of [{budget: {maxCostUSD: 0.1}}, {budget: {}, maxEstimatedCostUSD: 0.1}]) {
    const parent = {...cap, elapsedMs: 0, usage: mixed};
    expect(parentCapsExceeded(parent)).toBe(true);
    expect(inheritChildLimits(parent, NO_RESERVATION, defaultAgentsConfig()).ok).toBe(false);
  }
  const remaining = inheritChildLimits(
    {budget: {maxCostUSD: 1}, maxEstimatedCostUSD: 1, elapsedMs: 0, usage: mixed},
    NO_RESERVATION,
    defaultAgentsConfig(),
  );
  expect(remaining).toMatchObject({ok: true, limits: {budget: {maxCostUSD: 0.877}, maxEstimatedCostUSD: 0.877}});
});

test('shell-only and appendContext sessions retain additional usage independently of later agent turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-shell-billing-'));
  const db = openPrivateDatabase(root);
  try {
    const store = new SqliteConversations(db);
    const id = store.create(selection);
    store.append(id, {role: 'user', content: '!pwd'}, 'committed', {
      kind: 'user-shell',
      requestId: crypto.randomUUID(),
      ...selection,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: 'completed',
      usage: null,
      context: null,
    });
    store.addUsage(id, attributeUsage(billed, {sessionId: id}));
    const before = store.get(id)!;
    expect(before.turns).toHaveLength(1);
    expect(before.turns![0]!.usage).toBeNull();
    expect(before.additionalUsage?.inputTokens).toBe(1000);
    const child = attributeUsage(
      {inputTokens: 5, outputTokens: 1, costUSD: 0.01},
      {
        ...selection,
        providerId: 'child',
        agentId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
      },
    );
    const model: ModelPort = {
      generate: async () => {
        throw new Error('stream only');
      },
      async *stream() {
        yield {type: 'textDelta', text: 'done'};
        yield {type: 'completed', finishReason: 'stop', usage: child};
      },
    };
    const conversation = new Conversation(selection, model, store, {id, messages: before.recovery!.messages});
    for await (const _e of conversation.send('agent turn')) {
    }
    const saved = store.get(id)!;
    const summary = summarizeUsage(saved.turns!, 0, saved.additionalUsage);
    expect(saved.turns).toHaveLength(2);
    expect(summary).toMatchObject({turns: 1, inputTokens: 1005, outputTokens: 101, reportedCostUSD: 0.133});
    expect(summary.byProvider.find(p => p.providerId === 'child')).toMatchObject({inputTokens: 5, turns: 1});
    expect(summary.byProvider.find(p => p.providerId === 'fixture')).toMatchObject({inputTokens: 1000, turns: 0});
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('schema 11 migrates billing additively and future schemas fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-billing-migration-'));
  let db = openPrivateDatabase(root);
  try {
    const store = new SqliteConversations(db);
    const id = store.create(selection);
    store.appendContext(id, {role: 'user', content: 'legacy context'});
    db.exec('DROP TABLE session_usage; PRAGMA user_version=11;');
    db.close();
    db = openPrivateDatabase(root);
    expect(db.query('PRAGMA user_version').get()).toEqual({user_version: 13});
    const migrated = new SqliteConversations(db);
    expect(migrated.get(id)?.messages[0]?.content).toBe('legacy context');
    expect(migrated.get(id)?.additionalUsage).toBeUndefined();
    migrated.addUsage(id, billed);
    expect(migrated.get(id)?.additionalUsage?.inputTokens).toBe(1000);
    db.exec('PRAGMA user_version=14;');
    expect(() => openPrivateDatabase(root)).toThrow();
    expect(db.query('PRAGMA user_version').get()).toEqual({user_version: 14});
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
