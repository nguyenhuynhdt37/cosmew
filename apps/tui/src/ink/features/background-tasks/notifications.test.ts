import {expect, test} from 'bun:test';
import type {BackgroundTaskEvent} from '@cosmew/sdk';
import {TaskNotifications} from './notifications';
import {sessionTasks, taskStatusLabel} from './tasks';
import {dialogFixture, selection} from '../picker/test-fixture';

function finished(
  status: 'done' | 'failed' | 'stopped' = 'done',
  kind: 'agent' | 'shell' = 'agent',
): BackgroundTaskEvent {
  return {
    type: 'task.finished',
    parentSessionId: 'owner',
    delivery: 'queued',
    task: {id: 'child', kind, description: 'Inspect cancellation', status, startedAt: '', outputTail: ''},
  };
}
const childNotice = {
  agentId: 'child',
  parentSessionId: 'owner',
  agentType: 'explore',
  description: 'Inspect cancellation',
  status: 'completed' as const,
  delivery: 'queued' as const,
};

test('task projection and child completion deduplicate in either arrival order', () => {
  for (const reverse of [false, true]) {
    const notices = new TaskNotifications();
    const first = reverse ? notices.subagent('owner', childNotice) : notices.background('owner', finished());
    const second = reverse ? notices.background('owner', finished()) : notices.subagent('owner', childNotice);
    expect(first?.text).toContain('Inspect cancellation');
    expect(first?.text).toContain('[child]');
    expect(first?.text).toContain('Open /tasks → child');
    expect(second).toBeUndefined();
  }
});

test('a transcript reset in the same session does not repeat the companion completion notice', () => {
  const notices = new TaskNotifications();
  expect(notices.background('owner', finished())).toBeDefined();
  notices.reset('owner');
  expect(notices.subagent('owner', childNotice)).toBeUndefined();
});

test('a resumed child can finish again while its two completion sources still deduplicate', () => {
  const notices = new TaskNotifications();
  expect(notices.background('owner', finished())).toBeDefined();
  const event = finished();
  notices.background('owner', {
    ...event,
    type: 'task.started',
    delivery: undefined,
    task: {...event.task, status: 'running'},
  });
  expect(notices.subagent('owner', childNotice)).toBeDefined();
  expect(notices.background('owner', finished())).toBeUndefined();
});

test('success, failure and cancellation have distinct labels, never inferred from permission requests', () => {
  for (const [status, label] of [
    ['done', 'completed'],
    ['failed', 'failed'],
    ['stopped', 'cancelled/stopped'],
  ] as const) {
    expect(new TaskNotifications().background('owner', finished(status, 'shell'))?.text).toContain(label);
  }
  expect(new TaskNotifications().subagent('owner', {...childNotice, status: 'cancelled'})?.text).toContain('cancelled');
  const event = finished();
  const notices = new TaskNotifications();
  expect(notices.background('owner', {...event, type: 'task.updated'})).toBeUndefined();
  expect(notices.background('owner', {...event, task: {...event.task, status: 'running'}})).toBeUndefined();
  expect(notices.background('owner', {...event, delivery: undefined})).toBeUndefined();
  expect(notices.subagent('owner', {...childNotice, delivery: 'consumed'})).toBeUndefined();
  expect(notices.background('owner', event)).toBeDefined();
});

test('foreign, unattributed and late old-session completions cannot contaminate the current session', () => {
  const notices = new TaskNotifications();
  expect(notices.background('owner', {...finished(), parentSessionId: undefined})).toBeUndefined();
  expect(notices.subagent('owner', {...childNotice, parentSessionId: 'foreign'})).toBeUndefined();
  expect(notices.background(undefined, finished())).toBeUndefined();
  expect(notices.background('owner', finished())).toBeDefined();
  expect(notices.background('next', finished())).toBeUndefined();
  expect(notices.subagent('next', childNotice)).toBeUndefined();
  expect(notices.background('next', {...finished(), parentSessionId: 'next'})).toBeDefined();
  notices.reset('next');
  expect(notices.background('next', {...finished(), parentSessionId: 'next'})).toBeUndefined();
});

test('dedup retains a bounded recent window per session', () => {
  const notices = new TaskNotifications();
  for (let i = 0; i < 513; i++) {
    const event = finished();
    expect(notices.background('owner', {...event, task: {...event.task, id: `task-${i}`}})).toBeDefined();
  }
  const event = finished();
  expect(notices.background('owner', {...event, task: {...event.task, id: 'task-512'}})).toBeUndefined();
  expect(notices.background('owner', {...event, task: {...event.task, id: 'task-0'}})).toBeDefined();
});

test('permission waiting is presentation only and clears when the request resolves', () => {
  let status: 'running' | 'done' = 'running';
  const fixture = dialogFixture({
    startSession: () => ({id: 'owner', selection, messages: []}),
    backgroundTasks: () => [{...finished().task, status}],
  });
  fixture.client.createSession();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'fs.read',
    action: 'read',
    target: '/fixture/a.ts',
    reason: 'inspect',
    subagent: {agentId: 'child', agentType: 'explore', description: 'Inspect cancellation'},
  });
  expect(taskStatusLabel(sessionTasks(fixture.client)[0]!)).toBe('waiting for permission');
  expect(sessionTasks(fixture.client)[0]!.status).toBe('running');
  fixture.client.dismissPermissionDialog(request.approvalId);
  expect(taskStatusLabel(sessionTasks(fixture.client)[0]!)).toBe('running');
  status = 'done';
  expect(taskStatusLabel(sessionTasks(fixture.client)[0]!)).toBe('done');
});
