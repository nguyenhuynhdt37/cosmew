/**
 * ADR 0054: model-written compaction (auto at 85% of the window, `/compact`), fallback, cancellation,
 * durability, usage. Deterministic in-process model; fixture evidence only.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  FutrynError,
  type Message,
  type ModelEvent,
  type ModelPort,
  type ModelRequest,
  type ToolPort,
  type Usage,
} from '@cosmew/contracts';
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  COMPACTION_PROMPT,
  Conversation,
  SUMMARY_PREFIX,
  estimateTokens,
} from '@cosmew/core';
import {SLASH_COMMANDS} from '@cosmew/sdk';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {compactionNotice} from '../../apps/tui/src/ink/features/commands';
import {memoryVault} from '../fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const usage = (input: number, output: number): Usage => ({inputTokens: input, outputTokens: output, costUSD: null});
const answer = (text: string, u = usage(10, 5)): ModelEvent[] => [
  {type: 'textDelta', text},
  {type: 'usage', usage: u},
  {type: 'completed', finishReason: 'stop', usage: u},
];
const isSummary = (request: ModelRequest) =>
  request.messages.at(-1)?.content.startsWith(COMPACTION_PROMPT.slice(0, 30));
let bulkCount = 0;
/** Assistant output dominates real histories: about 600 estimated tokens per reply. */
const BULK = () => `assistant-reply-${++bulkCount} ` + 'lorem ipsum dolor sit amet '.repeat(65);
const SUMMARY_USAGE = usage(1000, 100);

type Brain = (request: ModelRequest, summaryCalls: number) => ModelEvent[] | Error | Promise<ModelEvent[] | Error>;

function harness(options: {contextLimit: number; brain?: Brain; toolBytes?: number; modelCompaction?: boolean}) {
  const home = mkdtempSync(join(tmpdir(), 'hannes-compaction-'));
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  const requests: ModelRequest[] = [];
  let summaryCalls = 0;
  const brain: Brain =
    options.brain ??
    ((request, calls) => (isSummary(request) ? answer(`SUMMARY-BODY-${calls}`, SUMMARY_USAGE) : answer(BULK())));
  const model: ModelPort = {
    async *stream(request) {
      requests.push(request);
      const out = await brain(request, isSummary(request) ? ++summaryCalls : summaryCalls);
      if (out instanceof Error) throw out;
      yield* out;
    },
    generate: async () => {
      throw new FutrynError('UNSUPPORTED');
    },
  };
  const tools: ToolPort = {
    descriptors: () => [{name: 'read', description: 'read', inputSchema: {type: 'object'}, capability: 'fs.read'}],
    invoke: async call => ({
      callId: call.id,
      name: call.name,
      status: 'ok',
      content: `BIGOUT-${call.id} ` + 'x'.repeat(options.toolBytes ?? 100),
    }),
  };
  const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
  const make = (existing?: {id: string; messages: Message[]}) =>
    new Conversation(selection, model, app.conversations, existing, tools, undefined, undefined, {
      contextLimit: () => options.contextLimit,
      modelCompaction: options.modelCompaction,
      sleep: async () => {},
    });
  const conversation = make();
  const send = async (text: string, signal?: AbortSignal, target: Conversation = conversation) => {
    const events: ModelEvent[] = [];
    for await (const e of target.send(text, signal)) events.push(e);
    return events;
  };
  const receipts = () =>
    (
      app.db.query('select data from turn_receipts where conversation = ? order by revision').all(conversation.id) as {
        data: string;
      }[]
    ).map(r => JSON.parse(r.data));
  const filler = (tag: string) => `${tag} please continue the investigation`;
  return {
    app,
    requests,
    send,
    receipts,
    filler,
    conversation,
    make,
    model,
    selection,
    summaryCalls: () => summaryCalls,
  };
}

const compacted = (events: ModelEvent[]) =>
  events.filter((e): e is Extract<ModelEvent, {type: 'context.compacted'}> => e.type === 'context.compacted');

/** A 4k usable window leaves room for the summary prompt after a fixture output increment.
 * Each completed fixture reply adds this much real history regardless of host guidance size.
 * Allow one current user request plus rounding headroom; stop at the observed summary, not a
 * fixed round count that accidentally depends on verbose versus compact host instructions.
 */
