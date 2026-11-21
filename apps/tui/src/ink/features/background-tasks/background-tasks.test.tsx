/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {dialogFixture, selection} from '../picker/test-fixture';
import {BackgroundTasksDialog} from './index';
import type {BackgroundTask, BackgroundTaskEvent} from '@cosmew/sdk';
import {FutrynError} from '@cosmew/contracts';
afterEach(cleanup);

test('task inspection without an account or active session shows an empty list without starting work', async () => {
  const view = renderInk(<BackgroundTasksDialog width={40} />);
  await settle();
  expect(view.lastFrame()).toContain('No background tasks');
  view.stdin.write('x');
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('No background tasks');
  expect(view.lastFrame()).not.toContain('Stopping task');
});

test('live task output starts at its tail, pauses when scrolled and follows again with End', async () => {
  const item: BackgroundTask = {
    id: 'live',
    kind: 'shell',
    status: 'running',
    description: 'Watch build',
    startedAt: '',
    outputTail: Array.from({length: 20}, (_, i) => `output-${i}`).join('\n'),
  };
  let emit!: (event: BackgroundTaskEvent) => void;
  const fixture = dialogFixture({
    startSession: () => ({id: 'owner', selection, messages: []}),
    backgroundTasks: () => [item],
    observeBackgroundTasks: listener => {
      emit = listener;
      return () => {};
    },
  });
  fixture.client.createSession();
  const view = renderInk(<BackgroundTasksDialog width={40} visibleRows={3} />, {fixture});
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('output-19');
  expect(view.lastFrame()).not.toContain('output-0\n');
  view.stdin.write('\x1b[A');
  await settle();
  expect(view.lastFrame()).toContain('output-18');
  expect(view.lastFrame()).not.toContain('output-19');
  item.outputTail += '\noutput-20';
  emit({type: 'task.updated', parentSessionId: 'owner', task: {...item}});
  await settle();
  expect(view.lastFrame()).not.toContain('output-20');
  view.stdin.write('\x1b[F');
  await settle();
  expect(view.lastFrame()).toContain('output-20');
  item.status = 'done';
  item.exitCode = 0;
  item.outputTail += '\nBUILD_FINISHED';
  emit({type: 'task.finished', parentSessionId: 'owner', task: {...item}});
  await settle();
  expect(view.lastFrame()).toContain('BUILD_FINISHED');
  expect(view.lastFrame()).toContain('done');
  expect(view.lastFrame()).toContain('exit 0');
});

test('switching sessions hides old output and late stop completion cannot update the new session view', async () => {
  const first: BackgroundTask = {
    id: 'first',
    kind: 'shell',
    status: 'running',
    description: 'Old job',
    startedAt: '',
    outputTail: 'OLD_SESSION_OUTPUT',
  };
  const next: BackgroundTask = {...first, id: 'second', description: 'New job', outputTail: 'NEW_SESSION_OUTPUT'};
  let created = 0;
  let finish!: (stopped: boolean) => void;
  const stops: string[] = [];
  const fixture = dialogFixture({
    startSession: () => ({id: ++created === 1 ? 'first-session' : 'second-session', selection, messages: []}),
    backgroundTasks: owner => [owner === 'first-session' ? first : next],
    stopBackgroundTask: (id, owner) => {
      stops.push(`${owner}:${id}`);
      return new Promise(resolve => {
        finish = resolve;
      });
    },
  });
  fixture.client.createSession();
  const view = renderInk(<BackgroundTasksDialog width={40} visibleRows={3} />, {fixture});
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('OLD_SESSION_OUTPUT');
  view.stdin.write('x');
  await settle();
  expect(stops).toEqual(['first-session:first']);
  fixture.client.createSession();
  await settle();
  expect(view.lastFrame()).not.toContain('OLD_SESSION_OUTPUT');
  expect(view.lastFrame()).toContain('New job');
  finish(true);
  await settle();
  expect(view.lastFrame()).not.toContain('Stopping task');
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('NEW_SESSION_OUTPUT');
});

test('task list opens bounded output directly, Esc returns, and x only stops the highlighted running task', async () => {
  const stopped: string[] = [];
  const tasks: BackgroundTask[] = [
    {
      id: 'build',
      kind: 'shell',
      status: 'running',
      description: 'Compile',
      outputTail: 'last output\u001b]52;c;bad\u0007',
      startedAt: new Date().toISOString(),
    },
    {
      id: 'done',
      kind: 'shell',
      status: 'done',
      description: 'Finished job',
      outputTail: 'complete',
      exitCode: 0,
      startedAt: new Date().toISOString(),
    },
  ];
  const fixture = dialogFixture({
    startSession: () => ({id: 'owner', selection, messages: []}),
    backgroundTasks: () => tasks,
    stopBackgroundTask: async (id, owner) => {
      stopped.push(`${owner}:${id}`);
      return true;
    },
  });
  fixture.client.createSession();
  const view = renderInk(<BackgroundTasksDialog width={80} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('● shell · running · Compile');
  expect(view.lastFrame()).toContain('✔ shell · done · Finished job');
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('last output');
  expect(view.lastFrame()).not.toContain('bad');
  expect(view.lastFrame()).not.toContain('View output');
  view.stdin.write('\x1b');
  await settle();
  expect(view.lastFrame()).toContain('Background tasks');
  view.stdin.write('\x1b[B');
  await settle();
  view.stdin.write('x');
  await settle();
  expect(stopped).toEqual([]);
  view.stdin.write('\x1b[A');
  await settle();
  view.stdin.write('x');
  await settle();
  expect(stopped).toEqual(['owner:build']);
  expect(view.lastFrame()).toContain('Stopping task');
});

test('a backend refusal leaves the selected task running and never reports a successful stop', async () => {
  const task: BackgroundTask = {
    id: 'running',
    kind: 'shell',
    status: 'running',
    description: 'Build',
    outputTail: '',
    startedAt: '',
  };
  let calls = 0;
  const fixture = dialogFixture({
    startSession: () => ({id: 'owner', selection, messages: []}),
    backgroundTasks: () => [task],
    stopBackgroundTask: async () => {
      calls++;
      throw new FutrynError('POLICY');
    },
  });
  fixture.client.createSession();
  const view = renderInk(<BackgroundTasksDialog />, {fixture});
  await settle();
  view.stdin.write('x');
  await settle();
  expect(calls).toBe(1);
  expect(fixture.client.backgroundTasks()[0]?.status).toBe('running');
  expect(view.lastFrame()).not.toContain('Stopping task');
  expect(view.lastFrame()).toContain('POLICY');
});
