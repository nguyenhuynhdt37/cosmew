import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelEvent, ModelPort, ModelRequest, ToolPort} from '@cosmew/contracts';
import {COMPACTION_PROMPT, Conversation} from '@cosmew/core';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const done = (): ModelEvent => ({
  type: 'completed',
  finishReason: 'stop',
  usage: {inputTokens: 10, outputTokens: 5, costUSD: null},
});
const summary = (r: ModelRequest) => r.messages.at(-1)?.content.startsWith(COMPACTION_PROMPT.slice(0, 30));

function fixture(brain: (r: ModelRequest) => ModelEvent[], tools: ToolPort, parallelSlots?: number) {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-evidence-'));
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  const model: ModelPort = {
    async *stream(request) {
      yield* brain(request);
    },
    generate: async () => {
      throw new Error('not used');
    },
  };
  const conversation = new Conversation(
    {accountId: crypto.randomUUID(), modelId: 'fixture'},
    model,
    app.conversations,
    undefined,
    tools,
    undefined,
    undefined,
    {contextLimit: () => 5000, parallelSlots: parallelSlots === undefined ? undefined : () => parallelSlots},
  );
  return {
    conversation,
    app,
    send: async () => {
      const out: ModelEvent[] = [];
      for await (const e of conversation.send('Investigate evidence')) out.push(e);
      return out;
    },
  };
}
const descriptor = {
  name: 'read',
  description: 'read',
  inputSchema: {type: 'object'},
  capability: 'fs.read' as const,
  parallel: true,
};

test('a reread restores exact small evidence removed by a mid-turn summary', async () => {
  let reads = 0,
    summaries = 0;
  const requests: ModelRequest[] = [];
  const h = fixture(
    request => {
      requests.push(request);
      if (summary(request)) {
        summaries++;
        return [{type: 'textDelta', text: 'Files inspected; exact evidence omitted'}, done()];
      }
      if (reads === 7) return [{type: 'textDelta', text: 'finished'}, done()];
      reads++;
      return [
        {
          type: 'toolCallComplete',
          call: {id: `r${reads}`, name: 'read', input: {path: reads === 7 ? 'file1' : `file${reads}`}},
        },
        done(),
      ];
    },
    {
      descriptors: () => [descriptor],
      invoke: async call => ({
        callId: call.id,
        name: call.name,
        status: 'ok',
        content: `exact-evidence-${(call.input as {path: string}).path} ` + 'x'.repeat(1800),
      }),
    },
  );
  const events = await h.send();
  expect(summaries).toBeGreaterThan(0);
  const afterSummary = requests.slice(requests.findIndex(summary) + 1).filter(r => !summary(r));
  expect(afterSummary.some(r => !r.messages.some(m => m.content.includes('exact-evidence-file1')))).toBe(true);
  const reread = events.find(e => e.type === 'toolResult' && e.result.callId === 'r7');
  expect(reread?.type === 'toolResult' && reread.result.content).toStartWith('exact-evidence-file1');
  expect(JSON.stringify(h.app.conversations.recover(h.conversation.id).messages)).toContain('exact-evidence-file1');
});

test.each([1, 2, 6])('configured %i shared slots cap actual tool execution', async slots => {
  let running = 0,
    peak = 0,
    requests = 0;
  const h = fixture(
    () =>
      ++requests > 1
        ? [{type: 'textDelta', text: 'finished'}, done()]
        : [
            ...Array.from({length: 6}, (_, i): ModelEvent => ({
              type: 'toolCallComplete',
              call: {id: `p${i}`, name: 'read', input: {path: `f${i}`}},
            })),
            done(),
          ],
    {
      descriptors: () => [descriptor],
      invoke: async call => {
        peak = Math.max(peak, ++running);
        await Bun.sleep(5);
        running--;
        return {callId: call.id, name: call.name, status: 'ok', content: call.id};
      },
    },
    slots,
  );
  await h.send();
  expect(peak).toBe(slots);
});

