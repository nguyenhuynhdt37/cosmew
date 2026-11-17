/**
 * ADR 0030: Codex-style continuation semantics of the Futryn Conversation loop, driven by a
 * deterministic in-process model so each stop condition can be forced exactly. Fixture evidence only.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  FutrynError,
  type ModelEvent,
  type ModelPort,
  type ModelRequest,
  type ToolCall,
  type ToolPort,
  type TurnBudget,
  type Usage,
} from '@futryn/contracts';
import {Conversation, SAFETY_LIMITS} from '@futryn/core';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

type Step = (request: ModelRequest, attempt: number) => ModelEvent[] | Error;
const usage = (input: number, output: number, costUSD: number | null = null): Usage => ({
  inputTokens: input,
  outputTokens: output,
  costUSD,
});
const answer = (text: string, u = usage(10, 5)): ModelEvent[] => [
  {type: 'textDelta', text},
  {type: 'usage', usage: u},
  {type: 'completed', finishReason: 'stop', usage: u},
];
const callRead = (id: string, path = 'a.txt', u = usage(10, 5)): ModelEvent[] => [
  {type: 'toolCallComplete', call: {id, name: 'read', input: {path}}},
  {type: 'usage', usage: u},
  {type: 'completed', finishReason: 'tool_calls', usage: u},
];

function harness(
  step: Step,
  options: {budget?: TurnBudget; contextLimit?: number; outputLimit?: number; modelCompaction?: boolean} = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'hannes-continuation-'));
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  const requests: ModelRequest[] = [];
  let attempt = 0;
  const invoked: ToolCall[] = [];
  const sleeps: number[] = [];
  const model: ModelPort = {
    async *stream(request) {
      requests.push(request);
      const out = step(request, attempt++);
      if (out instanceof Error) throw out;
      for (const event of out) {
        if (event instanceof Error) throw event;
        yield event;
      }
    },
    generate: async () => {
      throw new FutrynError('UNSUPPORTED');
    },
  };
  const tools: ToolPort = {
    descriptors: () => [
      {
        name: 'read',
        description: 'read a file',
        inputSchema: {type: 'object', properties: {path: {type: 'string'}}},
        capability: 'fs.read',
      },
    ],
    invoke: async call => {
      invoked.push(call);
      return {
        callId: call.id,
        name: call.name,
        status: 'ok',
        content: `content of ${(call.input as {path: string}).path}`,
      };
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
    {
      budget: () => options.budget,
      contextLimit: () => options.contextLimit ?? null,
      outputLimit: () => options.outputLimit ?? null,
      modelCompaction: options.modelCompaction,
      sleep: async ms => {
        sleeps.push(ms);
      },
    },
  );
  const send = async (text = 'go', signal?: AbortSignal) => {
    const events: ModelEvent[] = [];
    for await (const e of conversation.send(text, signal, 4096)) events.push(e); // window = limit − 4096
    return events;
  };
  const receipt = () =>
    JSON.parse(
      (
        app.db
          .query('select data from turn_receipts where conversation = ? order by revision desc')
          .get(conversation.id) as {data: string}
      ).data,
    );
  return {send, requests, invoked, sleeps, receipt, conversation};
}

test('no default ceiling: 50 rounds and 50 calls run until the model ends with text', async () => {
  const h = harness(request =>
    request.messages.filter(m => m.role === 'tool').length < 50
      ? callRead(`c${request.messages.length}`, `file-${request.messages.length}.txt`)
      : answer('done'),
  );
  const events = await h.send();
  expect(h.invoked).toHaveLength(50);
  expect(h.requests).toHaveLength(51);
  expect(events.at(-1)?.type).toBe('completed');
  expect(h.receipt().stopReason).toBe('completed');
});

test('a failed stream is retried (bounded); partial output is discarded visibly, never committed', async () => {
  const transient = harness((_, attempt) => (attempt < 2 ? new FutrynError('TRANSPORT', true) : answer('recovered')));
  expect((await transient.send()).at(-1)?.type).toBe('completed');
  expect(transient.requests).toHaveLength(3);
  // Codex backoff(): 200 ms, then 400 ms, each with ±10% jitter.
  expect(transient.sleeps[0]).toBeWithin(180, 221);
  expect(transient.sleeps[1]).toBeWithin(360, 441);
  expect(transient.sleeps).toHaveLength(2);
  // Exhausted: 1 attempt + SAFETY_LIMITS.roundRetries retries, then a failed turn with its stop reason.
  const down = harness(() => new FutrynError('TRANSPORT', true));
  await expect(down.send()).rejects.toMatchObject({code: 'TRANSPORT'});
  expect(down.requests).toHaveLength(1 + SAFETY_LIMITS.roundRetries);
  expect(down.receipt()).toMatchObject({outcome: 'failed', stopReason: 'failed'});
  // Terminal (non-retryable) errors are never retried.
  const auth = harness(() => new FutrynError('AUTH'));
  await expect(auth.send()).rejects.toMatchObject({code: 'AUTH'});
  expect(auth.requests).toHaveLength(1);
  // ADR 0033 (Codex responses_retry): partial text does not block the retry, but it is discarded
  // visibly and never committed as an answer.
  const partial = harness((_, attempt) =>
    attempt === 0
      ? [{type: 'textDelta', text: 'half'}, new FutrynError('TRANSPORT', true) as unknown as ModelEvent]
      : answer('whole'),
  );
  const events = await partial.send();
  expect(partial.requests).toHaveLength(2);
  expect(events.some(e => e.type === 'responseDiscarded' && e.reason === 'retry')).toBe(true);
  expect(partial.conversation.history().map(m => m.content)).toEqual(['go', 'whole']);
});

test('cancellation while waiting to retry ends the turn as cancelled', async () => {
  const controller = new AbortController();
  const h = harness(() => {
    controller.abort();
    return new FutrynError('TRANSPORT', true);
  });
  await expect(h.send('go', controller.signal)).rejects.toMatchObject({code: 'CANCELLED'});
  expect(h.receipt()).toMatchObject({outcome: 'cancelled', stopReason: 'cancelled'});
});

for (const [budget, reason, rounds] of [
  [{maxSteps: 3}, 'budget_steps', 3],
  [{maxToolCalls: 2}, 'budget_tool_calls', 2],
  [{maxTokens: 45}, 'budget_tokens', 3],
  [{maxCostUSD: 0.03}, 'budget_cost', 3],
] as const)
  test(`user budget ${Object.keys(budget)[0]}: tools are withdrawn, the model answers, stop reason ${reason}`, async () => {
    const h = harness(
      request =>
        request.tools.length
          ? callRead(`c${request.messages.length}`, 'a.txt', usage(10, 5, 0.01))
          : answer('final without tools'),
      {budget},
    );
    const events = await h.send();
    expect(events.at(-1)?.type).toBe('completed');
    expect(h.invoked).toHaveLength(rounds);
    expect(h.requests.at(-1)!.tools).toEqual([]);
    expect(h.requests.at(-1)!.instructions).toContain('used up');
    expect(h.receipt().stopReason).toBe(reason);
  });

test('context pressure: near the window the model answers without tools; over it the turn fails honestly', async () => {
  // Window = limit − max output (4096). Each tool result adds ~1 KB of history.
  const big = 'x'.repeat(600);
  const pressure = harness(
    request =>
      request.tools.length
        ? callRead(`c${request.messages.length}`, big + request.messages.length)
        : answer('summary before the window fills'),
    // This test covers the no-compaction path (ADR 0054 tests the model summary separately).
    {contextLimit: 4096 + 4000, modelCompaction: false},
  );
  const events = await pressure.send();
  expect(events.at(-1)?.type).toBe('completed');
  expect(pressure.requests.at(-1)!.tools).toEqual([]);
  expect(pressure.requests.at(-1)!.instructions).toContain('context window is nearly full');
  expect(pressure.receipt().stopReason).toBe('context_window');
  // Nothing was dropped from history to make room: every tool result is still in the last request.
  expect(pressure.requests.at(-1)!.messages.filter(m => m.role === 'tool')).toHaveLength(pressure.invoked.length);
  // A request that cannot fit at all is refused, not truncated.
  const overflow = harness(() => answer('never'), {contextLimit: 4096 + 50});
  await expect(overflow.send('y'.repeat(2000))).rejects.toMatchObject({code: 'CONTEXT_LIMIT'});
  expect(overflow.requests).toHaveLength(0);
  expect(overflow.receipt()).toMatchObject({outcome: 'failed', stopReason: 'context_window'});
});

test('measured provider usage counts toward the window even when the local estimate is small', async () => {
  const h = harness(
    request =>
      request.tools.length
        ? callRead(`c${request.messages.length}`, 'a.txt', usage(7000, 10))
        : answer('stopped by measured usage'),
    {contextLimit: 4096 + 8000},
  );
  await h.send();
  expect(h.invoked).toHaveLength(1);
  expect(h.receipt().stopReason).toBe('context_window');
});

test('like Codex no output cap is sent unless asked for, and an asked cap is clamped to the model limit', async () => {
  const sent = async (options: {contextLimit?: number; outputLimit?: number}, cap?: number) => {
    const h = harness(() => answer('ok'), options);
    for await (const _ of h.conversation.send('go', undefined, cap)) void _;
    return h.requests[0]!.maxOutputTokens;
  };
  expect(await sent({contextLimit: 400_000, outputLimit: 128_000})).toBeUndefined();
  expect(await sent({contextLimit: 400_000})).toBeUndefined();
  expect(await sent({contextLimit: 400_000, outputLimit: 8_000}, 50_000)).toBe(8_000);
  expect(await sent({contextLimit: 400_000}, 2_000)).toBe(2_000);
});