const AUTO_WINDOW = 4000;
const autoCompactionTurnBound = Math.ceil(AUTO_WINDOW / estimateTokens('lorem ipsum dolor sit amet '.repeat(65))) + 2;
async function reachAutoSummary(h: ReturnType<typeof harness>, signal?: AbortSignal) {
  const seen: ModelEvent[][] = [];
  for (let i = 0; i < autoCompactionTurnBound && !h.summaryCalls(); i++)
    seen.push(await h.send(h.filler(`turn-${i}`), signal));
  expect(h.summaryCalls()).toBe(1);
  return seen;
}

test('auto compaction fires at 85% of the window, keeps recent user messages and the plan, counts usage', async () => {
  const h = harness({contextLimit: AUTO_WINDOW});
  h.app.conversations.savePlan?.(h.conversation.id, {
    items: [{step: 'ship the checkpoint feature', status: 'in_progress'}],
    updatedAt: new Date().toISOString(),
  });
  const seen = await reachAutoSummary(h);
  const events = seen.flat();
  const [event] = compacted(events);
  expect(event).toBeDefined();
  expect(event).toMatchObject({trigger: 'auto', strategy: 'model'});
  expect(event!.tokensAfter).toBeLessThan(event!.tokensBefore);
  expect(event!.tokensBefore).toBeGreaterThanOrEqual(AUTO_WINDOW * 0.85);
  expect(h.summaryCalls()).toBe(1);

  // The request that follows the summary sees the handoff, the retained user messages and the plan.
  const index = h.requests.findIndex(isSummary);
  const next = h.requests[index + 1]!;
  const text = next.messages.map(m => m.content).join('\n');
  expect(text).toContain(SUMMARY_PREFIX);
  expect(text).toContain('SUMMARY-BODY-1');
  expect(text).toContain('ship the checkpoint feature');
  for (let i = 0; i < seen.length; i++) expect(text).toContain(`turn-${i} please`);
  // The summarization request carried the whole visible history; it ends with the checkpoint prompt.
  expect(h.requests[index]!.messages.length).toBeGreaterThan(3);
  expect(h.requests[index]!.tools).toEqual([]);

  // The checkpoint is durable; the journal history is intact.
  const recovered = h.app.conversations.recover(h.conversation.id);
  expect(recovered.compaction).toMatchObject({strategy: 'model'});
  expect(recovered.messages.filter(m => m.role === 'user')).toHaveLength(seen.length);

  // The compaction call's usage is counted in the turn that paid for it.
  const turn = h.receipts().find(r => (r.usage?.inputTokens ?? 0) >= SUMMARY_USAGE.inputTokens!);
  expect(turn).toBeDefined();
  expect(turn.usage.inputTokens).toBeGreaterThanOrEqual(1000 + 10);
});

test('no compaction below the threshold', async () => {
  const h = harness({contextLimit: 100_000});
  for (let i = 0; i < 4; i++) expect(compacted(await h.send(h.filler(`t${i}`)))).toHaveLength(0);
  expect(h.summaryCalls()).toBe(0);
});

test('model compaction can be disabled; the excerpt checkpoint still applies', async () => {
  const h = harness({contextLimit: 4000, modelCompaction: false});
  const events: ModelEvent[] = [];
  for (let i = 0; i < 8; i++) events.push(...(await h.send(h.filler(`t${i}`))));
  expect(h.summaryCalls()).toBe(0);
  expect(compacted(events).map(e => e.strategy)).toContain('excerpt');
});

