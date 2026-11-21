/** Full shell over public SDK ports: no OS/provider success is simulated. */
import {expect, test} from 'bun:test';
import type {BackgroundTaskEvent, ModelEvent, WorkspaceDiffReport} from '@cosmew/contracts';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';

const report: WorkspaceDiffReport = {
  workspace: '/fixture',
  gitAvailable: true,
  files: [
    {
      path: 'a.txt',
      status: 'modified',
      layer: 'unstaged',
      additions: 1,
      deletions: 1,
      lines: [
        {type: 'del', oldLine: 1, newLine: null, content: 'old'},
        {type: 'add', oldLine: null, newLine: 1, content: 'new'},
      ],
    },
  ],
  totalAdditions: 1,
  totalDeletions: 1,
};
function fixture(extra: Parameters<typeof dialogFixture>[0] = {}) {
  return dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'p2-session', selection, messages: []}),
    ...extra,
  });
}
for (const width of [80, 109])
  test(`/diff at ${width} columns reports the resize requirement and leaves the composer available`, async () => {
    const {client} = fixture();
    const ui = await openInk(client, {width});
    try {
      await ui.executeSlashCommand('/diff');
      expect(ui.frame()).toContain('Resize your terminal to at least 110 columns');
      expect(ui.frame()).not.toContain('source: Current');
      await ui.type('draft after diff');
      expect(ui.frame()).toContain('draft after diff');
    } finally {
      await ui.close();
    }
  });

test('first successful change opens side diff, shrinks transcript, and /diff hides it', async () => {
  const {client} = fixture({
    getWorkspaceDiff: () => report,
    async *sendTurn(): AsyncIterable<ModelEvent> {
      yield {type: 'toolCallComplete', call: {id: 'e', name: 'edit', input: {path: 'a.txt'}}};
      yield {
        type: 'toolResult',
        result: {
          callId: 'e',
          name: 'edit',
          status: 'ok',
          content: JSON.stringify({changes: [{path: 'a.txt', action: 'update', diff: '@@ -1 +1 @@\n-old\n+new'}]}),
        },
      };
      yield {type: 'textDelta', text: 'Changed the file.'};
    },
  });
  const ui = await openInk(client, {width: 120, rows: 36});
  try {
    await ui.submit('edit it');
    await ui.idle();
    expect(ui.frame()).toContain('source: Current');
    expect(ui.frame()).toContain('│');
    expect(ui.frame().split('\n')).toHaveLength(36);
    for (const row of ui.frame().split('\n')) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(120);
    await ui.executeSlashCommand('/diff');
    expect(ui.frame()).not.toContain('source: Current');
    expect(ui.frame()).toContain('Diff panel hidden');
  } finally {
    await ui.close();
  }
});

test('/diff keeps the composer editable and can be toggled without a focus escape', async () => {
  const {client} = fixture({
    getWorkspaceDiff: () => report,
    async *sendTurn(_id, content): AsyncIterable<ModelEvent> {
      yield {type: 'textDelta', text: `Received: ${content}`};
    },
  });
  const ui = await openInk(client, {width: 120, rows: 36});
  try {
    await ui.executeSlashCommand('/diff');
    expect(ui.frame()).toContain('source: Current');
    await ui.type('draft after diff');
    expect(ui.frame()).toContain('draft after diff');
    await ui.handleKey('ArrowLeft');
    await ui.handleKey('Backspace');
    expect(ui.frame()).toContain('draft after dif');
    await ui.handleKey('Enter');
    await ui.idle();
    expect(ui.frame()).toContain('Received: draft after dif');
    expect(ui.frame()).toContain('source: Current');
    await ui.executeSlashCommand('/diff');
    expect(ui.frame()).not.toContain('source: Current');
    expect(ui.frame()).toContain('Diff panel hidden');
  } finally {
    await ui.close();
  }
});

test('/diff leaves transcript paging on the left while the panel stays open', async () => {
  const {client} = fixture({
    getWorkspaceDiff: () => report,
    async *sendTurn(): AsyncIterable<ModelEvent> {
      yield {type: 'textDelta', text: Array.from({length: 60}, (_, i) => `answer line ${i + 1}`).join('\n')};
    },
  });
  const ui = await openInk(client, {width: 120, rows: 36});
  try {
    await ui.submit('say a lot');
    await ui.idle();
    await ui.executeSlashCommand('/diff');
    expect(ui.frame()).toContain('answer line 60');
    await ui.handleKey('PageUp');
    expect(ui.frame()).toContain('Jump to bottom');
    expect(ui.frame()).not.toContain('answer line 60');
    expect(ui.frame()).toContain('source: Current');
    await ui.handleKey('PageDown');
    expect(ui.frame()).toContain('answer line 60');
  } finally {
    await ui.close();
  }
});