test('large dispatcher rereads dedup canonical bytes while preserving a fresh retrievable archive', async () => {
  const {writeFileSync} = await import('node:fs');
  const {Database} = await import('bun:sqlite');
  const {WorkspaceRoot} = await import('@cosmew/workspace');
  const {ToolDispatcher} = await import('@cosmew/tools');
  const {SessionGrants} = await import('@cosmew/security');
  const {SqliteToolOutputArchive} = await import('@cosmew/persistence');
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-canonical-'));
  const db = new Database(':memory:');
  cleanup.push(() => {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  });
  writeFileSync(join(dir, 'large.txt'), 'same evidence\n'.repeat(2300));
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(dir),
    grants: new SessionGrants(),
    approve: async () => 'once',
    redact: x => x,
    outputArchive: {
      store: new SqliteToolOutputArchive(db),
      scope: () => ({workspace: dir, session: 's'}),
      permissionContext: () => 'rules',
    },
  });
  const {TurnTools, toolMessage} = await import('../../packages/core/src/agent/turn-tools');
  const {ProgressQueue} = await import('../../packages/core/src/agent/progress-queue');
  const tools = new TurnTools({
    port: dispatcher,
    budget: {},
    signal: new AbortController().signal,
    progress: new ProgressQueue(),
    parallelSlots: 4,
    record: () => 1,
    workExhausted: () => undefined,
    onSettled: () => {},
  });
  const call = (id: string) => ({id, name: 'read', input: {path: 'large.txt', limit: 2000}});
  const first = await tools.run(call('a'));
  const second = await tools.run(call('b'));
  expect(second.content).toStartWith('[unchanged]');
  const id = second.content.match(/output_id=([\w-]+)/)?.[1];
  expect(id).toBeDefined();
  expect(id).not.toBe(first.content.match(/output_id=([\w-]+)/)?.[1]);
  const retrieved = await dispatcher.invoke({id: 'page', name: 'tool_output', input: {output_id: id}});
  expect(retrieved.status).toBe('ok');
  expect(retrieved.content).toContain('same evidence');
  writeFileSync(join(dir, 'large.txt'), 'changed evidence\n'.repeat(2300));
  const changed = await tools.run(call('c'));
  expect(changed.content).not.toStartWith('[unchanged]');
  expect(toolMessage(call('c'), changed).content).toContain('changed evidence');
});

test('visible evidence dedups, clipped/removed evidence and changed media restore fresh results', async () => {
  const {TurnTools, toolMessage} = await import('../../packages/core/src/agent/turn-tools');
  const {ProgressQueue} = await import('../../packages/core/src/agent/progress-queue');
  let data = 'AQ==',
    invoked = 0;
  const tools = new TurnTools({
    port: {
      descriptors: () => [descriptor],
      invoke: async call => {
        invoked++;
        return {
          callId: call.id,
          name: call.name,
          status: 'ok',
          content: 'same summary',
          attachments: [{mime: 'image/png', name: 'image.png', data}],
        };
      },
    },
    budget: {},
    signal: new AbortController().signal,
    progress: new ProgressQueue(),
    parallelSlots: 4,
    record: () => 1,
    workExhausted: () => undefined,
    onSettled: () => {},
  });
  const call = (id: string) => ({id, name: 'read', input: {path: 'image.png'}});
  const first = await tools.run(call('a'));
  tools.retainVisibleEvidence([toolMessage(call('a'), first)]);
  expect((await tools.run(call('b'))).content).toStartWith('[unchanged]');
  data = 'Ag==';
  const changed = await tools.run(call('c'));
  expect(changed.attachments?.[0]?.data).toBe('Ag==');
  tools.retainVisibleEvidence([{...toolMessage(call('c'), changed), content: 'clipped'}]);
  expect((await tools.run(call('d'))).attachments?.[0]?.data).toBe('Ag==');
  tools.retainVisibleEvidence([]);
  expect((await tools.run(call('e'))).content).toBe('same summary');
  expect(invoked).toBe(5); // suppression never skips fresh policy/producer execution
});
