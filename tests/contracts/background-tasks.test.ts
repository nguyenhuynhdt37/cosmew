import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BackgroundTasks} from '../../apps/cli/src/bootstrap/background-tasks';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import type {BackgroundTask, BackgroundTaskEvent, CommandRuntime} from '@cosmew/contracts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const task = (status: BackgroundTask['status'] = 'running'): BackgroundTask => ({
  id: 'existing-exec-session',
  kind: 'shell',
  description: 'echo secret',
  status,
  startedAt: new Date().toISOString(),
  outputTail: 'secret output',
  ...(status === 'done' ? {exitCode: 0} : {}),
});
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'fyn-tasks-registry-'));
  const db = openPrivateDatabase(root);
  cleanup.push(
    () => rmSync(root, {recursive: true, force: true}),
    () => db.close(),
  );
  const store = new SqliteConversations(db);
  const first = store.create({accountId: crypto.randomUUID(), modelId: 'fixture'});
  const second = store.create({accountId: crypto.randomUUID(), modelId: 'fixture'});
  let current = first;
  let stopped: string | undefined;
  let steered = false;
  const tasks = [task()];
  const runtime: CommandRuntime = {
    id: 'fixture',
    label: 'fixture',
    availability: () => ({ok: true}),
    run: async () => {
      throw new Error('registry must never launch commands');
    },
    backgroundTasks: () => tasks,
    stopBackgroundTask: async id => {
      stopped = id;
      return true;
    },
    backgroundCurrentTask: () => tasks[0],
  };
  const events: BackgroundTaskEvent[] = [];
  const registry = new BackgroundTasks({
    runtime: () => runtime,
    currentSession: () => current,
    redact: text => text.replaceAll('secret', '[redacted]'),
    deliver: (id, text) => {
      if (steered) return 'steered';
      store.enqueueNextTurn(id, text);
      return 'queued';
    },
  });
  registry.observe(event => events.push(event));
  return {
    root,
    db,
    store,
    first,
    second,
    tasks,
    events,
    registry,
    switchSession: () => {
      current = second;
    },
    getStopped: () => stopped,
    steer: () => {
      steered = true;
    },
  };
}

test('completion queues one redacted durable task notification to the original parent across navigation', () => {
  const h = harness();
  h.registry.accept({type: 'task.started', task: h.tasks[0]!});
  expect(h.registry.list(h.first)[0]?.description).toBe('echo [redacted]');
  h.switchSession();
  h.tasks[0] = task('done');
  h.registry.accept({type: 'task.finished', task: h.tasks[0]!});
  h.registry.accept({type: 'task.finished', task: h.tasks[0]!});
  expect(h.events.at(-1)?.delivery).toBe('queued');
  expect(h.events.filter(event => event.type === 'task.finished')).toHaveLength(1);
  expect(h.store.listNextTurn(h.second)).toEqual([]);
  const queued = h.store.listNextTurn(h.first);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.content).toContain('<task-notification>');
  expect(queued[0]?.content).toContain('completed (exit code 0)');
  expect(queued[0]?.content).toContain('[redacted]');
  expect(queued[0]?.content).not.toContain('secret');
  // New persistence object reconstructs the notification without replaying a command.
  expect(new SqliteConversations(h.db).listNextTurn(h.first)).toEqual(queued);
});

test('controls cannot target another session and a live parent receives completion before observers', async () => {
  const h = harness();
  h.registry.accept({type: 'task.started', task: h.tasks[0]!});
  expect(await h.registry.stop(h.tasks[0]!.id, h.second)).toBe(false);
  expect(h.getStopped()).toBeUndefined();
  expect(h.registry.background(h.second)).toBeUndefined();
  expect(await h.registry.stop(h.tasks[0]!.id, h.first)).toBe(true);
  expect(h.getStopped()).toBe(h.tasks[0]!.id);
  h.steer();
  h.registry.accept({type: 'task.finished', task: task('failed')});
  expect(h.events.at(-1)?.delivery).toBe('steered');
  expect(h.store.listNextTurn(h.first)).toEqual([]);
});

test('launch conversation metadata takes precedence over the current root session', async () => {
  const h = harness();
  h.registry.accept({type: 'task.started', task: h.tasks[0]!, parentSessionId: h.second});
  expect(h.registry.list(h.first)).toEqual([]);
  expect(h.registry.list(h.second)).toHaveLength(1);
  expect(await h.registry.stop(h.tasks[0]!.id, h.first)).toBe(false);
  h.registry.accept({type: 'task.finished', task: task('done'), parentSessionId: h.first});
  expect(h.store.listNextTurn(h.first)).toEqual([]);
  expect(h.store.listNextTurn(h.second)).toHaveLength(1);
});
