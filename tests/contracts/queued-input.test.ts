import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateDatabase, SqliteConversations} from '@futryn/persistence';
import type {TurnReceipt} from '@futryn/contracts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const receipt = (): TurnReceipt => ({
  requestId: crypto.randomUUID(),
  accountId: crypto.randomUUID(),
  modelId: 'fixture',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  outcome: 'pending',
  usage: null,
  context: null,
});

test('durable input is session bound and acknowledged atomically with its accepted turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'futryn-queued-input-'));
  const db = openPrivateDatabase(root);
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  cleanup.push(() => db.close());
  const store = new SqliteConversations(db, value => value.replaceAll('secret-token', '[redacted]'));
  const session = store.create({accountId: crypto.randomUUID(), modelId: 'fixture'});
  const other = store.create({accountId: crypto.randomUUID(), modelId: 'fixture'});
  const input = store.enqueueNextTurn(session, 'inspect secret-token');
  expect(store.listNextTurn(session)).toEqual([{id: input.id, content: 'inspect [redacted]'}]);
  expect(() => store.beginExecution(other, {role: 'user', content: input.content}, receipt(), [], input.id)).toThrow();
  expect(() => store.beginExecution(session, {role: 'user', content: 'different'}, receipt(), [], input.id)).toThrow();
  expect(store.listNextTurn(session)).toHaveLength(1);
  const accepted = receipt();
  store.beginExecution(session, {role: 'user', content: input.content}, accepted, [], input.id);
  expect(store.listNextTurn(session)).toEqual([]);
  expect(store.recover(session).messages.some(message => message.content === input.content)).toBe(true);
  // A repeated ID cannot create another accepted message, including after the original turn ended.
  expect(() =>
    store.beginExecution(session, {role: 'user', content: input.content}, receipt(), [], input.id),
  ).toThrow();
  expect(store.recover(session).messages.filter(message => message.content === input.content)).toHaveLength(1);
  expect(JSON.stringify(db.query('SELECT content FROM next_turn_input').all())).not.toContain('secret-token');
});

test('queue survives reopening before send and accepted input never reappears after reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'futryn-queued-restart-'));
  let db = openPrivateDatabase(root);
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  cleanup.push(() => db.close());
  let store = new SqliteConversations(db);
  const session = store.create({accountId: crypto.randomUUID(), modelId: 'fixture'});
  const input = store.enqueueNextTurn(session, 'preserve across restart');
  db.close();
  db = openPrivateDatabase(root);
  store = new SqliteConversations(db);
  expect(store.listNextTurn(session)).toEqual([input]);
  store.beginExecution(session, {role: 'user', content: input.content}, receipt(), [], input.id);
  const waiting = store.enqueueNextTurn(session, 'still pending');
  // The active-turn ownership gate can reject a new send; failed acceptance must not delete its input.
  expect(() =>
    store.beginExecution(session, {role: 'user', content: waiting.content}, receipt(), [], waiting.id),
  ).toThrow();
  expect(store.listNextTurn(session)).toEqual([waiting]);
  db.close();
  db = openPrivateDatabase(root);
  store = new SqliteConversations(db);
  expect(store.listNextTurn(session)).toEqual([waiting]);
  expect(store.recover(session).messages.filter(message => message.content === input.content)).toHaveLength(1);
});
