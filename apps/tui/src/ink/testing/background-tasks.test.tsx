import {expect, test} from 'bun:test';
import type {ModelEvent, SubagentSummaryView} from '@cosmew/contracts';
import {child, dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';

test('short narrow task area keeps the selected child visible and opens that child', async () => {
  const children = Array.from({length: 4}, (_, i) => ({
    ...child,
    id: `child-${i}`,
    background: false,
    description: `JOB_${i}`,
    steps: [{kind: 'text' as const, text: `OUTPUT_${i}`}],
  }));
  const {client} = dialogFixture({
    startSession: () => ({id: 'owner', selection, messages: []}),
    subagents: () => children,
  });
  client.createSession();
  const ui = await openInk(client, {width: 40, rows: 16});
  try {
    await ui.handleKey('ArrowDown');
    for (let i = 0; i < 3; i++) await ui.handleKey('ArrowRight');
    expect(ui.frame()).toContain('JOB_3');
    expect(ui.frame().split('\n')).toHaveLength(16);
    await ui.handleKey('Enter');
    await ui.handleKey('Enter');
    await ui.waitFor('OUTPUT_3');
    expect(ui.frame()).not.toContain('OUTPUT_0');
    await ui.handleKey('Escape');
    await ui.handleKey('Escape');
    await ui.type('draft');
    expect(ui.frame()).toContain('draft');
  } finally {
    await ui.close();
  }
});

test('Down discovers a foreground child while chatting, opens its output and stops through the agent port', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  const stopped: string[] = [];
  const live: SubagentSummaryView = {
    ...child,
    parentConversationId: 'owner',
    background: false,
    description: 'Inspect live module',
    steps: [{kind: 'text', text: 'PRIVATE_CHILD_OUTPUT'}],
  };
  let calls = 0;
  const {client} = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'owner', selection, messages: []}),
    subagents: () => [live],
    stopSubagent: id => {
      stopped.push(id);
      return true;
    },
    async *sendTurn(): AsyncIterable<ModelEvent> {
      calls++;
      yield {type: 'textDelta', text: 'Main response continues.'};
      await pending;
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 1, costUSD: null}};
    },
  });
  client.createSession();
  const ui = await openInk(client, {width: 80});
  try {
    await ui.submit('work');
    await ui.waitFor('Main response continues.');
    expect(ui.frame()).toContain('Inspect live module');
    expect(ui.frame().match(/Inspect live module/g)).toHaveLength(1);
    expect(ui.frame()).toContain('↓ to manage');
    expect(ui.frame()).not.toContain('PRIVATE_CHILD_OUTPUT');
    await ui.handleKey('ArrowDown');
    expect(ui.frame()).toContain('agent 1/1');
    await ui.handleKey('Enter');
    await ui.waitFor('Inspect live module');
    expect(ui.frame()).toContain('Background tasks');
    await ui.handleKey('Enter');
    await ui.waitFor('PRIVATE_CHILD_OUTPUT');
    live.steps.push({kind: 'text', text: 'LATEST_CHILD_OUTPUT'});
    client.emitReactiveEvent('subagent.progress');
    await ui.waitFor('LATEST_CHILD_OUTPUT');
    await ui.handleKey('Escape');
    await ui.handleKey('Escape');
    expect(stopped).toEqual([]);
    expect(ui.frame()).toContain('esc to interrupt');
    await ui.handleKey('ArrowDown');
    await ui.handleKey('Enter');
    await ui.handleKey('Enter');
    await ui.waitFor('LATEST_CHILD_OUTPUT');
    await ui.type('x');
    expect(stopped).toEqual([child.id]);
    expect(calls).toBe(1);
  } finally {
    finish();
    await ui.idle();
    await ui.close();
  }
});

test('/tasks can inspect an agent while the main response is still running', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  let calls = 0;
  const {client} = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'owner', selection, messages: []}),
    backgroundTasks: () => [
      {
        id: 'child',
        kind: 'agent',
        status: 'running',
        description: 'Inspect module',
        outputTail: 'AGENT_OUTPUT',
        startedAt: '',
      },
    ],
    async *sendTurn(): AsyncIterable<ModelEvent> {
      calls++;
      yield {type: 'textDelta', text: 'Main task is running.'};
      await pending;
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 1, costUSD: null}};
    },
  });
  client.createSession();
  const ui = await openInk(client, {width: 80});
  try {
    await ui.submit('work');
    await ui.waitFor('Main task is running.');
    await ui.executeSlashCommand('/tasks');
    expect(ui.frame()).toContain('Inspect module');
    await ui.handleKey('Enter');
    await ui.waitFor('AGENT_OUTPUT');
    expect(calls).toBe(1);
    finish();
    await ui.idle();
  } finally {
    finish();
    await ui.close();
  }
});

for (const width of [40, 80])
  test(`/tasks opens real background output and returns to the prompt at ${width} columns`, async () => {
    let calls = 0;
    const {client} = dialogFixture({
      startSession: () => ({id: 'task-owner', selection, messages: []}),
      backgroundTasks: () => [
        {
          id: 'finished',
          kind: 'shell',
          status: 'done',
          description: 'Build project',
          outputTail: 'BUILD_OUTPUT',
          exitCode: 0,
          startedAt: '',
        },
      ],
      async *sendTurn() {
        calls++;
      },
    });
    client.createSession();
    const ui = await openInk(client, {width, rows: 16});
    try {
      await ui.executeSlashCommand('/tasks');
      expect(ui.frame()).toContain('Background tasks');
      expect(ui.frame()).toContain('Build project');
      await ui.handleKey('Enter');
      await ui.waitFor('BUILD_OUTPUT');
      expect(ui.frame()).toContain('exit 0');
      expect(ui.frame().split('\n')).toHaveLength(16);
      for (const line of ui.frame().split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      await ui.handleKey('Escape');
      await ui.handleKey('Escape');
      await ui.type('draft after tasks');
      expect(ui.frame()).toContain('draft after tasks');
      expect(calls).toBe(0);
    } finally {
      await ui.close();
    }
  });