test('durably delivered background completion prints once, ignores another conversation, and does not start a UI-owned turn', async () => {
  let notify: ((event: BackgroundTaskEvent) => void) | undefined;
  const {client} = fixture({
    observeBackgroundTasks: listener => {
      notify = listener;
      return () => {};
    },
  });
  client.createSession();
  const ui = await openInk(client, {width: 100});
  try {
    const task = {
      id: 'task-1',
      kind: 'shell' as const,
      description: 'bun test',
      status: 'done' as const,
      startedAt: '',
      exitCode: 2,
      outputTail: '',
    };
    notify!({type: 'task.finished', task, parentSessionId: 'another', delivery: 'queued'});
    await ui.press('');
    expect(ui.frame()).not.toContain('Background command');
    notify!({type: 'task.finished', task, parentSessionId: 'p2-session', delivery: 'queued'});
    notify!({type: 'task.finished', task, parentSessionId: 'p2-session', delivery: 'queued'});
    await ui.press('');
    expect(ui.frame().match(/Background command "bun test" completed \(exit code 2\)/g)).toHaveLength(1);
    expect(client.activeSession()?.messages).toEqual([]);
  } finally {
    await ui.close();
  }
});

test('pending plan approval replaces composer at 80x12, and Escape cancels through the SDK turn', async () => {
  let client: ReturnType<typeof fixture>['client'];
  let outcome: string | undefined;
  const f = fixture({
    async *sendTurn(_id, _content, signal): AsyncIterable<ModelEvent> {
      try {
        await client.proposePlan('# Plan\n' + 'detail\n'.repeat(50), signal);
        outcome = 'approved';
      } catch {
        outcome = 'cancelled';
      }
    },
  });
  client = f.client;
  const ui = await openInk(client, {width: 80, rows: 12});
  try {
    client.setPermissionMode('plan');
    await ui.submit('plan it');
    await ui.waitFor('Ready to code?');
    expect(ui.frame()).toContain('1. Yes');
    expect(ui.frame()).toContain('2. Yes, manually approve edits');
    expect(ui.frame()).toContain('3. Tell Cosmew what to change');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    await ui.press('\x1b');
    await ui.idle();
    expect(outcome).toBe('cancelled');
    expect(client.pendingPlanApproval()).toBeNull();
    expect(client.permissionMode()).toBe('plan');
  } finally {
    await ui.close();
  }
});

test('send-now chord uses SDK queue transfer and delivers the interrupted inbox exactly once', async () => {
  let waiting: {steerId: string; content: string}[] = [];
  let inbox: {id: string; content: string}[] = [];
  const prompts: string[] = [];
  let transfers = 0;
  const {client} = fixture({
    queuedInput: () => waiting,
    listNextTurn: () => inbox,
    steerTurn: (_id, content) => {
      waiting.push({steerId: 'queued', content});
      return {accepted: true, steerId: 'queued', turnId: 'first'};
    },
    queueSteeringForNextTurn: () => {
      transfers++;
      inbox = waiting.map(item => ({id: item.steerId, content: item.content}));
      waiting = [];
    },
    async *sendTurn(_id, content, signal, _limit, _cost, _effort, queuedId): AsyncIterable<ModelEvent> {
      prompts.push(content);
      if (content === 'first') {
        yield {type: 'textDelta', text: 'Working on first'};
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), {once: true}));
      } else {
        inbox = inbox.filter(item => item.id !== queuedId);
        yield {type: 'textDelta', text: 'Delivered queued input'};
      }
    },
  });
  const ui = await openInk(client, {width: 100});
  try {
    await ui.submit('first');
    await ui.waitFor('Working on first');
    await ui.submit('second');
    expect(client.queuedInput().map(item => item.content)).toEqual(['second']);
    await ui.press('\x18');
    await ui.press('\x13');
    await ui.idle();
    expect(transfers).toBe(1);
    expect(prompts).toEqual(['first', 'second']);
    expect(client.queuedInput()).toEqual([]);
  } finally {
    await ui.close();
  }
});
