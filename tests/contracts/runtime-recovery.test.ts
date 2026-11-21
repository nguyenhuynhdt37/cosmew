import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Conversation} from '@cosmew/core';
import {FutrynError, type ModelPort, type ModelRequest, type ToolPort, type Message} from '@cosmew/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'hannes-recovery-'));
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  return app;
}
const usage = {inputTokens: 10, outputTokens: 5, costUSD: null};
const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
const tools: ToolPort = {
  descriptors: () => [{name: 'read', description: 'Read', inputSchema: {type: 'object'}, capability: 'fs.read'}],
  invoke: async call => ({
    callId: call.id,
    name: call.name,
    status: 'ok',
    content: 'Existing project uses a standalone HTML file; helo.html does not exist.',
  }),
};
async function send(c: Conversation, text: string) {
  for await (const _ of c.send(text)) {
  }
}
function model(step: (request: ModelRequest) => AsyncIterable<import('@cosmew/contracts').ModelEvent>): ModelPort {
  return {
    stream: step,
    generate: async () => {
      throw new FutrynError('UNSUPPORTED');
    },
  };
}

test('read → provider timeout preserves the original HTML objective and exact tool evidence on continuation', async () => {
  const app = setup();
  let requests = 0;
  let recovered: ModelRequest | undefined;
  const port = model(async function* (request) {
    requests++;
    if (requests === 1) {
      yield {type: 'textDelta', text: 'I will inspect the project, then create helo.html.'};
      yield {type: 'toolCallComplete', call: {id: 'read-1', name: 'read', input: {path: 'README.md'}}};
      yield {type: 'completed', finishReason: 'tool_calls', usage};
      return;
    }
    if (requests === 2) throw new FutrynError('TIMEOUT');
    recovered = request;
    yield {type: 'textDelta', text: 'Resuming the unfinished HTML artifact.'};
    yield {type: 'completed', finishReason: 'stop', usage};
  });
  const c = new Conversation(selection, port, app.conversations, undefined, tools);
  await expect(send(c, 'Create helo.html, a beautiful standalone sales landing page.')).rejects.toMatchObject({
    code: 'TIMEOUT',
  });
  await send(c, 'tiếp');
  expect(recovered!.messages.some(m => m.role === 'user' && m.content.includes('beautiful standalone sales'))).toBe(
    true,
  );
  expect(recovered!.messages.find(m => m.toolCallId === 'read-1')?.content).toContain('helo.html does not exist');
  expect(app.conversations.get(c.id)!.recovery!.messages.some(m => m.content.includes('I will inspect'))).toBe(true);
});

test('restart reconstructs interrupted read evidence instead of loading only completed turns', async () => {
  const app = setup();
  let count = 0;
  const c = new Conversation(
    selection,
    model(async function* () {
      if (count++ === 0) {
        yield {type: 'toolCallComplete', call: {id: 'read-restart', name: 'read', input: {path: 'README.md'}}};
        yield {type: 'completed', finishReason: 'tool_calls', usage};
      } else throw new FutrynError('TRANSPORT');
    }),
    app.conversations,
    undefined,
    tools,
  );
  await expect(send(c, 'Create helo.html with a pricing section.')).rejects.toMatchObject({code: 'TRANSPORT'});
  const restored = new Conversation(
    selection,
    model(async function* () {}),
    app.conversations,
    {id: c.id, messages: app.conversations.get(c.id)!.messages.filter(m => m.state === 'committed')},
    tools,
  );
  expect(restored.history().some(m => m.content.includes('pricing section'))).toBe(true);
  expect(restored.history().some(m => m.role === 'tool' && m.toolCallId === 'read-restart')).toBe(true);
});

