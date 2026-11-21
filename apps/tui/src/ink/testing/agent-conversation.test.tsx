import {expect, test} from 'bun:test';
import type {StoredMessage} from '@cosmew/contracts';
import {child, dialogFixture, selection, session} from '../features/picker/test-fixture';
import {openInk} from './ink-session';

for (const width of [40, 80])
  test(`agent opens a full chat with real tool arguments/history at ${width} columns`, async () => {
    const messages: StoredMessage[] = [
      {role: 'user', content: 'CHILD_ORIGINAL_PROMPT', revision: 1, state: 'committed'},
      {
        role: 'assistant',
        content: '## Inspecting the module',
        toolCalls: [{id: 'read', name: 'read', input: {path: 'src/actual.ts'}}],
        revision: 1,
        state: 'committed',
      },
      {
        role: 'tool',
        toolName: 'read',
        toolCallId: 'read',
        content: 'ACTUAL_FULL_TOOL_RESULT',
        revision: 1,
        state: 'committed',
      },
      {role: 'assistant', content: 'CHILD_LATEST_REPLY', revision: 1, state: 'committed'},
    ];
    let providerCalls = 0;
    const queried: string[] = [];
    const {client} = dialogFixture({
      startSession: () => ({id: 'parent', selection, messages: [{role: 'assistant', content: 'PARENT_ONLY_CONTEXT'}]}),
      subagents: () => [{...child, parentConversationId: 'parent', steps: [], summary: ''}],
      getSession: id => {
        queried.push(id);
        return id === child.id ? {...session, id, messages} : undefined;
      },
      async *sendTurn() {
        providerCalls++;
      },
    });
    client.createSession();
    const ui = await openInk(client, {width, rows: 24});
    try {
      expect(ui.frame()).toContain('PARENT_ONLY_CONTEXT');
      await ui.handleKey('ArrowDown');
      await ui.handleKey('Enter');
      await ui.waitFor('Main chat / Agent');
      expect(ui.frame().split('\n')[0]).toContain('Main chat / Agent');
      expect(ui.frame()).not.toContain('PARENT_ONLY_CONTEXT');
      await ui.waitFor('CHILD_LATEST_REPLY');
      await ui.handleKey('\x0f');
      await ui.handleKey('\x1b[H');
      await ui.waitFor('CHILD_ORIGINAL_PROMPT');
      expect(ui.frame()).toContain('Read(src/actual.ts)');
      expect(ui.frame()).toContain('ACTUAL_FULL_TOOL_RESULT');
      expect(ui.frame().split('\n')).toHaveLength(24);
      for (const line of ui.frame().split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      const beforeScroll = queried.length;
      await ui.handleKey('ArrowDown');
      expect(queried.length).toBe(beforeScroll);
      expect(client.activeSession()?.id).toBe('parent');
      expect(providerCalls).toBe(0);
      await ui.handleKey('Escape');
      expect(ui.frame()).toContain('PARENT_ONLY_CONTEXT');
      await ui.type('PARENT_DRAFT');
      expect(ui.frame()).toContain('PARENT_DRAFT');
      expect(client.activeSession()?.id).toBe('parent');
    } finally {
      await ui.close();
    }
  });

test('agent history scrolls past 8KB, follows updates, and disappears on parent session switch', async () => {
  const messages: StoredMessage[] = Array.from({length: 35}, (_, i) => ({
    role: 'assistant',
    content: `HISTORY_${i}\n${'recorded content '.repeat(20)}`,
    revision: 1,
    state: 'committed',
  }));
  let created = 0;
  const {client} = dialogFixture({
    startSession: () => ({id: ++created === 1 ? 'first-parent' : 'second-parent', selection, messages: []}),
    subagents: owner =>
      owner === 'first-parent' ? [{...child, parentConversationId: owner, steps: [], summary: ''}] : [],
    getSession: id => (id === child.id ? {...session, id, messages} : undefined),
  });
  client.createSession();
  const ui = await openInk(client, {width: 80, rows: 24});
  try {
    await ui.handleKey('ArrowDown');
    await ui.handleKey('Enter');
    await ui.waitFor('HISTORY_34');
    await ui.handleKey('\x1b[H');
    await ui.waitFor('HISTORY_0');
    messages.push({role: 'assistant', content: 'NEW_AGENT_REPLY', revision: 1, state: 'committed'});
    client.emitReactiveEvent('subagent.progress');
    await ui.idle();
    expect(ui.frame()).not.toContain('NEW_AGENT_REPLY');
    await ui.handleKey('\x1b[F');
    await ui.waitFor('NEW_AGENT_REPLY');
    client.createSession();
    await ui.waitFor('No background tasks');
    expect(ui.frame()).not.toContain('NEW_AGENT_REPLY');
    expect(ui.frame()).not.toContain('Main chat / Agent');
  } finally {
    await ui.close();
  }
}, 15000);

test('footer opens directly, switches siblings, retains tool expansion and scroll, and Esc preserves parent work', async () => {
  const children = [0, 1].map(i => ({
    ...child,
    id: `child-${i}`,
    parentConversationId: 'parent',
    description: `JOB_${i}`,
    steps: [],
    summary: '',
  }));
  const messages: StoredMessage[] = [
    {
      role: 'assistant',
      content: 'CHILD_TOP',
      toolCalls: [{id: 'read', name: 'read', input: {path: 'source.ts'}}],
      revision: 1,
      state: 'committed',
    },
    {
      role: 'tool',
      toolName: 'read',
      toolCallId: 'read',
      content: 'EXPANDED_RESULT\n' + 'tool line\n'.repeat(18),
      revision: 1,
      state: 'committed',
    },
    ...Array.from({length: 20}, (_, i): StoredMessage => ({
      role: 'assistant',
      content: `CHILD_ROW_${i}`,
      revision: 1,
      state: 'committed',
    })),
  ];
  const stopped: string[] = [];
  let turns = 0;
  const {client} = dialogFixture({
    startSession: () => ({id: 'parent', selection, messages: [{role: 'assistant', content: 'PARENT_CONTEXT'}]}),
    subagents: owner => (owner === 'parent' ? children : []),
    getSession: id => ({
      ...session,
      id,
      messages:
        id === 'child-0' ? messages : [{role: 'assistant', content: 'SECOND_CHILD', revision: 1, state: 'committed'}],
    }),
    stopSubagent: id => {
      stopped.push(id);
      return true;
    },
    async *sendTurn() {
      turns++;
    },
  });
  client.createSession();
  const ui = await openInk(client, {width: 100, rows: 24});
  try {
    await ui.handleKey('ArrowDown');
    await ui.handleKey('Enter');
    expect(ui.frame()).toContain('Main chat / Agent');
    expect(ui.frame()).not.toContain('Background tasks & agents');
    await ui.handleKey('\x1b[H');
    await ui.handleKey('\x1b[1;3B'); // central Transcript focus-next (Alt+Down)
    await ui.handleKey('\x1b\r'); // central Transcript toggle (Alt+Enter)
    expect(ui.frame()).toContain('EXPANDED_RESULT');
    await ui.handleKey('ArrowRight');
    expect(ui.frame()).toContain('SECOND_CHILD');
    expect(ui.frame()).toContain('agent 2/2');
    await ui.handleKey('ArrowLeft');
    expect(ui.frame()).toContain('EXPANDED_RESULT');
    expect(ui.frame()).toContain('CHILD_TOP');
    await ui.handleKey('Escape');
    expect(ui.frame()).toContain('PARENT_CONTEXT');
    expect(client.activeSession()?.id).toBe('parent');
    expect(stopped).toEqual([]);
    expect(turns).toBe(0);
  } finally {
    await ui.close();
  }
});

test('explicit compose sends only selected child, consumes stop/navigation keys, and retains a denied draft across permission overlays', async () => {
  let client: ReturnType<typeof dialogFixture>['client'];
  const sent: {id: string; text: string}[] = [];
  const stopped: string[] = [];
  const selectedChild = {...child, parentConversationId: 'parent'};
  const fixture = dialogFixture({
    startSession: () => ({id: 'parent', selection, messages: []}),
    subagents: () => [selectedChild],
    stopSubagent: id => {
      stopped.push(id);
      return true;
    },
    sendSubagentMessage: async (_owner, id, text, signal) => {
      sent.push({id, text});
      const answer = await client.requestPermission(
        {
          capability: 'agent.spawn',
          kind: 'other',
          ruleTool: 'Tool',
          ruleTarget: 'agent_message',
          action: 'Send child instruction',
          target: id,
          reason: 'Explicit follow-up',
        },
        signal,
      );
      return {
        callId: 'send',
        name: 'agent_message',
        status: answer === 'deny' ? 'denied' : 'ok',
        content: answer === 'deny' ? 'Denied by user.' : '{"delivery":"steered"}',
      };
    },
  });
  client = fixture.client;
  client.createSession();
  client.setPromptsAvailable(true);
  const ui = await openInk(client, {width: 100, rows: 24});
  try {
    await ui.handleKey('ArrowDown');
    await ui.handleKey('Enter');
    await ui.waitFor('Main chat / Agent');
    selectedChild.status = 'completed';
    client.emitReactiveEvent('subagent.finished');
    expect(sent).toEqual([]); // viewing a completed child never resumes it
    await ui.type('i');
    await ui.type('follow x');
    await ui.handleKey('ArrowLeft');
    expect(stopped).toEqual([]);
    expect(sent).toEqual([]);
    await ui.handleKey('Enter');
    await ui.waitFor('Send child instruction');
    expect(sent).toEqual([{id: child.id, text: 'follow x'}]);
    const prompt = client.listPendingPermissions()[0]!;
    client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'deny');
    await Bun.sleep(30);
    await ui.idle();
    if (!ui.frame().includes('Main chat / Agent')) {
      selectedChild.status = 'running';
      client.emitReactiveEvent('subagent.progress');
      await ui.idle();
      await ui.handleKey('ArrowDown');
      await ui.handleKey('Enter');
    }
    expect(ui.frame()).toContain('Denied by user');
    await ui.handleKey('i');
    await ui.waitFor('Message: follow x');
    await ui.handleKey('Escape');
    await ui.handleKey('i');
    expect(ui.frame()).toContain('Message: follow x');
    client.addPermissionRule('allow', 'Tool(agent_message)');
    await ui.handleKey('Enter');
    await ui.waitFor('delivery');
    expect(sent).toHaveLength(2);
    expect(client.activeSession()?.id).toBe('parent');
    expect(stopped).toEqual([]);
  } finally {
    await ui.close();
  }
}, 15000);