test('retention keeps the newest user messages within 20k tokens and truncates the oldest that overflows', async () => {
  const {retainRecentUserMessages} = await import('../../packages/core/src/context/model-compaction');
  const big = (tag: string) => ({role: 'user' as const, content: `${tag} ` + 'y'.repeat(30_000)}); // ~10k tokens each
  const kept = retainRecentUserMessages([
    big('A'),
    big('B'),
    big('C'),
    {role: 'assistant', content: 'noise'},
    big('D'),
  ]);
  expect(kept.map(k => k.slice(0, 1))).toEqual(['B', 'C', 'D'].slice(-kept.length));
  expect(estimateTokens(kept)).toBeLessThanOrEqual(COMPACT_USER_MESSAGE_MAX_TOKENS + 100);
  expect(kept.some(k => k.includes('truncated by compaction'))).toBe(true);
  expect(kept.at(-1)!.startsWith('D')).toBe(true);
  expect(retainRecentUserMessages([{role: 'user', content: `${SUMMARY_PREFIX}\nold handoff`}])).toEqual([]);
});

test('a failed model summary falls back to the excerpt checkpoint; the turn still completes', async () => {
  const h = harness({
    contextLimit: 4000,
    brain: request => (isSummary(request) ? new FutrynError('TRANSPORT') : answer(BULK())),
  });
  const events: ModelEvent[] = [];
  for (let i = 0; i < 8; i++) events.push(...(await h.send(h.filler(`t${i}`))));
  const [first] = compacted(events);
  expect(first).toMatchObject({strategy: 'excerpt', fallback: true});
  expect(h.app.conversations.recover(h.conversation.id).compaction?.strategy).toBe('deterministic');
  // One failed attempt per turn at most; never a retry storm inside a turn.
  expect(h.requests.filter(isSummary).length).toBeLessThanOrEqual(8);
  expect(events.filter(e => e.type === 'completed')).toHaveLength(8);
});

test('cancelling during the summary cancels the turn and leaves the durable history and checkpoint untouched', async () => {
  const controller = new AbortController();
  const h = harness({
    contextLimit: AUTO_WINDOW,
    brain: request => {
      if (!isSummary(request)) return answer(BULK());
      controller.abort();
      return new FutrynError('CANCELLED');
    },
  });
  // Every candidate turn carries the signal; the fixture aborts it only when summary starts.
  await expect(reachAutoSummary(h, controller.signal)).rejects.toMatchObject({code: 'CANCELLED'});
  expect(controller.signal.aborted).toBe(true);
  expect(h.summaryCalls()).toBe(1);
  expect(h.requests.some(isSummary)).toBe(true);
  const recovered = h.app.conversations.recover(h.conversation.id);
  expect(recovered.compaction).toBeUndefined();
  expect(recovered.messages.filter(m => m.role === 'user').map(m => m.content)).toContain(h.filler('turn-0'));
});

test('recovery after restart loads the compacted state without another summary call', async () => {
  const h = harness({contextLimit: AUTO_WINDOW});
  await reachAutoSummary(h);
  expect(h.summaryCalls()).toBe(1);
  const stored = h.app.conversations.get(h.conversation.id)!;
  const restarted = h.make({id: h.conversation.id, messages: stored.recovery!.messages});
  const before = h.requests.length;
  await h.send('after restart', undefined, restarted);
  const request = h.requests[before]!;
  expect(isSummary(request)).toBeFalsy();
  const text = request.messages.map(m => m.content).join('\n');
  expect(text).toContain(SUMMARY_PREFIX);
  expect(text).toContain('SUMMARY-BODY-1');
  expect(text).toContain('after restart');
  expect(h.summaryCalls()).toBe(1);
});

test('mid-turn compaction folds tool rounds into the handoff; tool outputs of the span are dropped', async () => {
  let reads = 0;
  const h = harness({
    contextLimit: 4000,
    toolBytes: 1500,
    brain: request => {
      if (isSummary(request)) return answer('SUMMARY-MID', SUMMARY_USAGE);
      if (reads >= 5) return answer('done');
      reads++;
      return [
        {type: 'toolCallComplete', call: {id: `r${reads}`, name: 'read', input: {path: `f${reads}`}}},
        {type: 'usage', usage: usage(10, 5)},
        {type: 'completed', finishReason: 'tool_calls', usage: usage(10, 5)},
      ];
    },
  });
  const events = await h.send('Investigate the docs thoroughly');
  const [event] = compacted(events);
  expect(event).toMatchObject({trigger: 'auto', strategy: 'model'});
  const index = h.requests.findIndex(isSummary);
  expect(JSON.stringify(h.requests[index]!.messages)).toContain('BIGOUT-r1');
  const after = JSON.stringify(h.requests[index + 1]!.messages);
  expect(after).toContain('SUMMARY-MID');
  expect(after).toContain('Investigate the docs thoroughly');
  expect(after).not.toContain('BIGOUT-r1'); // dropped with the summarized span
  expect(events.at(-1)?.type).toBe('completed');
  // Durable journal still holds every tool result.
  const journal = JSON.stringify(h.app.conversations.recover(h.conversation.id).messages);
  expect(journal).toContain('BIGOUT-r1');
});

