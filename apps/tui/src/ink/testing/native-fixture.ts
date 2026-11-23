import {runInkTui} from '../runtime';
import {dialogFixture, selection} from '../features/picker/test-fixture';

// Synthetic public SDK ports: exercises the real terminal, with no provider or tool process.
const plan = {
  updatedAt: '2026-11-19T00:00:00Z',
  items: [{step: 'NATIVE_LIVE_TODO', status: 'in_progress' as const}],
};
const {client} = dialogFixture({
  validateAccount: async () => ({models: 1, validation: 'synthetic'}),
  startSession: () => ({
    id: 'synthetic-resume',
    selection,
    messages: [
      {role: 'user', content: 'SYNTHETIC_HISTORY_ONCE'},
      {
        role: 'assistant',
        content: 'Synthetic replay\n' + Array.from({length: 60}, (_, index) => `NATIVE_REPLAY_ROW_${index}`).join('\n'),
        toolCalls: [{id: 'read-history', name: 'read', input: {path: 'note.txt'}}],
      },
      {role: 'tool', toolCallId: 'read-history', toolName: 'read', content: '1\tsafe historical line'},
    ],
  }),
  getPlan: () => plan,
  compactSession: async () => {
    await Bun.sleep(120);
    return {compacted: true, strategy: 'model', tokensBefore: 2000, tokensAfter: 500, usage: null};
  },
  async *sendTurn(_id, _content, signal) {
    yield {type: 'toolCallComplete', call: {id: 'read-live', name: 'read', input: {path: '.env'}}};
    const decision = await client.requestPermission(
      {
        capability: 'fs.read',
        action: 'Read .env',
        target: '.env',
        reason: 'Synthetic permission scope check',
        kind: 'secret',
        decisions: ['once', 'session'],
      },
      signal,
    );
    yield {
      type: 'toolResult',
      result: {callId: 'read-live', name: 'read', status: decision === 'deny' ? 'denied' : 'ok', content: decision},
    };
    yield {type: 'textDelta', text: 'NATIVE_STREAM_READY'};
    await new Promise<void>(resolve => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), {once: true});
    });
  },
});
client.createSession();
// The first paint precedes Ink's passive input subscriptions. Signal the parent
// only once raw input is installed, so a busy suite cannot type into canonical mode.
const ready = setInterval(() => {
  if (!process.stdin.isRaw) return;
  clearInterval(ready);
  process.stderr.write('NATIVE_INPUT_READY\n');
}, 10);
try {
  await runInkTui({client});
} finally {
  clearInterval(ready);
}