test('missing tool outcomes become explicit unknown evidence and never trigger execution during reconstruction', async () => {
  const app = setup();
  const history: Message[] = [
    {role: 'user', content: 'Create helo.html'},
    {
      role: 'assistant',
      content: '',
      toolCalls: [{id: 'uncertain-write', name: 'apply_patch', input: {patch: 'proposal'}}],
    },
  ];
  let observed: ModelRequest | undefined;
  const id = app.conversations.create(selection);
  const c = new Conversation(
    selection,
    model(async function* (request) {
      observed = request;
      yield {type: 'textDelta', text: 'I must inspect before another write.'};
      yield {type: 'completed', finishReason: 'stop', usage};
    }),
    app.conversations,
    {id, messages: history},
    tools,
  );
  await send(c, 'continue');
  const outcome = observed!.messages.find(m => m.toolCallId === 'uncertain-write');
  expect(outcome).toBeDefined();
  expect(outcome!.content).toContain('unknown');
});

test('invalid tool results cannot become successful evidence or break call-ID pairing', async () => {
  const app = setup();
  let invoked = 0;
  const port = model(async function* () {
    yield {type: 'toolCallComplete', call: {id: 'expected-call', name: 'read', input: {path: 'README.md'}}};
    yield {type: 'completed', finishReason: 'tool_calls', usage};
  });
  const malformed: ToolPort = {
    descriptors: tools.descriptors,
    invoke: async () => {
      invoked++;
      return {callId: 'wrong-call', name: 'read', status: 'ok', content: 'fabricated'};
    },
  };
  const c = new Conversation(selection, port, app.conversations, undefined, malformed);
  await expect(send(c, 'Explain README.md')).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(invoked).toBe(1);
  const stored = app.conversations.get(c.id)!.recovery!;
  expect(stored.messages.some(m => m.toolCallId === 'wrong-call')).toBe(false);
  expect(stored.messages.find(m => m.toolCallId === 'expected-call')!.content).toContain('EXECUTION_UNKNOWN');
});

test('a duplicate call id fails the response without a second execution; the first complete call keeps its real result', async () => {
  const app = setup();
  let invoked = 0;
  const call = {id: 'duplicate', name: 'read', input: {path: 'README.md'}};
  const c = new Conversation(
    selection,
    model(async function* () {
      yield {type: 'toolCallComplete', call};
      yield {type: 'toolCallComplete', call};
      yield {type: 'completed', finishReason: 'tool_calls', usage};
    }),
    app.conversations,
    undefined,
    {
      descriptors: tools.descriptors,
      invoke: async call => {
        invoked++;
        return tools.invoke(call);
      },
    },
  );
  await expect(send(c, 'Read README.md')).rejects.toMatchObject({code: 'PROTOCOL'});
  // ADR 0033 (Codex try_run_sampling_request): the first complete call was dispatched while streaming.
  expect(invoked).toBe(1);
  const recovered = app.conversations.get(c.id)!.recovery!.messages.filter(m => m.toolCallId === 'duplicate');
  expect(recovered).toHaveLength(1);
  expect(recovered[0]!.content).not.toContain('not executed');
  expect(recovered[0]!.content).not.toContain('unknown');
});

test('an explicit analysis mode never exposes a mutating handler for artifact recovery', async () => {
  const app = setup();
  let observed: ModelRequest | undefined;
  const c = new Conversation(
    selection,
    model(async function* (request) {
      observed = request;
      yield {type: 'textDelta', text: 'Analysis only.'};
      yield {type: 'completed', finishReason: 'stop', usage};
    }),
    app.conversations,
    undefined,
    {
      descriptors: () => [
        ...tools.descriptors(),
        {name: 'apply_patch', description: 'Write', inputSchema: {type: 'object'}, capability: 'fs.write'},
      ],
      invoke: tools.invoke,
    },
    undefined,
    undefined,
    {analysisOnly: () => true},
  );
  await send(c, 'Explain how to create helo.html, do not create it.');
  expect(observed!.tools.map(t => t.name)).toEqual(['read']);
});

