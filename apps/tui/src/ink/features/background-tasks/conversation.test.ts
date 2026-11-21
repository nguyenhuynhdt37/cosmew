import {expect, test} from 'bun:test';
import type {StoredMessage} from '@cosmew/contracts';
import {child, dialogFixture, session} from '../picker/test-fixture';
import {childConversation} from './conversation';

test('stored tool arguments and full result take precedence over abbreviated activity snapshots', () => {
  const messages: StoredMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{id: 'call', name: 'exec_command', input: {cmd: 'echo actual-command', yield_time_ms: 1000}}],
      revision: 1,
      state: 'committed',
    },
    {
      role: 'tool',
      toolName: 'exec_command',
      toolCallId: 'call',
      content: 'LONG_RESULT_' + 'x'.repeat(9000),
      revision: 1,
      state: 'committed',
    },
  ];
  const {client} = dialogFixture({getSession: id => ({...session, id, messages})});
  const view = childConversation(client, {
    ...child,
    steps: [
      {kind: 'tool', callId: 'call', toolName: 'exec_command', target: 'abbreviated', status: 'ok', output: 'short'},
    ],
  });
  expect(view.snapshot).toBe(false);
  expect(view.items).toHaveLength(1);
  expect(view.items[0]!.toolCalls?.[0]?.input).toEqual({cmd: 'echo actual-command', yield_time_ms: 1000});
  expect(view.items[0]!.toolResults?.[0]?.content.length).toBeGreaterThan(8192);
});

test('pending recorded calls remain running and progress can complete them without duplicating the call', () => {
  const messages: StoredMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{id: 'call', name: 'read', input: {path: 'a.ts'}}],
      revision: 1,
      state: 'pending',
    },
  ];
  const {client} = dialogFixture({getSession: id => ({...session, id, messages})});
  const running = childConversation(client, {...child, steps: []});
  expect(running.items[0]!.streaming).toBe(true);
  const done = childConversation(client, {
    ...child,
    steps: [{kind: 'tool', callId: 'call', toolName: 'read', status: 'denied', output: 'Denied by policy'}],
  });
  expect(done.items).toHaveLength(1);
  expect(done.items[0]!.toolResults?.[0]?.status).toBe('denied');
  expect(messages[0]).not.toHaveProperty('toolResults');
});
