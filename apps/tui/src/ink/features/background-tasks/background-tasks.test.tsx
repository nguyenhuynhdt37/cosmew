/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {dialogFixture, selection} from '../picker/test-fixture';
import {BackgroundTasksDialog} from './index';
import type {BackgroundTask} from '@cosmew/sdk';
import {FutrynError} from '@cosmew/contracts';
afterEach(cleanup);

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
