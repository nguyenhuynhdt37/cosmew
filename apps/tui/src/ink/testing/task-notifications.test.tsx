/** Shell notification integration over SDK observer ports; no provider/OS claims. */
import {expect, test} from 'bun:test';
import type {BackgroundTaskEvent, ModelEvent, SubagentNotice} from '@cosmew/contracts';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';

test('shell owns one scoped child notice across both SDK sources and preserves permission overlay', async () => {
  let emitTask!: (event: BackgroundTaskEvent) => void;
  let emitChild!: (event: SubagentNotice) => void;
  const {client} = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'owner', selection, messages: []}),
    observeBackgroundTasks: listener => {
      emitTask = listener;
      return () => {};
    },
    observeSubagentNotices: listener => {
      emitChild = listener;
      return () => {};
    },
  });
  client.createSession();
  const ui = await openInk(client, {width: 120});
  const notice: SubagentNotice = {
    agentId: 'child',
    parentSessionId: 'owner',
    description: 'Inspect parser',
    agentType: 'explore',
    status: 'failed',
    delivery: 'steered',
  };
  try {
    emitChild({...notice, parentSessionId: 'foreign', description: 'FOREIGN_TASK'});
    await ui.press('');
    expect(ui.frame()).not.toContain('FOREIGN_TASK');
    const pending = client.enqueuePermissionRequest({
      capability: 'fs.read',
      action: 'read',
      target: '/fixture/source.ts',
      reason: 'inspect',
      subagent: {agentId: 'waiting-child', agentType: 'explore', description: 'Permission owner'},
    });
    await ui.press('');
    expect(client.listPendingPermissions()).toHaveLength(1);
    emitTask({
      type: 'task.finished',
      parentSessionId: 'owner',
      delivery: 'steered',
      task: {
        id: 'child',
        kind: 'agent',
        description: 'Inspect parser',
        status: 'failed',
        startedAt: '',
        outputTail: '',
      },
    });
    emitChild(notice);
    emitChild(notice);
    await ui.press('');
    expect(client.listPendingPermissions()[0]?.approvalId).toBe(pending.approvalId);
    expect(ui.frame()).toContain('Permission owner');
    client.dismissPermissionDialog(pending.approvalId);
    await ui.press('');
    expect(ui.frame().match(/Inspect parser/g)).toHaveLength(1);
    expect(ui.frame()).toContain('[child] failed');
    expect(ui.frame()).toContain('Open /tasks');
  } finally {
    await ui.close();
  }
});

test('completion arriving while history is paged does not jump to bottom', async () => {
  let emit!: (event: BackgroundTaskEvent) => void;
  const {client} = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'owner', selection, messages: []}),
    observeBackgroundTasks: listener => {
      emit = listener;
      return () => {};
    },
    async *sendTurn(): AsyncIterable<ModelEvent> {
      yield {type: 'textDelta', text: Array.from({length: 70}, (_, i) => `answer line ${i + 1}`).join('\n')};
    },
  });
  const ui = await openInk(client, {width: 100, rows: 24});
  try {
    await ui.submit('long answer');
    await ui.idle();
    await ui.handleKey('PageUp');
    expect(ui.frame()).toContain('Jump to bottom');
    emit({
      type: 'task.finished',
      parentSessionId: 'owner',
      delivery: 'steered',
      task: {id: 'late', kind: 'shell', description: 'LATE_COMPLETION', status: 'done', startedAt: '', outputTail: ''},
    });
    await ui.press('');
    expect(ui.frame()).toContain('Jump to bottom');
    expect(ui.frame()).not.toContain('LATE_COMPLETION');
    await ui.handleKey('PageDown');
    await ui.handleKey('PageDown');
    expect(ui.frame()).toContain('LATE_COMPLETION');
  } finally {
    await ui.close();
  }
});

test('background notification never becomes the target of parent streaming text', async () => {
  let emit!: (event: BackgroundTaskEvent) => void;
  let resume!: () => void;
  const pause = new Promise<void>(resolve => {
    resume = resolve;
  });
  const {client} = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'owner', selection, messages: []}),
    observeBackgroundTasks: listener => {
      emit = listener;
      return () => {};
    },
    async *sendTurn(): AsyncIterable<ModelEvent> {
      yield {type: 'textDelta', text: 'PARENT_BEFORE '};
      await pause;
      yield {type: 'textDelta', text: 'PARENT_AFTER'};
    },
  });
  const ui = await openInk(client, {width: 120});
  try {
    await ui.submit('continue parent');
    await ui.waitFor('PARENT_BEFORE');
    emit({
      type: 'task.finished',
      parentSessionId: 'owner',
      delivery: 'steered',
      task: {id: 'child', kind: 'agent', description: 'CHILD_NOTICE', status: 'done', startedAt: '', outputTail: ''},
    });
    await ui.press('');
    resume();
    await ui.idle();
    expect(ui.frame()).toContain('PARENT_BEFORE PARENT_AFTER');
    expect(ui.frame()).toContain('CHILD_NOTICE');
    expect(ui.frame()).not.toContain('child. PARENT_AFTER');
  } finally {
    resume();
    await ui.close();
  }
});