test('/compact: idle conversation is checkpointed, durable and counted in session usage', async () => {
  const h = harness({contextLimit: 100_000});
  for (let i = 0; i < 3; i++) await h.send(h.filler(`turn-${i}`));
  const usedBefore = h.receipts().reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0);
  const outcome = await h.conversation.compact('keep the file names');
  expect(outcome).toMatchObject({compacted: true, strategy: 'model'});
  const request = h.requests.find(isSummary)!;
  expect(request.messages.at(-1)!.content).toContain('keep the file names');
  expect(outcome.tokensAfter).toBeLessThan(outcome.tokensBefore);
  expect(h.app.conversations.recover(h.conversation.id).compaction?.strategy).toBe('model');
  const usedAfter = h.receipts().reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0);
  expect(usedAfter - usedBefore).toBe(SUMMARY_USAGE.inputTokens!);
  // The next turn starts from the compacted state.
  await h.send('continue');
  expect(
    h.requests
      .at(-1)!
      .messages.map(m => m.content)
      .join('\n'),
  ).toContain(SUMMARY_PREFIX);
});

test('/compact with nothing to compact, on model failure and on cancellation', async () => {
  const empty = harness({contextLimit: 100_000});
  expect(await empty.conversation.compact()).toMatchObject({compacted: false, reason: 'empty'});

  const failing = harness({
    contextLimit: 100_000,
    brain: request => (isSummary(request) ? new FutrynError('TRANSPORT') : answer(BULK())),
  });
  for (let i = 0; i < 4; i++) await failing.send(failing.filler(`t${i}`));
  expect(await failing.conversation.compact()).toMatchObject({compacted: true, strategy: 'excerpt', fallback: true});

  const controller = new AbortController();
  const slow = harness({
    contextLimit: 100_000,
    brain: request => {
      if (!isSummary(request)) return answer(BULK());
      controller.abort();
      return new FutrynError('CANCELLED');
    },
  });
  for (let i = 0; i < 4; i++) await slow.send(slow.filler(`t${i}`));
  await expect(slow.conversation.compact(undefined, controller.signal)).rejects.toBeDefined();
  expect(slow.app.conversations.recover(slow.conversation.id).compaction).toBeUndefined();
});

test('/compact is refused while a turn runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const h = harness({contextLimit: 100_000, brain: async () => (await gate, answer('late'))});
  const running = h.send('start');
  while (!h.requests.length) await Bun.sleep(2);
  await expect(h.conversation.compact()).rejects.toMatchObject({code: 'POLICY'});
  release();
  await running;
  expect(h.requests.some(isSummary)).toBe(false);
});

test('/compact is a canonical slash command with an optional argument and a transcript notice', () => {
  const command = SLASH_COMMANDS.find(c => c.command === '/compact')!;
  expect(command).toMatchObject({handler: 'compact', arguments: 'optional'});
  expect(command.unavailable).toBeUndefined();
  expect(command.duringRequest).toBeFalsy(); // the router refuses it while a turn runs
  expect(compactionNotice({strategy: 'model', tokensBefore: 91000, tokensAfter: 4200})).toBe(
    'Context compacted (summarized by the model): ~91,000 -> ~4,200 tokens.',
  );
  expect(compactionNotice({strategy: 'excerpt', tokensBefore: 10, tokensAfter: 5, fallback: true})).toContain(
    'model summary failed',
  );
});

