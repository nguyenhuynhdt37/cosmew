import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SubagentManager} from '@cosmew/agents';
import type {BackgroundTask, CommandRuntime} from '@cosmew/contracts';
import {openPrivateDatabase, SqliteBackgroundTaskHistory, SqliteConversations} from '@cosmew/persistence';
import {BackgroundTasks} from '../../apps/cli/src/bootstrap/background-tasks';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const redact = (s: string) => s.replaceAll('SECRET_TOKEN', '[redacted]');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-task-history-'));
  let db = openPrivateDatabase(root);
  cleanup.push(() => {
    db.close();
    rmSync(root, {recursive: true, force: true});
  });
  const store = new SqliteConversations(db, redact);
  const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
  const owner = store.create(selection);
  const other = store.create(selection);
  return {
    get db() {
      return db;
    },
    root,
    store,
    owner,
    other,
    selection,
    reopen() {
      db.close();
      db = openPrivateDatabase(root);
      return db;
    },
  };
}
const task = (id: string, status: BackgroundTask['status'] = 'running'): BackgroundTask => ({
  id,
  kind: 'shell',
  status,
  description: 'echo SECRET_TOKEN',
  startedAt: '2026-11-22T00:00:00.000Z',
  outputTail: 'before SECRET_TOKEN after',
  ...(status === 'done' ? {exitCode: 0} : {}),
});
function registry(h: ReturnType<typeof setup>, live: BackgroundTask[] = []) {
  const calls = {run: 0, stop: 0, deliver: 0};
  const runtime: CommandRuntime = {
    id: 'history-fixture',
    label: 'history-fixture',
    availability: () => ({ok: true}),
    run: async () => {
      calls.run++;
      throw new Error('must never execute');
    },
    backgroundTasks: () => live,
    stopBackgroundTask: async () => {
      calls.stop++;
      return true;
    },
  };
  const history = new SqliteBackgroundTaskHistory(h.db, redact);
  const tasks = new BackgroundTasks({
    runtime: () => runtime,
    currentSession: () => h.owner,
    redact,
    history,
    deliver: () => {
      calls.deliver++;
      return 'queued';
    },
  });
  return {tasks, calls, history, runtime};
}

test('reopened SQLite and new registry retain terminal output and stop orphaned snapshots without execution', async () => {
  const h = setup();
  const before = registry(h);
  before.tasks.accept({type: 'task.started', task: task('orphan')});
  before.tasks.accept({type: 'task.started', task: task('done')});
  before.tasks.accept({type: 'task.finished', task: task('done', 'done')});
  before.tasks.accept({type: 'task.finished', task: task('failed', 'failed')});
  before.tasks.accept({type: 'task.finished', task: task('stopped', 'stopped')});
  // A listener can read the saved original owner before completion is published.
  before.tasks.observe(event => expect(before.history.list(h.owner).some(t => t.id === event.task.id)).toBe(true));
  before.tasks.accept({type: 'task.finished', parentSessionId: h.other, task: task('orphan', 'stopped')});
  before.tasks.accept({type: 'task.started', task: task('crashed')});
  expect(JSON.stringify(h.db.query('SELECT data FROM background_task_history').all())).not.toContain('SECRET_TOKEN');
  h.reopen();
  const after = registry(h, [task('crashed')]); // Even a runtime ID collision has no ownership after restart.
  const snapshots = after.tasks.list(h.owner);
  expect(snapshots.find(t => t.id === 'crashed')?.status).toBe('stopped');
  expect(snapshots.find(t => t.id === 'done')).toEqual({
    ...task('done', 'done'),
    description: 'echo [redacted]',
    outputTail: 'before [redacted] after',
  });
  expect(snapshots.find(t => t.id === 'failed')?.status).toBe('failed');
  expect(after.tasks.list(h.other)).toEqual([]);
  for (const id of ['crashed', 'done', 'stopped', 'unknown']) expect(await after.tasks.stop(id, h.owner)).toBe(false);
  expect(await after.tasks.stop('crashed', h.other)).toBe(false);
  expect(after.calls).toEqual({run: 0, stop: 0, deliver: 0});
  expect(before.calls.run).toBe(0);
  const live = task('live');
  const current = registry(h, [live]);
  current.tasks.accept({type: 'task.started', task: live});
  expect(current.tasks.list(h.owner).find(t => t.id === 'live')?.status).toBe('running');
  expect(await current.tasks.stop('live', h.owner)).toBe(true);
  expect(await current.tasks.stop('live', h.other)).toBe(false);
});

test('live child shells use their original source runtime; archives cannot reacquire control', async () => {
  const h = setup();
  const root = registry(h); // root runtime has no shell tasks
  const childTasks = [task('isolated-child')];
  let childStops = 0;
  const child: CommandRuntime = {
    ...root.runtime,
    id: 'child-runtime',
    backgroundTasks: () => childTasks,
    stopBackgroundTask: async () => {
      childStops++;
      return true;
    },
  };
  root.tasks.accept({type: 'task.started', task: childTasks[0]!}, child);
  expect(root.tasks.list(h.owner)[0]?.status).toBe('running');
  expect(await root.tasks.stop('isolated-child', h.other)).toBe(false);
  expect(await root.tasks.stop('isolated-child', h.owner)).toBe(true);
  expect(childStops).toBe(1);
  expect(root.calls.stop).toBe(0);
  // Another source cannot steal an existing task's owner or lifecycle.
  root.tasks.accept(
    {type: 'task.finished', task: task('isolated-child', 'done'), parentSessionId: h.other},
    root.runtime,
  );
  expect(root.tasks.list(h.owner)[0]?.status).toBe('running');
  expect(root.tasks.list(h.other)).toEqual([]);
  // A terminal event outranks even a stale runtime snapshot during shutdown.
  root.tasks.accept({type: 'task.finished', task: task('isolated-child', 'stopped')}, child);
  expect(root.tasks.list(h.owner)[0]?.status).toBe('stopped');
  expect(await root.tasks.stop('isolated-child', h.owner)).toBe(false);
  expect(childStops).toBe(1);
  childTasks.length = 0;
  h.reopen();
  const recovered = registry(h, [task('isolated-child')]);
  expect(recovered.tasks.list(h.owner)[0]?.status).toBe('stopped');
  expect(await recovered.tasks.stop('isolated-child', h.owner)).toBe(false);
  expect(recovered.calls).toEqual({run: 0, stop: 0, deliver: 0});
});

