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