test('the compaction call carries the turn cost and output caps', async () => {
  const {summarizeWithModel} = await import('../../packages/core/src/context/model-compaction');
  const seen: ModelRequest[] = [];
  const model = {
    async *stream(request: ModelRequest) {
      seen.push(request);
      yield {type: 'textDelta', text: 'summary'} as ModelEvent;
      yield {type: 'completed', finishReason: 'stop', usage: null} as unknown as ModelEvent;
    },
  };
  await summarizeWithModel({
    model: model as never,
    selection: {accountId: 'a', modelId: 'm'} as never,
    visible: [{role: 'user', content: 'hello'}] as never,
    window: 100_000,
    maxOutputTokens: 512,
    maxEstimatedCostUSD: 0.25,
  });
  expect(seen[0]).toMatchObject({maxOutputTokens: 512, maxEstimatedCostUSD: 0.25, tools: []});
});

test('87% measured pressure compacts before withdrawing tools and continues investigation', async () => {
  let rounds = 0;
  let offered: string[] = [];
  const h = harness({
    contextLimit: 4000,
    toolBytes: 1500,
    brain: request => {
      if (isSummary(request)) return answer('Reduced investigation handoff', SUMMARY_USAGE);
      if (++rounds > 1) {
        offered = request.tools.map(t => t.name);
        return answer('continued with tools');
      }
      return [
        {type: 'toolCallComplete', call: {id: 'pressure', name: 'read', input: {path: 'source'}}},
        {type: 'completed', finishReason: 'tool_calls', usage: usage(3480, 0)},
      ];
    },
  });
  const events = await h.send('Keep investigating the source');
  expect(offered).toContain('read');
  expect(h.summaryCalls()).toBe(1);
  expect(compacted(events)[0]).toMatchObject({strategy: 'model', tokensBefore: 3480});
  expect(events.at(-1)).toMatchObject({type: 'completed'});
});

test('producer pages are preserved verbatim while the whole request fits', async () => {
  let rounds = 0;
  let page = '';
  const h = harness({
    contextLimit: 100_000,
    toolBytes: 40_000,
    brain: request => {
      if (++rounds > 1) {
        page = request.messages.find(m => m.role === 'tool')!.content;
        return answer('checked the entire page');
      }
      return [
        {type: 'toolCallComplete', call: {id: 'page', name: 'read', input: {path: 'source'}}},
        {type: 'completed', finishReason: 'tool_calls', usage: usage(10, 5)},
      ];
    },
  });
  await h.send('Read this page');
  expect(page).toBe('BIGOUT-page ' + 'x'.repeat(40_000));
  expect(h.summaryCalls()).toBe(0);
});

test.each(['failure', 'no-gain'] as const)('%s summary at 87% is attempted once and finishes honestly', async mode => {
  let rounds = 0;
  const h = harness({
    contextLimit: 4000,
    toolBytes: 1500,
    brain: request => {
      if (isSummary(request))
        return mode === 'failure' ? new FutrynError('TRANSPORT') : answer('too long '.repeat(1500), SUMMARY_USAGE);
      if (++rounds > 1) return answer('Context is full; investigation remains unfinished');
      return [
        {type: 'toolCallComplete', call: {id: 'full', name: 'read', input: {path: 'source'}}},
        {type: 'completed', finishReason: 'tool_calls', usage: usage(3480, 0)},
      ];
    },
  });
  const events = await h.send('Investigate until the evidence is sufficient');
  expect(h.summaryCalls()).toBe(1);
  expect(h.requests.at(-1)!.tools).toEqual([]);
  expect(compacted(events)).toHaveLength(0);
  expect(h.receipts().at(-1).stopReason).toBe('context_window');
  expect(h.app.conversations.recover(h.conversation.id).messages.some(m => m.toolCallId === 'full')).toBe(true);
  if (mode === 'no-gain') expect(h.receipts().at(-1).usage.inputTokens).toBe(3480 + 1000 + 10);
});

