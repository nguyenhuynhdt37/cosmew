import {expect, test} from 'bun:test';
import {type Message, type SessionRecord} from '@cosmew/contracts';
import {dialogFixture, selection, session} from '../../apps/tui/src/ink/features/picker/test-fixture';

test('SDK session views omit private provider continuation while backend history keeps it', () => {
  const message: Message = {
    role: 'assistant',
    content: 'Visible answer',
    providerReplay: {
      version: 1,
      providerId: 'sample',
      accountId: selection.accountId,
      protocol: 'responses',
      modelId: selection.modelId,
      endpointHash: 'a'.repeat(64),
      parts: [{type: 'reasoning', text: '', metadata: {reasoningEncryptedContent: 'PRIVATE_REPLAY_MARKER'}}],
    },
  };
  const stored: SessionRecord = {
    ...session,
    messages: [{...message, revision: 1, state: 'committed'}],
    recovery: {messages: [message], turns: []},
  };
  const backendSession = {id: session.id, selection, messages: [message]};
  const {client} = dialogFixture({
    getSession: () => stored,
    startSession: () => backendSession,
    resumeSession: () => backendSession,
    forkSession: () => ({...backendSession, id: 'fork'}),
  });
  const publicViews = [
    client.getSession(session.id),
    client.createSession(),
    client.activeSession(),
    client.resumeSession(session.id),
    client.forkSession(session.id),
  ];
  for (const view of publicViews) {
    expect(JSON.stringify(view)).toContain('Visible answer');
    expect(JSON.stringify(view)).not.toContain('PRIVATE_REPLAY_MARKER');
    expect(JSON.stringify(view)).not.toContain('providerReplay');
  }
  expect(stored.messages[0]!.providerReplay?.parts[0]).toMatchObject({
    metadata: {reasoningEncryptedContent: 'PRIVATE_REPLAY_MARKER'},
  });
  expect(backendSession.messages[0]!.providerReplay).toBeDefined();
});
