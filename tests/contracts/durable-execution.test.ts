import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {Conversation, compactHistory, useContextSnapshot, normalizeHistory} from '@cosmew/core';
import {FutrynError, type ModelPort, type Message, type TurnReceipt} from '@cosmew/contracts';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'hannes-journal-'));
  const db = openPrivateDatabase(home);
  cleanup.push(() => {
    db.close();
    rmSync(home, {recursive: true, force: true});
  });
  return {home, db, store: new SqliteConversations(db)};
}
const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
const receipt = (): TurnReceipt => ({
  requestId: crypto.randomUUID(),
  ...selection,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  outcome: 'pending',
  usage: null,
  context: null,
});
const usage = {inputTokens: 10, outputTokens: 5, costUSD: null};

test('accepted turns, ordered events and tool intents persist before completion; live owners cannot be stolen', () => {
  const {store, db} = setup();
  const id = store.create(selection),
    r = receipt();
  const revision = store.beginExecution(id, {role: 'user', content: 'Create helo.html'}, r);
  expect(store.recover(id).turns[0]!.state).toBe('pending');
  expect(() => store.beginExecution(id, {role: 'user', content: 'racing'}, receipt())).toThrow(FutrynError);
  expect(() => store.delete(id)).toThrow(FutrynError);
  store.recordExecution(id, r.requestId, {type: 'model.requested', stepId: crypto.randomUUID()});
  store.recordExecution(id, r.requestId, {
    type: 'tool.call',
    call: {id: 'write', name: 'apply_patch', input: {patch: 'proposal'}},
  });
  store.recordExecution(id, r.requestId, {
    type: 'tool.intent',
    callId: 'write',
    executionId: crypto.randomUUID(),
    capability: 'fs.write',
  });
  store.interrupt(id, revision, {...r, outcome: 'cancelled', finishedAt: new Date().toISOString()});
  const recovered = store.recover(id);
  expect(recovered.turns[0]!.state).toBe('cancelled');
  expect(recovered.turns[0]!.events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(normalizeHistory(recovered.messages).find(m => m.toolCallId === 'write')!.content).toContain('unknown');
  expect(() => store.recordExecution(id, r.requestId, {type: 'assistant.text', text: 'late success'})).toThrow();
  expect((db.query('select count(*) as n from conversation_events').get() as {n: number}).n).toBe(5);
});

test('process exit preserves intermediate read evidence; restart marks abandoned work interrupted without invoking tools', () => {
  const home = mkdtempSync(join(tmpdir(), 'hannes-crash-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const script = `import {openPrivateDatabase,SqliteConversations} from ${JSON.stringify(resolve('packages/persistence/src/index.ts'))};
 const db=openPrivateDatabase(${JSON.stringify(home)});const store=new SqliteConversations(db);const id=store.create(${JSON.stringify(selection)});const r=${JSON.stringify(receipt())};store.beginExecution(id,{role:'user',content:'Create helo.html'},r);
 store.recordExecution(id,r.requestId,{type:'tool.call',call:{id:'read-crash',name:'read',input:{path:'README.md'}}});
 store.recordExecution(id,r.requestId,{type:'tool.intent',callId:'read-crash',executionId:crypto.randomUUID(),capability:'fs.read'});
 store.recordExecution(id,r.requestId,{type:'tool.result',result:{callId:'read-crash',name:'read',status:'ok',content:'helo.html does not exist'}});await Bun.write(Bun.stdout,id);process.exit(0);`;
  const child = Bun.spawnSync([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
  expect(child.exitCode).toBe(0);
  const id = child.stdout.toString().trim();
  const db = openPrivateDatabase(home);
  try {
    const store = new SqliteConversations(db);
    const restored = store.get(id)!;
    expect(restored.recovery!.turns[0]!.state).toBe('interrupted');
    expect(restored.recovery!.messages.some(m => m.toolCallId === 'read-crash')).toBe(true);
    expect(restored.turns![0]!.outcome).toBe('interrupted');
  } finally {
    db.close();
  }
});

test('corrupt event sequences fail explicitly and cannot become model-visible success', () => {
  const {store, db} = setup(),
    id = store.create(selection),
    r = receipt();
  store.beginExecution(id, {role: 'user', content: 'Create helo.html'}, r);
  db.query('UPDATE conversation_events SET seq=8 WHERE conversation=?').run(id);
  expect(() => store.recover(id)).toThrow(FutrynError);
});

test('compaction preserves all user constraints, exact change evidence and two recent turns without mutating source history', async () => {
  const messages: Message[] = [];
  for (let i = 0; i < 8; i++)
    messages.push(
      {role: 'user', content: `Create helo.html: constraint-${i}; preserve sales copy and no dependencies.`},
      {role: 'assistant', content: '', toolCalls: [{id: `r${i}`, name: 'read', input: {path: 'design.md'}}]},
      {role: 'tool', toolName: 'read', toolCallId: `r${i}`, content: 'design '.repeat(1800)},
      {role: 'assistant', content: 'Inspected context.'},
    );
  const original = JSON.stringify(messages),
    snapshot = await compactHistory(messages, undefined, 18000);
  expect(snapshot).toBeDefined();
  const rebuilt = useContextSnapshot(messages, snapshot);
  expect(rebuilt.length).toBeLessThan(messages.length);
  for (let i = 0; i < 8; i++) expect(JSON.stringify(rebuilt)).toContain(`constraint-${i}`);
  expect(JSON.stringify(messages)).toBe(original);
  expect(rebuilt.filter(m => m.role === 'tool')).toHaveLength(2);
  expect(() => useContextSnapshot([{role: 'user', content: 'tampered'}, ...messages.slice(1)], snapshot)).toThrow();
  expect(await compactHistory(messages, undefined, 5)).toBeUndefined();
});

test('closing a streaming iterator finalizes its turn and preserves text instead of leaving a live owner', async () => {
  const {store} = setup();
  const model: ModelPort = {
    generate: async () => {
      throw new FutrynError('UNSUPPORTED');
    },
    async *stream() {
      yield {type: 'textDelta', text: 'Planning the requested helo.html'};
      yield {type: 'completed', finishReason: 'stop', usage};
    },
  };
  const c = new Conversation(selection, model, store);
  for await (const _ of c.send('Create helo.html')) break;
  const recovered = store.recover(c.id);
  expect(recovered.turns[0]!.state).toBe('cancelled');
  expect(recovered.messages.some(m => m.content.includes('Planning'))).toBe(true);
  const next = receipt();
  expect(() => store.beginExecution(c.id, {role: 'user', content: 'tiếp'}, next)).not.toThrow();
});

test('event and legacy message persistence both redact secrets before writing SQLite', () => {
  const {db} = setup();
  const secret = 'fixture-super-private-key';
  const store = new SqliteConversations(db, text => text.replaceAll(secret, '[REDACTED]'));
  const id = store.create(selection),
    r = receipt();
  const revision = store.beginExecution(id, {role: 'user', content: `Use ${secret}`}, r);
  store.recordExecution(id, r.requestId, {
    type: 'tool.call',
    call: {id: 'secret-call', name: 'read', input: {path: 'README.md', note: secret}},
  });
  store.recordExecution(id, r.requestId, {
    type: 'tool.result',
    result: {callId: 'secret-call', name: 'read', status: 'ok', content: secret},
  });
  store.recordExecution(id, r.requestId, {type: 'assistant.text', text: secret});
  store.complete(
    id,
    revision,
    {role: 'assistant', content: secret},
    {...r, outcome: 'completed', finishedAt: new Date().toISOString()},
    [
      {role: 'assistant', content: '', toolCalls: [{id: 'secret-call', name: 'read', input: {path: secret}}]},
      {role: 'tool', toolCallId: 'secret-call', toolName: 'read', content: secret},
    ],
  );
  const raw =
    JSON.stringify(db.query('SELECT * FROM messages').all()) +
    JSON.stringify(db.query('SELECT * FROM conversation_events').all());
  expect(raw).not.toContain(secret);
  expect(raw).toContain('[REDACTED]');
});

test('a call recorded before dispatch is explicitly not executed, rather than falsely successful', () => {
  const {store} = setup(),
    id = store.create(selection),
    r = receipt();
  const revision = store.beginExecution(id, {role: 'user', content: 'Create helo.html'}, r);
  store.recordExecution(id, r.requestId, {
    type: 'tool.call',
    call: {id: 'not-started', name: 'apply_patch', input: {patch: 'proposal'}},
  });
  store.interrupt(id, revision, {...r, outcome: 'failed', finishedAt: new Date().toISOString()});
  expect(normalizeHistory(store.recover(id).messages).find(m => m.toolCallId === 'not-started')!.content).toContain(
    'not executed',
  );
});

test('crash between filesystem effect and result stays unknown and recovery never replays the mutation', () => {
  const home = mkdtempSync(join(tmpdir(), 'hannes-write-crash-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const target = join(home, 'helo.html');
  const script = `import {openPrivateDatabase,SqliteConversations} from ${JSON.stringify(resolve('packages/persistence/src/index.ts'))};
 const db=openPrivateDatabase(${JSON.stringify(home)});const store=new SqliteConversations(db);const id=store.create(${JSON.stringify(selection)});const r=${JSON.stringify(receipt())};store.beginExecution(id,{role:'user',content:'Create helo.html'},r);
 store.recordExecution(id,r.requestId,{type:'tool.call',call:{id:'uncertain-write',name:'apply_patch',input:{patch:'*** Begin Patch\\n*** Add File: helo.html\\n+fixture\\n*** End Patch'}}});
 store.recordExecution(id,r.requestId,{type:'tool.intent',callId:'uncertain-write',executionId:crypto.randomUUID(),capability:'fs.write'});
 await Bun.write(${JSON.stringify(target)},'<!doctype html><html>surviving effect</html>');await Bun.write(Bun.stdout,id);process.exit(0);`;
  // Fault injection models the non-atomic filesystem/SQLite gap, not a production permission bypass.
  const child = Bun.spawnSync([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
  expect(child.exitCode).toBe(0);
  const db = openPrivateDatabase(home);
  try {
    const store = new SqliteConversations(db),
      id = child.stdout.toString().trim();
    const first = store.recover(id);
    expect(first.turns[0]!.state).toBe('interrupted');
    const result = normalizeHistory(first.messages).find(m => m.toolCallId === 'uncertain-write')!;
    expect(result.content).toContain('unknown');
    expect(result.content).toContain('Inspect current filesystem');
    expect(store.recover(id).messages).toEqual(first.messages);
    expect(readFileSync(target, 'utf8')).toBe('<!doctype html><html>surviving effect</html>');
  } finally {
    db.close();
  }
});

test('semantically corrupt lifecycle endings are rejected instead of reconstructing a successful turn', () => {
  const {store, db} = setup(),
    id = store.create(selection),
    r = receipt();
  const revision = store.beginExecution(id, {role: 'user', content: 'Create helo.html'}, r);
  store.interrupt(id, revision, {...r, outcome: 'cancelled', finishedAt: new Date().toISOString()});
  db.query("UPDATE execution_turns SET state='completed' WHERE conversation=?").run(id);
  expect(() => store.recover(id)).toThrow(FutrynError);
});