test('UTF-8 context clipping is bounded and preserves real retrieval references through handoffs', async () => {
  const {truncateToolResults} = await import('../../packages/core/src/context/builder');
  const {assembleHandoff} = await import('../../packages/core/src/context/model-compaction');
  const marker =
    '[tool_output output_id=12345678-1234-1234-1234-123456789abc; use tool_output to retrieve archived evidence]';
  const original: Message = {
    role: 'tool',
    toolName: 'read',
    toolCallId: 'utf8',
    content: 'Tiếng Việt 🐈 '.repeat(5000) + marker,
  };
  const [clipped] = truncateToolResults([original], 1024);
  expect(Buffer.byteLength(clipped!.content)).toBeLessThan(1300);
  expect(clipped!.content).not.toContain('\uFFFD');
  expect(clipped!.content).toContain(marker);
  expect(clipped!.content).toContain('not a complete read');
  expect(assembleHandoff('Model omitted all handles', [original], null)).toContain(marker);
  expect(assembleHandoff('No archive exists', [{...original, content: 'ordinary evidence'}], null)).not.toContain(
    'output_id=',
  );
  expect(original.content).not.toContain('context truncation');
});

test('excerpt checkpoints keep retrieval references from the clipped middle evidence', async () => {
  const {compactHistory, useContextSnapshot} = await import('../../packages/core/src/context/compaction');
  const marker =
    '[tool_output output_id=12345678-1234-1234-1234-123456789abc; use tool_output to retrieve archived evidence]';
  const messages: Message[] = [
    {role: 'user', content: 'first question'},
    {role: 'assistant', content: '', toolCalls: [{id: 'ref', name: 'read', input: {path: 'src'}}]},
    {role: 'tool', toolName: 'read', toolCallId: 'ref', content: 'x'.repeat(5000) + marker},
    {role: 'user', content: 'second question'},
    {role: 'assistant', content: 'answer'},
    {role: 'user', content: 'third question'},
  ];
  const snapshot = await compactHistory(messages, undefined, 10_000);
  expect(snapshot).toBeDefined();
  expect(JSON.stringify(useContextSnapshot(messages, snapshot))).toContain(marker);
});

test('summarizer keeps a complete producer page when it fits including its middle evidence', async () => {
  const {summarizeWithModel} = await import('../../packages/core/src/context/model-compaction');
  const content = 'a'.repeat(20_000) + 'middle evidence Tiếng Việt 🐈' + 'z'.repeat(20_000);
  let supplied = '';
  const model: ModelPort = {
    async *stream(request) {
      supplied = request.messages.find(m => m.role === 'tool')!.content;
      yield* answer('handoff', SUMMARY_USAGE);
    },
    generate: async () => {
      throw new FutrynError('UNSUPPORTED');
    },
  };
  await summarizeWithModel({
    model,
    selection: {accountId: 'a', modelId: 'fixture'},
    visible: [
      {role: 'assistant', content: '', toolCalls: [{id: 'page', name: 'read', input: {path: 'source'}}]},
      {role: 'tool', toolName: 'read', toolCallId: 'page', content},
    ],
    window: 100_000,
  });
  expect(supplied).toBe(content);
});

test('mid-turn handoff keeps a small newest evidence round paired and the current user request', async () => {
  let rounds = 0;
  const h = harness({
    contextLimit: 4000,
    toolBytes: 300,
    brain: request => {
      if (isSummary(request)) return answer('Compact older evidence', SUMMARY_USAGE);
      if (++rounds === 1) return answer('older evidence '.repeat(200));
      if (rounds > 2) return answer('done');
      return [
        {type: 'toolCallComplete', call: {id: 'newest', name: 'read', input: {path: 'latest'}}},
        {type: 'completed', finishReason: 'tool_calls', usage: usage(3480, 0)},
      ];
    },
  });
  await h.send('Earlier investigation');
  await h.send('Keep the latest evidence and continue');
  const next = h.requests[h.requests.findIndex(isSummary) + 1]!;
  expect(next.messages.some(m => m.role === 'user' && m.content === 'Keep the latest evidence and continue')).toBe(
    true,
  );
  const result = next.messages.findIndex(m => m.role === 'tool' && m.toolCallId === 'newest');
  expect(result).toBeGreaterThan(0);
  expect(next.messages[result - 1]!.toolCalls?.map(c => c.id)).toContain('newest');
  expect(next.messages[result]!.content).toContain('BIGOUT-newest');
  expect(next.tools.map(t => t.name)).toContain('read');
});