test('history bounds redacted fields, retains newest 200 per owner / 5000 globally, and deletes with conversation', () => {
  const h = setup();
  const history = new SqliteBackgroundTaskHistory(h.db, redact);
  h.db.transaction(() => {
    for (let owner = 0; owner < 26; owner++) {
      const id = owner === 0 ? h.owner : h.store.create(h.selection);
      for (let i = 0; i < 205; i++)
        history.save(id, {
          ...task(`${owner}-${i}`, 'done'),
          description: 'SECRET_TOKEN'.repeat(200),
          outputTail: 'SECRET_TOKEN'.repeat(2000),
        });
    }
  })();
  expect((h.db.query('SELECT count(*) AS n FROM background_task_history').get() as {n: number}).n).toBe(5000);
  expect(history.list(h.owner)).toEqual([]); // oldest owner pruned by global retention
  for (let i = 0; i < 205; i++)
    history.save(h.owner, {
      ...task(`new-${i}`),
      description: 'SECRET_TOKEN'.repeat(200),
      outputTail: 'SECRET_TOKEN'.repeat(2000),
    });
  const rows = history.list(h.owner);
  expect(rows).toHaveLength(200);
  expect(rows.some(t => t.id === 'new-0')).toBe(false);
  expect(rows[0]?.id).toBe('new-204');
  expect(rows[0]!.description.length).toBeLessThanOrEqual(1024);
  expect(rows[0]!.outputTail.length).toBeLessThanOrEqual(8192);
  expect(JSON.stringify(rows)).not.toContain('SECRET_TOKEN');
  expect(h.store.delete(h.owner)).toBe(true);
  expect(history.list(h.owner)).toEqual([]);
});

test('failed history writes roll back without removing existing snapshots', () => {
  const h = setup();
  const history = new SqliteBackgroundTaskHistory(h.db, redact);
  history.save(h.owner, task('retained', 'done'));
  expect(() => history.save(crypto.randomUUID(), task('unknown-owner'))).toThrow();
  expect(history.list(h.owner).map(t => t.id)).toEqual(['retained']);
  expect((h.db.query('SELECT count(*) AS n FROM background_task_history').get() as {n: number}).n).toBe(1);
});

test('schema 10 migrates additively, preserves conversations, and future schema is refused', () => {
  const h = setup();
  h.store.append(h.owner, {role: 'assistant', content: 'retained'}, 'committed');
  h.db.exec('DROP TABLE background_task_history; PRAGMA user_version=10;');
  h.reopen();
  expect(h.db.query('PRAGMA user_version').get()).toEqual({user_version: 11});
  expect(new SqliteConversations(h.db).get(h.owner)?.messages[0]?.content).toBe('retained');
  new SqliteBackgroundTaskHistory(h.db, redact).save(h.owner, task('migrated', 'done'));
  h.db.exec('PRAGMA user_version=12;');
  expect(() => openPrivateDatabase(h.root)).toThrow();
});

test('restart inspect/list/wait keep child transcript and report orphan running metadata as interrupted', async () => {
  const h = setup();
  const child = h.store.create(h.selection);
  h.store.saveSubagentSession({
    id: child,
    parentConversationId: h.owner,
    parentTurnId: null,
    callId: 'call',
    depth: 1,
    agentType: 'explore',
    description: 'Inspect',
    prompt: 'Inspect',
    forkContext: false,
    background: true,
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
  });
  h.store.append(child, {role: 'assistant', content: 'retained SECRET_TOKEN'}, 'committed');
  h.store.append(
    child,
    {role: 'assistant', content: '', toolCalls: [{id: 'unfinished', name: 'read', input: {path: 'a.ts'}}]},
    'committed',
  );
  h.reopen();
  let launches = 0;
  const store = new SqliteConversations(h.db, redact);
  const manager = new SubagentManager({
    getConfig: () => ({}),
    getParentState: () => ({sessionId: h.owner, selection: h.selection, analysisOnly: false, messages: []}),
    lookupModel: () => undefined,
    availableModelIds: () => [],
    store,
    runChildTurn: async function* () {
      launches++;
      throw new Error('no automatic resume');
    },
    addParentUsage: () => undefined,
    redact,
  });
  const view = manager.inspectSubagent(child)!;
  expect(view.status).toBe('interrupted');
  expect(view.summary).toBe('retained [redacted]');
  expect(view.steps.find(step => step.kind === 'tool')?.status).toBe('error');
  expect(manager.listSubagents(h.owner).map(t => t.id)).toEqual([child]);
  expect(manager.listSubagents(h.other)).toEqual([]);
  expect(manager.stopSubagent(child)).toBe(false);
  const waited = await manager.wait({ids: [child], timeout_ms: 10000});
  expect(waited.content).toContain('interrupted');
  expect(waited.content).toContain('"timed_out":false');
  expect(launches).toBe(0);
});
