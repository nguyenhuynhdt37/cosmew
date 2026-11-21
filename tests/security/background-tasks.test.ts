import {test, expect, afterEach} from 'bun:test';
import {existsSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCommandRuntime, NATIVE_LIMITS} from '@cosmew/tools';
import type {BackgroundTaskEvent} from '@cosmew/contracts';

const nativeTest = test.skipIf(
  process.env.FUTRYN_TEST_REAL_BACKGROUND !== '1' ||
    process.platform !== 'darwin' ||
    !existsSync('/usr/bin/sandbox-exec'),
);
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-background-')));
  const runtime = new NativeCommandRuntime({workspaceRoot: root});
  clean.push(
    () => rmSync(root, {recursive: true, force: true}),
    () => runtime.shutdown(),
  );
  const events: BackgroundTaskEvent[] = [];
  runtime.observeBackgroundTasks(event => events.push(event));
  const run = (command: string, signal?: AbortSignal) =>
    runtime.run(
      {
        command,
        taskSessionId: 'owner',
        cwd: root,
        timeoutMs: 10_000,
        maxOutputBytes: 1000,
        yieldTimeMs: 5000,
        sandbox: {mode: 'workspace-write', network: false},
      },
      signal,
    );
  return {runtime, events, run};
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}
nativeTest(
  'foreground transfer keeps the same session alive after parent abort, retaining non-consuming output',
  async () => {
    const {runtime, events, run} = harness();
    const abort = new AbortController();
    const pending = run('echo start; sleep 0.2; echo finish', abort.signal);
    const moved = runtime.backgroundCurrentTask();
    expect(moved).toBeDefined();
    const outcome = await pending;
    expect(outcome.kind).toBe('running');
    const id = outcome.sessionId!;
    abort.abort();
    await until(() => runtime.backgroundTasks()[0]?.status === 'done');
    const task = runtime.backgroundTasks()[0]!;
    expect(task.id).toBe(id);
    expect(task.exitCode).toBe(0);
    expect(task.outputTail).toContain('finish');
    const polled = await runtime.writeStdin(id, '', 0);
    expect(polled.output).toContain('finish');
    expect(events.map(event => event.type)).toContain('task.started');
    expect(events.filter(event => event.type === 'task.finished')).toHaveLength(1);
    expect(await runtime.stopBackgroundTask(id)).toBe(false);
  },
);
nativeTest('stop targets only an existing background session and exit failures are recorded', async () => {
  const {runtime, run} = harness();
  expect(await runtime.stopBackgroundTask('unknown')).toBe(false);
  const running = run('sleep 5');
  expect(runtime.backgroundCurrentTask('another-session')).toBeUndefined();
  const task = runtime.backgroundCurrentTask('owner')!;
  expect(task).toBeDefined();
  await running;
  expect(await runtime.stopBackgroundTask(task.id)).toBe(true);
  expect(runtime.backgroundTasks()[0]?.status).toBe('stopped');
  expect(await runtime.stopBackgroundTask(task.id)).toBe(false);
  const failed = run('sleep 0.1; echo failed; exit 7');
  const failure = runtime.backgroundCurrentTask()!;
  await failed;
  await until(() => runtime.backgroundTasks().find(task => task.id === failure.id)?.status === 'failed');
  expect(runtime.backgroundTasks().find(task => task.id === failure.id)?.exitCode).toBe(7);
});
nativeTest('foreground cancellation still stops an execution that was never transferred', async () => {
  const {runtime, run} = harness();
  const abort = new AbortController();
  const pending = run('sleep 5', abort.signal);
  abort.abort();
  expect((await pending).kind).toBe('cancelled');
  expect(runtime.backgroundTasks()).toEqual([]);
});

nativeTest('completed unattended tasks cannot exhaust active terminal capacity', async () => {
  const {runtime, run} = harness();
  for (let i = 0; i <= NATIVE_LIMITS.maxSessions; i++) {
    const pending = run('sleep 0.05');
    const task = runtime.backgroundCurrentTask()!;
    expect(task).toBeDefined();
    await pending;
    await until(() => runtime.backgroundTasks().find(value => value.id === task.id)?.status === 'done');
  }
  expect(runtime.backgroundTasks().filter(task => task.status === 'done')).toHaveLength(NATIVE_LIMITS.maxSessions + 1);
});