test('a repeated call ID in a later model round is rejected without executing it twice', async () => {
  const app = setup();
  let invoked = 0;
  const call = {id: 'same-across-rounds', name: 'read', input: {path: 'README.md'}};
  const c = new Conversation(
    selection,
    model(async function* () {
      yield {type: 'toolCallComplete', call};
      yield {type: 'completed', finishReason: 'tool_calls', usage};
    }),
    app.conversations,
    undefined,
    {
      descriptors: tools.descriptors,
      invoke: async call => {
        invoked++;
        return tools.invoke(call);
      },
    },
  );
  await expect(send(c, 'Read README.md')).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(invoked).toBe(1);
  expect(app.conversations.recover(c.id).messages.filter(m => m.toolCallId === call.id)).toHaveLength(1);
});

test('partial created HTML receives a useful repair and complete-document inspection correction', async () => {
  const app = setup();
  const root = mkdtempSync(join(tmpdir(), 'cosmew-html-verification-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  let round = 0;
  const full = '<!doctype html><html><head><title>Sales</title></head><body>CTA</body></html>';
  const port = model(async function* (request) {
    round++;
    const call =
      round === 1
        ? {id: 'create-html', name: 'write', input: {path: 'helo.html', content: '<!doctype html>'}}
        : round === 2
          ? {id: 'partial-html', name: 'read', input: {path: 'helo.html', limit: 1}}
          : round === 4 && request.instructions?.includes('missing document ranges')
            ? {id: 'repair-html', name: 'write', input: {path: 'helo.html', content: full}}
            : round === 5
              ? {id: 'whole-html', name: 'read', input: {path: 'helo.html'}}
              : undefined;
    if (call) {
      yield {type: 'toolCallComplete', call};
      yield {type: 'completed', finishReason: 'tool_calls', usage};
      return;
    }
    yield {type: 'textDelta', text: 'The page is ready.'};
    yield {type: 'completed', finishReason: 'stop', usage};
  });
  const c = new Conversation(selection, port, app.conversations, undefined, {
    descriptors: () => [
      ...tools.descriptors(),
      {name: 'write', description: 'Write', inputSchema: {type: 'object'}, capability: 'fs.write'},
    ],
    invoke: async call => {
      if (call.name === 'write') writeFileSync(join(root, 'helo.html'), (call.input as {content: string}).content);
      return {
        callId: call.id,
        name: call.name,
        status: 'ok',
        content:
          call.name === 'write'
            ? JSON.stringify({changes: [{path: 'helo.html', action: 'update'}]})
            : readFileSync(join(root, 'helo.html'), 'utf8'),
        truncated: call.id === 'partial-html',
      };
    },
  });
  await send(c, 'Create helo.html');
  expect(readFileSync(join(root, 'helo.html'), 'utf8')).toBe(full);
  expect(app.conversations.recover(c.id).task!.state).toBe('verified');
  expect(round).toBe(6);
});

test('a retained running command is pending work, never proof that checks passed', async () => {
  const app = setup();
  let round = 0;
  const sessionId = crypto.randomUUID();
  const c = new Conversation(
    selection,
    model(async function* () {
      if (round++ === 0) {
        yield {
          type: 'toolCallComplete',
          call: {id: 'background-check', name: 'exec_command', input: {cmd: 'test', yield_time_ms: 0}},
        };
        yield {type: 'completed', finishReason: 'tool_calls', usage};
        return;
      }
      yield {type: 'textDelta', text: 'The check is running.'};
      yield {type: 'completed', finishReason: 'stop', usage};
    }),
    app.conversations,
    undefined,
    {
      descriptors: () => [
        {
          name: 'exec_command',
          description: 'Fixture command',
          inputSchema: {type: 'object'},
          capability: 'process.execute',
        },
      ],
      invoke: async call => ({
        callId: call.id,
        name: call.name,
        status: 'ok',
        sessionId,
        content: 'Running session: ' + sessionId,
      }),
    },
  );
  await send(c, 'Start a long-running check.');
  const task = app.conversations.recover(c.id).task!;
  expect(task.state).toBe('unfinished');
  expect(task.pending.join(' ')).toContain(sessionId);
  expect(task.verifiedActions.some(a => a.status === 'ok')).toBe(false);
});
