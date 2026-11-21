import {expect, test} from 'bun:test';
import type {FutrynBackendPorts} from '@cosmew/sdk';
import {child, dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';

test('out-of-turn lifecycle updates a child screen while the parent is idle and retracts discarded text', async () => {
  let publish!: Parameters<NonNullable<FutrynBackendPorts['observeSubagentEvents']>>[0];
  let providerCalls = 0;
  const live = {...child, parentConversationId: 'parent', steps: [] as typeof child.steps, summary: ''};
  const {client} = dialogFixture({
    startSession: () => ({id: 'parent', selection, messages: []}),
    subagents: () => [live],
    observeSubagentEvents: listener => {
      publish = listener;
      return () => {};
    },
    async *sendTurn() {
      providerCalls++;
    },
  });
  client.createSession();
  const ui = await openInk(client, {width: 80});
  const update = () =>
    publish({
      parentSessionId: 'parent',
      event: {
        type: 'subagent.progress',
        callId: live.callId,
        agentId: live.id,
        agentType: live.agentType,
        description: live.description,
        background: true,
        toolCount: 0,
        usage: null,
        steps: structuredClone(live.steps),
      },
    });
  try {
    await ui.handleKey('ArrowDown');
    await ui.handleKey('Enter');
    await ui.waitFor('Main chat / Agent');
    live.steps = [{kind: 'text', text: 'LIVE_FIRST'}];
    update();
    await ui.waitFor('LIVE_FIRST');
    live.steps = [{kind: 'text', text: 'LIVE_FIRST THEN_SECOND'}];
    update();
    await ui.waitFor('THEN_SECOND');
    expect(ui.frame().match(/LIVE_FIRST/g)).toHaveLength(1);
    live.steps = [];
    update();
    await ui.waitFor('Waiting for agent activity');
    expect(ui.frame()).not.toContain('LIVE_FIRST');
    expect(providerCalls).toBe(0);
    expect(client.activeSession()?.id).toBe('parent');
  } finally {
    await ui.close();
  }
});
