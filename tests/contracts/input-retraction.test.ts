import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import type {TurnReceipt} from '@cosmew/contracts';

function fixture(run: (s: SqliteConversations, id: string, receipt: TurnReceipt) => void) {
  const root = mkdtempSync(join(tmpdir(), 'retract-'));
  const db = openPrivateDatabase(root);
  try {
    const s = new SqliteConversations(db, v => v.replaceAll('secret-value', '[redacted]'));
    const accountId = crypto.randomUUID();
    const id = s.create({accountId, modelId: 'fixture'});
    run(s, id, {
      requestId: crypto.randomUUID(),
      accountId,
      modelId: 'fixture',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: 'pending',
      usage: null,
      context: null,
    });
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
}

test('retraction wins before acceptance; stale queue claims fail without delivering text', () =>
  fixture((s, id, r) => {
    const input = s.enqueueNextTurn(id, 'secret-value');
    expect(s.retractQueuedInput(id).map(p => p.content)).toEqual(['[redacted]']);
    expect(s.listNextTurn(id)).toEqual([]);
    expect(() => s.beginExecution(id, {role: 'user', content: input.content}, r, [], input.id)).toThrow();
    expect(s.retractQueuedInput(id)).toEqual([]);
  }));

test('acceptance wins; delivered queued input cannot be retracted', () =>
  fixture((s, id, r) => {
    const input = s.enqueueNextTurn(id, 'delivered');
    s.beginExecution(id, {role: 'user', content: input.content}, r, [], input.id);
    expect(s.retractQueuedInput(id, [{steerId: input.id, content: input.content}])).toEqual([]);
    expect(s.recover(id).messages[0]?.content).toBe('delivered');
  }));

test('live steering retraction survives recovery and never enters a later request', () =>
  fixture((s, id, r) => {
    s.beginExecution(id, {role: 'user', content: 'original'}, r);
    const first = crypto.randomUUID();
    s.recordExecution(id, r.requestId, {type: 'model.requested', stepId: first});
    const steerId = crypto.randomUUID();
    s.recordExecution(id, r.requestId, {
      type: 'user.steered',
      steerId,
      message: {role: 'user', content: 'secret-value'},
    });
    expect(s.retractQueuedInput(id, [{steerId, content: 'secret-value'}])[0]?.content).toBe('[redacted]');
    s.recordExecution(id, r.requestId, {type: 'model.requested', stepId: crypto.randomUUID()});
    expect(s.recover(id).messages.map(m => m.content)).toEqual(['original']);
    expect(s.recover(id).turns[0]!.events.some(e => e.data.type === 'user.steered')).toBe(true);
  }));

test('delivered steering is protected even with a stale live snapshot', () =>
  fixture((s, id, r) => {
    s.beginExecution(id, {role: 'user', content: 'original'}, r);
    s.recordExecution(id, r.requestId, {type: 'model.requested', stepId: crypto.randomUUID()});
    const steerId = crypto.randomUUID();
    s.recordExecution(id, r.requestId, {type: 'user.steered', steerId, message: {role: 'user', content: 'delivered'}});
    s.recordExecution(id, r.requestId, {type: 'model.requested', stepId: crypto.randomUUID()});
    expect(s.retractQueuedInput(id, [{steerId, content: 'delivered'}])).toEqual([]);
    expect(s.recover(id).messages.map(m => m.content)).toContain('delivered');
  }));

test('schema v9 retraction receipts survive reopening without rewriting the journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'retract-reopen-'));
  let db = openPrivateDatabase(root);
  try {
    let s = new SqliteConversations(db);
    const id = s.create({accountId: crypto.randomUUID(), modelId: 'fixture'});
    s.enqueueNextTurn(id, 'first');
    expect(s.retractQueuedInput(id).map(p => p.content)).toEqual(['first']);
    db.close();
    db = openPrivateDatabase(root);
    s = new SqliteConversations(db);
    expect(s.listNextTurn(id)).toEqual([]);
    expect(db.query('SELECT id FROM input_retractions WHERE conversation=?').all(id)).toHaveLength(1);
    expect((db.query('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(11);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('failed durable retraction leaves the inbox intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'retract-fail-'));
  const db = openPrivateDatabase(root);
  try {
    const s = new SqliteConversations(db);
    const id = s.create({accountId: crypto.randomUUID(), modelId: 'fixture'});
    const input = s.enqueueNextTurn(id, 'keep');
    db.exec(
      "CREATE TRIGGER reject_retraction BEFORE INSERT ON input_retractions BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    expect(() => s.retractQueuedInput(id)).toThrow();
    expect(s.listNextTurn(id)).toEqual([input]);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('send-now atomically moves pending steering to next-turn inbox without duplicate recovery', () =>
  fixture((s, id, r) => {
    const revision = s.beginExecution(id, {role: 'user', content: 'original'}, r);
    s.recordExecution(id, r.requestId, {type: 'model.requested', stepId: crypto.randomUUID()});
    const steerId = crypto.randomUUID();
    s.recordExecution(id, r.requestId, {type: 'user.steered', steerId, message: {role: 'user', content: 'next'}});
    s.moveQueuedInputToInbox(id, [{steerId, content: 'next'}]);
    s.interrupt(id, revision, {...r, outcome: 'interrupted', finishedAt: new Date().toISOString()});
    expect(s.recover(id).pendingInput ?? []).toEqual([]);
    expect(s.listNextTurn(id).map(p => p.content)).toEqual(['next']);
    const next = s.listNextTurn(id)[0]!;
    const r2 = {...r, requestId: crypto.randomUUID()};
    s.beginExecution(id, {role: 'user', content: next.content}, r2, [], next.id);
    expect(s.recover(id).messages.filter(m => m.content === 'next')).toHaveLength(1);
  }));

test('Conversation exposes live steering and retracts it synchronously before delivery', async () => {
  const {Conversation} = await import('@cosmew/core');
  const root = mkdtempSync(join(tmpdir(), 'retract-core-'));
  const db = openPrivateDatabase(root);
  try {
    const store = new SqliteConversations(db);
    const conv = new Conversation(
      {accountId: crypto.randomUUID(), modelId: 'fixture'},
      {
        generate: async () => {
          throw new Error('unused');
        },
        async *stream() {
          yield {type: 'started' as const, requestId: crypto.randomUUID()};
          yield {
            type: 'completed' as const,
            finishReason: 'stop',
            usage: {inputTokens: null, outputTokens: null, costUSD: null},
          };
        },
      },
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      {modelCompaction: false},
    );
    const it = conv.send('original')[Symbol.asyncIterator]();
    await it.next();
    expect(conv.steer('edit queued text').accepted).toBe(true);
    expect(conv.queuedInput().map(p => p.content)).toEqual(['edit queued text']);
    expect(conv.retractQueuedInput()).toBe('edit queued text');
    expect(conv.queuedInput()).toEqual([]);
    await it.return?.();
    expect(store.recover(conv.id).pendingInput ?? []).toEqual([]);
    expect(store.recover(conv.id).messages.some(m => m.content === 'edit queued text')).toBe(false);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('selective text retraction preserves shell FIFO and a stale text claim cannot deliver', () =>
  fixture((s, id, r) => {
    const shell = s.enqueueNextTurn(id, '!echo shell');
    const text = s.enqueueNextTurn(id, 'secret-value');
    expect(s.retractQueuedInput(id, [], {includeShell: false}).map(p => p.content)).toEqual(['[redacted]']);
    expect(s.listNextTurn(id)).toEqual([shell]);
    expect(() => s.beginExecution(id, {role: 'user', content: text.content}, r, [], text.id)).toThrow();
    expect(s.retractQueuedInput(id, [], {includeShell: true, shellOnlyWhenAlone: true}).map(p => p.content)).toEqual([
      '!echo shell',
    ]);
    expect(s.listNextTurn(id)).toEqual([]);
  }));

test('mixed queue checks shell eligibility atomically; delivery wins against selective retraction', () =>
  fixture((s, id, r) => {
    const shell = s.enqueueNextTurn(id, '!echo keep');
    s.enqueueNextTurn(id, 'text');
    expect(s.retractQueuedInput(id, [], {includeShell: true, shellOnlyWhenAlone: true}).map(p => p.content)).toEqual([
      'text',
    ]);
    s.beginExecution(id, {role: 'user', content: shell.content}, r, [], shell.id);
    expect(s.retractQueuedInput(id, [{steerId: shell.id, content: shell.content}], {includeShell: true})).toEqual([]);
    expect(s.recover(id).messages[0]?.content).toBe('!echo keep');
  }));

test('a stale live snapshot cannot retract the same text twice', () =>
  fixture((s, id, r) => {
    s.beginExecution(id, {role: 'user', content: 'original'}, r);
    s.recordExecution(id, r.requestId, {type: 'model.requested', stepId: crypto.randomUUID()});
    const steerId = crypto.randomUUID();
    s.recordExecution(id, r.requestId, {type: 'user.steered', steerId, message: {role: 'user', content: 'text'}});
    const stale = [{steerId, content: 'text'}];
    expect(s.retractQueuedInput(id, stale, {includeShell: false})).toHaveLength(1);
    expect(s.retractQueuedInput(id, stale, {includeShell: false})).toEqual([]);
  }));

test('SDK delivery reservation wins selective and legacy retraction while unclaimed tail stays retractable', async () => {
  const {dialogFixture, selection} = await import('../../apps/tui/src/ink/features/picker/test-fixture');
  const root = mkdtempSync(join(tmpdir(), 'retract-sdk-reserved-'));
  const db = openPrivateDatabase(root);
  try {
    const store = new SqliteConversations(db);
    const id = store.create(selection);
    const head = store.enqueueNextTurn(id, 'reserved delivery');
    const tail = store.enqueueNextTurn(id, 'reclaim this tail');
    let deliveredId: string | undefined;
    const fixture = dialogFixture({
      startSession: () => ({id, selection, messages: []}),
      listNextTurn: session => store.listNextTurn(session),
      retractQueuedEntries: (session, options) =>
        store
          .retractQueuedInput(session, [], options)
          .map(p => ({id: p.steerId, type: 'text' as const, content: p.content})),
      async *sendTurn(session, content, _signal, _max, _cost, _effort, queuedId) {
        deliveredId = queuedId;
        store.beginExecution(
          session,
          {role: 'user', content},
          {
            requestId: crypto.randomUUID(),
            ...selection,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            outcome: 'pending',
            usage: null,
            context: null,
          },
          [],
          queuedId,
        );
        yield {type: 'textDelta', text: 'accepted'};
      },
    });
    fixture.client.createSession();
    const held = fixture.client.takeQueuedMessage()!;
    // An external caller cannot spoof the SDK's reservation exclusion.
    expect(fixture.client.retractQueuedEntries({includeShell: false, ...({claimedIds: []} as object)})).toEqual([
      {id: tail.id, type: 'text', content: tail.content},
    ]);
    expect(fixture.client.retractQueuedInput()).toBe('');
    expect(store.listNextTurn(id)).toEqual([head]);
    for await (const _event of fixture.client.sendMessage(held)) {
      /* consume */
    }
    expect(deliveredId).toBe(head.id);
    expect(store.listNextTurn(id)).toEqual([]);
    expect(store.recover(id).messages.filter(m => m.content === held)).toHaveLength(1);
    expect(store.recover(id).messages.some(m => m.content === tail.content)).toBe(false);
    expect(() =>
      store.beginExecution(
        id,
        {role: 'user', content: tail.content},
        {
          requestId: crypto.randomUUID(),
          ...selection,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          outcome: 'pending',
          usage: null,
          context: null,
        },
        [],
        tail.id,
      ),
    ).toThrow();
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('claimed exclusion does not change shell-only eligibility and legacy backends refuse reserved retraction', async () => {
  fixture((store, id) => {
    const head = store.enqueueNextTurn(id, 'claimed');
    const shell = store.enqueueNextTurn(id, '!echo keep');
    expect(
      store.retractQueuedInput(id, [], {claimedIds: [head.id], includeShell: true, shellOnlyWhenAlone: true}),
    ).toEqual([]);
    expect(store.listNextTurn(id)).toEqual([head, shell]);
  });
  const {dialogFixture, selection} = await import('../../apps/tui/src/ink/features/picker/test-fixture');
  let legacyCalled = false;
  const f = dialogFixture({
    startSession: () => ({id: 'reserved', selection, messages: []}),
    listNextTurn: () => [{id: 'head', content: 'held'}],
    retractQueuedEntries: undefined,
    retractQueuedInput: () => {
      legacyCalled = true;
      return 'held';
    },
  });
  f.client.createSession();
  expect(f.client.takeQueuedMessage()).toBe('held');
  expect(() => f.client.retractQueuedInput()).toThrow();
  expect(legacyCalled).toBe(false);
});
