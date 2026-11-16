/**
 * ADR 0033: behavioral matrix of the Futryn agent loop against the pinned Codex control flow
 * (openai/codex@710bee73a89385aaf2afb41d885edf82473d941f: session/turn.rs, tools/parallel.rs,
 * session/turn_input.rs, tasks/regular.rs, context_manager/normalize.rs).
 *
 * Every test drives the real `Conversation` loop and the real SQLite journal. Models and tools are
 * deterministic in-process fixtures, so these are fixture evidence of loop behavior only: they do not
 * prove live provider, sandbox or container acceptance.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
  FutrynError,
  GENERATION_LIMITS,
  type CommandOutputChunk,
  type ModelEvent,
  type ModelPort,
  type ModelRequest,
  type ToolCall,
  type ToolCapability,
  type ToolPort,
  type ToolResult,
  type TurnBudget,
  type Usage,
} from '@futryn/contracts';
import {Conversation, ExecutionGate, normalizeHistory} from '@futryn/core';
import {openPrivateDatabase, SqliteConversations} from '@futryn/persistence';
import {FutrynTuiApp} from '@futryn/tui';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
const usage: Usage = {inputTokens: 10, outputTokens: 5, costUSD: null};
const done = (finishReason = 'stop', u: Usage = usage): ModelEvent => ({type: 'completed', finishReason, usage: u});
const text = (value: string): ModelEvent => ({type: 'textDelta', text: value});
const call = (id: string, name: string, input: unknown = {}): ModelEvent => ({
  type: 'toolCallComplete',
  call: {id, name, input},
});
const reply = (...events: ModelEvent[]) =>
  async function* () {
    for (const event of events) yield event;
  };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return {promise, resolve};
}
/** Fails the test instead of hanging when a dispatch-timing promise never resolves. */
const within = <T>(promise: Promise<T>, label: string) =>
  Promise.race([
    promise,
    Bun.sleep(2000).then(() => {
      throw new Error(`timed out: ${label}`);
    }),
  ]);

type Run = (
  call: ToolCall,
  signal?: AbortSignal,
  onOutput?: (chunk: CommandOutputChunk) => void,
) => Promise<string | Partial<ToolResult>>;
interface FakeTool {
  name: string;
  capability: ToolCapability;
  parallel?: boolean;
  run: Run;
}
const tool = (
  name: string,
  capability: ToolCapability = 'fs.read',
  run: Run = async c => `${name} result ${c.id}`,
  parallel = capability === 'fs.read',
): FakeTool => ({name, capability, parallel, run});

function store() {
  const home = mkdtempSync(join(tmpdir(), 'futryn-loop-'));
  const db = openPrivateDatabase(home);
  cleanup.push(() => {
    db.close();
    rmSync(home, {recursive: true, force: true});
  });
  return new SqliteConversations(db);
}

type Responder = (request: ModelRequest, index: number, signal?: AbortSignal) => AsyncIterable<ModelEvent>;
function harness(
  responders: Responder | ReturnType<typeof reply>[],
  tools: FakeTool[],
  options: {
    budget?: TurnBudget;
    contextLimit?: number;
    conversations?: SqliteConversations;
    existing?: string;
    inlineTools?: boolean;
  } = {},
) {
  const conversations = options.conversations ?? store();
  const requests: ModelRequest[] = [];
  const invoked: string[] = [];
  const respond: Responder =
    typeof responders === 'function' && !Array.isArray(responders)
      ? responders
      : (_r, index) =>
          (responders as ReturnType<typeof reply>[])[Math.min(index, (responders as unknown[]).length - 1)]!();
  const model: ModelPort = {
    ...(options.inlineTools ? {inlineTools: true} : {}),
    stream: (request, signal) => {
      const index = requests.push(structuredClone(request)) - 1;
      return respond(request, index, signal);
    },
    generate: async () => {
      throw new FutrynError('UNSUPPORTED');
    },
  };
  const port: ToolPort = {
    descriptors: () =>
      tools.map(t => ({
        name: t.name,
        description: t.name,
        inputSchema: {type: 'object'},
        capability: t.capability,
        ...(t.parallel ? {parallel: true} : {}),
      })),
    invoke: async (c, signal, onOutput) => {
      const t = tools.find(candidate => candidate.name === c.name);
      if (!t) return {callId: c.id, name: c.name, status: 'error', code: 'UNKNOWN_TOOL', content: 'unknown'};
      invoked.push(c.id);
      signal?.throwIfAborted();
      const out = await t.run(c, signal, onOutput);
      return typeof out === 'string'
        ? {callId: c.id, name: c.name, status: 'ok', content: out}
        : {callId: c.id, name: c.name, status: 'ok', content: '', ...out};
    },
  };
  const conversation = new Conversation(
    selection,
    model,
    conversations,
    options.existing ? {id: options.existing, messages: []} : undefined,
    port,
    undefined,
    undefined,
    {budget: () => options.budget, contextLimit: () => options.contextLimit ?? null, sleep: async () => {}},
  );
  const events: ModelEvent[] = [];
  const send = async (content = 'go', signal?: AbortSignal, onEvent?: (event: ModelEvent) => void) => {
    for await (const event of conversation.send(content, signal, 4096)) {
      // window arithmetic below assumes 4096
      events.push(event);
      onEvent?.(event);
    }
    return events;
  };
  const receipt = () => conversations.get(conversation.id)!.turns!.at(-1)!;
  const journal = () => conversations.recover(conversation.id);
  return {conversation, conversations, requests, invoked, events, send, receipt, journal};
}
type Harness = ReturnType<typeof harness>;
const tail = (request: ModelRequest, n: number) =>
  request.messages
    .slice(-n)
    .map(m =>
      m.role === 'tool'
        ? `tool:${m.toolCallId}`
        : m.toolCalls
          ? `call:${m.toolCalls.map(c => c.id).join(',')}`
          : `${m.role}:${m.content}`,
    );
/** Every call in model-visible history has exactly one result and no result lacks its call. */
const paired = (h: Harness) => {
  const messages = h.journal().messages;
  expect(() => normalizeHistory(messages)).not.toThrow();
  const results = messages.filter(m => m.role === 'tool').map(m => m.toolCallId);
  expect(new Set(results).size).toBe(results.length);
  return messages;
};

test('ExecutionGate: shared holders overlap, exclusive waits for them, FIFO keeps later shared calls behind a waiting exclusive one', async () => {
  const gate = new ExecutionGate(4);
  const log: string[] = [];
  const r1 = await gate.acquire(false);
  const r2 = await gate.acquire(false);
  const w = gate.acquire(true).then(release => {
    log.push('w');
    return release;
  });
  const r3 = gate.acquire(false).then(release => {
    log.push('r3');
    return release;
  });
  await Bun.sleep(5);
  expect(log).toEqual([]);
  r1();
  await Bun.sleep(1);
  expect(log).toEqual([]);
  r2();
  const releaseW = await w;
  await Bun.sleep(1);
  expect(log).toEqual(['w']);
  releaseW();
  (await r3)();
  expect(log).toEqual(['w', 'r3']);
  const controller = new AbortController();
  const hold = await gate.acquire(true);
  const queued = gate.acquire(true, controller.signal);
  controller.abort();
  await expect(queued).rejects.toMatchObject({code: 'CANCELLED'});
  hold();
  (await gate.acquire(true))();
});

test('1 + 21: a response with only a final message ends the turn after one request, with or without tools offered', async () => {
  for (const tools of [[], [tool('read')]]) {
    const h = harness([reply(text('Final answer.'), done())], tools);
    await h.send();
    expect(h.requests).toHaveLength(1);
    expect(h.invoked).toEqual([]);
    expect(h.requests[0]!.tools.map(t => t.name)).toEqual(tools.map(t => t.name));
    expect(h.events.at(-1)).toMatchObject({type: 'completed'});
    expect(h.receipt()).toMatchObject({outcome: 'completed', stopReason: 'completed'});
    expect(h.conversation.history().map(m => m.role)).toEqual(['user', 'assistant']);
  }
});

test('2: one tool call is answered and followed by another model request', async () => {
  const h = harness(
    [reply(call('c1', 'read', {path: 'a'}), done('tool_calls')), reply(text('Read it.'), done())],
    [tool('read')],
  );
  await h.send();
  expect(h.invoked).toEqual(['c1']);
  expect(h.requests).toHaveLength(2);
  expect(tail(h.requests[1]!, 3)).toEqual(['user:go', 'call:c1', 'tool:c1']);
  expect(h.requests[1]!.messages.at(-1)!.content).toBe('read result c1');
});

test('3: independent parallel reads run concurrently', async () => {
  let active = 0,
    peak = 0;
  const allStarted = deferred();
  const read = tool('read', 'fs.read', async c => {
    active++;
    peak = Math.max(peak, active);
    if (active === 3) allStarted.resolve();
    await within(allStarted.promise, 'all reads start');
    active--;
    return `r ${c.id}`;
  });
  const h = harness(
    [reply(call('c1', 'read'), call('c2', 'read'), call('c3', 'read'), done('tool_calls')), reply(text('ok'), done())],
    [read],
  );
  await h.send();
  expect(peak).toBe(3);
  expect(tail(h.requests[1]!, 4)).toEqual(['call:c1,c2,c3', 'tool:c1', 'tool:c2', 'tool:c3']);
});

test('4: parallel-safe calls, then an exclusive mutation, then another parallel call keep Codex shared/exclusive order', async () => {
  const log: string[] = [];
  const timed =
    (name: string, ms: number): Run =>
    async c => {
      log.push(`start ${c.id}`);
      await Bun.sleep(ms);
      log.push(`end ${c.id}`);
      return name;
    };
  const h = harness(
    [
      reply(call('r1', 'read'), call('r2', 'read'), call('w', 'apply_patch'), call('r3', 'read'), done('tool_calls')),
      reply(text('ok'), done()),
    ],
    [tool('read', 'fs.read', timed('read', 30)), tool('apply_patch', 'fs.write', timed('patch', 10))],
  );
  await h.send();
  const at = (entry: string) => log.indexOf(entry);
  expect(at('start r2')).toBeLessThan(at('end r1'));
  expect(at('start w')).toBeGreaterThan(Math.max(at('end r1'), at('end r2')));
  expect(at('start r3')).toBeGreaterThan(at('end w'));
  // A tool without an explicit parallel declaration is exclusive even when it only reads.
  const undeclared: string[] = [];
  const h2 = harness(
    [reply(call('a', 'lookup'), call('b', 'lookup'), done('tool_calls')), reply(text('ok'), done())],
    [
      tool(
        'lookup',
        'fs.read',
        async c => {
          undeclared.push(`start ${c.id}`);
          await Bun.sleep(10);
          undeclared.push(`end ${c.id}`);
          return 'x';
        },
        false,
      ),
    ],
  );
  await h2.send();
  expect(undeclared).toEqual(['start a', 'end a', 'start b', 'end b']);
});

test('5: a complete tool call starts before the streaming response has finished', async () => {
  const log: string[] = [];
  const started = deferred();
  const h = harness(
    [
      async function* () {
        yield call('c1', 'read');
        await within(started.promise, 'tool dispatched mid-stream');
        log.push('response completed');
        yield done('tool_calls');
      },
      reply(text('ok'), done()),
    ],
    [
      tool('read', 'fs.read', async () => {
        log.push('tool started');
        started.resolve();
        return 'x';
      }),
    ],
  );
  await h.send();
  expect(log).toEqual(['tool started', 'response completed']);
});

test('6: a stream cut inside tool arguments never dispatches the partial call (real adapter)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'futryn-cut-')),
    root = mkdtempSync(join(tmpdir(), 'futryn-cut-ws-'));
  const server = fixtureServer();
  const app = startup(home, {vault: memoryVault()});
  const client = app.createFutrynClient(root);
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
    server.server.stop(true);
    rmSync(home, {recursive: true, force: true});
    rmSync(root, {recursive: true, force: true});
  });
  app.registry.add(server.provider('chat', {id: 'cut-args', auth: 'none'}));
  await app.accounts.add('cut-args', 'fixture', {kind: 'none'});
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  server.set({tools: true, dropped: true, cutToolArgs: true});
  await expect(
    (async () => {
      for await (const _ of client.sendMessage('Look something up')) {
        /* drain */
      }
    })(),
  ).rejects.toBeInstanceOf(FutrynError);
  expect((app.db.query("SELECT count(*) AS n FROM tool_audit WHERE phase='requested'").get() as {n: number}).n).toBe(0);
  const turn = app.conversations.get(client.activeSession()!.id)!.recovery!.turns.at(-1)!;
  expect(turn.events.some(e => e.data.type === 'tool.call')).toBe(false);
  expect(turn.state).toBe('failed');
});

test('7: a tool-call id repeated in a later response is rejected without a second execution', async () => {
  const h = harness(
    [reply(call('c1', 'read'), done('tool_calls')), reply(call('c1', 'read'), done('tool_calls'))],
    [tool('read')],
  );
  await expect(h.send()).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(h.invoked).toEqual(['c1']);
  expect(paired(h).filter(m => m.toolCallId === 'c1')).toHaveLength(1);
});

test('8: a stream that breaks after a tool started keeps the real result; the transport retry does not re-run the tool', async () => {
  const finished = deferred();
  const read = tool('read', 'fs.read', async () => {
    finished.resolve();
    return 'evidence';
  });
  const h = harness(
    [
      async function* () {
        yield call('c1', 'read');
        await within(finished.promise, 'tool finished');
        throw new FutrynError('TRANSPORT', true);
      },
      reply(text('Used the evidence.'), done()),
    ],
    [read],
  );
  await h.send();
  expect(h.invoked).toEqual(['c1']);
  expect(h.requests).toHaveLength(2);
  expect(tail(h.requests[1]!, 2)).toEqual(['call:c1', 'tool:c1']);
  expect(h.requests[1]!.messages.at(-1)!.content).toBe('evidence');
  expect(h.receipt()).toMatchObject({outcome: 'completed'});
  // A non-retryable failure ends the turn, but the executed call keeps its confirmed result.
  const fatal = harness(
    [
      async function* () {
        yield call('c1', 'read');
        await Bun.sleep(5);
        throw new FutrynError('PROTOCOL');
      },
    ],
    [tool('read')],
  );
  await expect(fatal.send()).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(paired(fatal).find(m => m.toolCallId === 'c1')!.content).toBe('read result c1');
});

test('9: cancelling during a command keeps a finished mutation, marks the running call unknown and never starts the queued one', async () => {
  const controller = new AbortController();
  const streamed = deferred();
  const exec = tool(
    'exec_command',
    'process.execute',
    (_c, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new FutrynError('CANCELLED')), {once: true});
        void streamed.promise.then(() => controller.abort());
      }),
  );
  const h = harness(
    [
      async function* () {
        yield call('w', 'apply_patch');
        yield call('x', 'exec_command');
        yield call('y', 'apply_patch');
        yield done('tool_calls');
        streamed.resolve();
      },
    ],
    [tool('apply_patch', 'fs.write', async () => 'patched'), exec],
  );
  await expect(h.send('go', controller.signal)).rejects.toMatchObject({code: 'CANCELLED'});
  expect(h.invoked).toEqual(['w', 'x']);
  expect(h.receipt()).toMatchObject({outcome: 'cancelled', stopReason: 'cancelled'});
  const messages = paired(h);
  const result = (id: string) => messages.find(m => m.toolCallId === id)!.content;
  expect(result('w')).toBe('patched');
  expect(result('x')).toContain('EXECUTION_UNKNOWN');
  expect(result('y')).toContain('aborted before dispatch');
  expect(h.events.filter(e => e.type === 'toolResult').map(e => e.type === 'toolResult' && e.result.callId)).toEqual([
    'w',
    'x',
    'y',
  ]);
  // The finished mutation is kept as applied evidence on the interrupted turn.
  expect(
    h.conversations.get(h.conversation.id)!.messages.some(m => m.toolName === 'apply_patch' && m.content === 'patched'),
  ).toBe(true);
});

/** Lets a responder or tool steer the conversation created after it. */
function steering() {
  const holder: {h?: Harness; outcomes: unknown[]} = {outcomes: []};
  return {
    holder,
    steer: (content: string) => {
      const outcome = holder.h!.conversation.steer(content);
      holder.outcomes.push(outcome);
      return outcome;
    },
  };
}

test('10 / E: steering during model sampling is journaled at once and preempts the stream (Codex InstantInterrupt)', async () => {
  const s = steering();
  let journaledBeforeDelivery = false;
  s.holder.h = harness(
    [
      async function* () {
        yield text('Working. ');
        const outcome = s.steer('Keep the existing design and use the current auth backend.');
        journaledBeforeDelivery =
          outcome.accepted &&
          s.holder
            .h!.journal()
            .turns.at(-1)!
            .events.some(e => e.data.type === 'user.steered');
        yield call('c1', 'read');
        yield done('tool_calls');
      },
      reply(text('Done with the design kept.'), done()),
    ],
    [tool('read')],
  );
  const h = s.holder.h;
  await h.send('Build a login page.');
  expect(s.holder.outcomes[0]).toMatchObject({accepted: true, turnId: h.receipt().requestId});
  expect(journaledBeforeDelivery).toBe(true);
  // The unfinished response (its text and the call that had not completed) is void; nothing ran.
  expect(h.invoked).toEqual([]);
  expect(tail(h.requests[1]!, 2)).toEqual([
    'user:Build a login page.',
    'user:Keep the existing design and use the current auth backend.',
  ]);
  expect(h.events.map(e => e.type)).toEqual(['textDelta', 'responseDiscarded', 'steered', 'textDelta', 'completed']);
  const messages = paired(h);
  expect(messages.map(m => m.content)).toEqual([
    'Build a login page.',
    'Keep the existing design and use the current auth backend.',
    'Done with the design kept.',
  ]);
  expect(h.conversations.get(h.conversation.id)!.turns).toHaveLength(1);
});

test('F: preemption keeps a completed call and its result, and never runs the call that had not completed', async () => {
  const s = steering();
  const ran = deferred();
  s.holder.h = harness(
    [
      async function* () {
        yield call('c1', 'read');
        await within(ran.promise, 'c1 dispatched');
        s.steer('Stop exploring; summarize.');
        yield call('c2', 'read');
        yield done('tool_calls');
      },
      reply(text('Summary.'), done()),
    ],
    [
      tool('read', 'fs.read', async c => {
        ran.resolve();
        return `r ${c.id}`;
      }),
    ],
  );
  const h = s.holder.h;
  await h.send();
  expect(h.invoked).toEqual(['c1']);
  expect(tail(h.requests[1]!, 3)).toEqual(['call:c1', 'tool:c1', 'user:Stop exploring; summarize.']);
  const messages = paired(h);
  expect(messages.some(m => m.toolCalls?.some(c => c.id === 'c2'))).toBe(false);
});

test('11: steering during tool execution is delivered with the next request after that tool result', async () => {
  const s = steering();
  s.holder.h = harness(
    [reply(call('c1', 'exec_command'), done('tool_calls')), reply(text('ok'), done())],
    [
      tool('exec_command', 'process.execute', async () => {
        s.steer('Also run the linter.');
        return 'Exit code: 0';
      }),
    ],
  );
  await s.holder.h.send();
  expect(tail(s.holder.h.requests[1]!, 3)).toEqual(['call:c1', 'tool:c1', 'user:Also run the linter.']);
});

test('12 / B: steering that races turn completion either continues the same turn or is refused as no active turn', async () => {
  // Accepted while the final answer streams: the answer is preempted and the turn continues with it.
  const s = steering();
  s.holder.h = harness(
    [
      async function* () {
        yield text('Almost done.');
        s.steer('Wait, also add a logout button.');
        yield done();
      },
      reply(text('Added logout too.'), done()),
    ],
    [],
  );
  await s.holder.h.send();
  expect(s.holder.h.requests).toHaveLength(2);
  expect(tail(s.holder.h.requests[1]!, 2)).toEqual(['user:go', 'user:Wait, also add a logout button.']);
  expect(s.holder.h.receipt()).toMatchObject({outcome: 'completed'});
  // Arriving while completion is delivered, or after it, is refused; the caller starts a new turn.
  const late = harness([reply(text('done'), done())], []);
  let atCompletion: unknown;
  await late.send('go', undefined, event => {
    if (event.type === 'completed') atCompletion = late.conversation.steer('too late');
  });
  expect(atCompletion).toEqual({accepted: false, reason: 'no_active_turn'});
  expect(late.conversation.steer('after')).toEqual({accepted: false, reason: 'no_active_turn'});
  expect(late.journal().turns[0]!.events.some(e => e.data.type === 'user.steered')).toBe(false);
  // Stale turn identities and runtime-owned loops are refused without journaling anything.
  const stale = steering();
  let staleOutcome: unknown;
  stale.holder.h = harness(
    [
      async function* () {
        staleOutcome = stale.holder.h!.conversation.steer('x', crypto.randomUUID());
        yield text('ok');
        yield done();
      },
    ],
    [],
  );
  await stale.holder.h.send();
  expect(staleOutcome).toEqual({accepted: false, reason: 'turn_mismatch'});
  const bridge = steering();
  let bridgeOutcome: unknown;
  bridge.holder.h = harness(
    [
      async function* () {
        bridgeOutcome = bridge.holder.h!.conversation.steer('x');
        yield text('ok');
        yield done();
      },
    ],
    [],
    {inlineTools: true},
  );
  await bridge.holder.h.send();
  expect(bridgeOutcome).toEqual({accepted: false, reason: 'not_steerable'});
});

test('13: cancelling while a call waits for approval ends the turn without running it and without another request', async () => {
  const controller = new AbortController();
  const awaitingApproval = tool(
    'apply_patch',
    'fs.write',
    (_c, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new FutrynError('CANCELLED')), {once: true});
        queueMicrotask(() => controller.abort());
      }),
  );
  const h = harness(
    [reply(call('w', 'apply_patch'), done('tool_calls')), reply(text('never'), done())],
    [awaitingApproval],
  );
  await expect(h.send('go', controller.signal)).rejects.toMatchObject({code: 'CANCELLED'});
  expect(h.requests).toHaveLength(1);
  expect(h.receipt().outcome).toBe('cancelled');
  expect(h.journal().turns[0]!.state).toBe('cancelled');
  expect(paired(h).find(m => m.toolCallId === 'w')!.content).not.toMatch(/^patched/);
});

test('14: cancelling during terminal execution propagates to the command and streams its output first', async () => {
  const controller = new AbortController();
  let sawAbort = false;
  const exec = tool(
    'exec_command',
    'process.execute',
    (_c, signal, onOutput) =>
      new Promise((_resolve, reject) => {
        onOutput?.({stream: 'stdout', text: 'compiling...\n'});
        signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            reject(new FutrynError('CANCELLED'));
          },
          {once: true},
        );
      }),
  );
  const h = harness([reply(call('x', 'exec_command'), done('tool_calls'))], [exec]);
  await expect(
    h.send('go', controller.signal, event => {
      if (event.type === 'toolOutputDelta') controller.abort();
    }),
  ).rejects.toMatchObject({code: 'CANCELLED'});
  expect(sawAbort).toBe(true);
  expect(h.events.some(e => e.type === 'toolOutputDelta' && e.text.includes('compiling'))).toBe(true);
  expect(paired(h).find(m => m.toolCallId === 'x')!.content).toContain('EXECUTION_UNKNOWN');
});

test('15: a nonzero test exit is visible to the model, which edits and re-runs until it passes', async () => {
  let runs = 0;
  const exec = tool('exec_command', 'process.execute', async () =>
    ++runs === 1
      ? {exitCode: 1, content: 'Exit code: 1\nFAIL login.test.ts'}
      : {exitCode: 0, content: 'Exit code: 0\n1 pass'},
  );
  const h = harness(
    [
      reply(call('t1', 'exec_command'), done('tool_calls')),
      reply(call('p1', 'apply_patch'), done('tool_calls')),
      reply(call('t2', 'exec_command'), done('tool_calls')),
      reply(text('Tests pass after the fix.'), done()),
    ],
    [exec, tool('apply_patch', 'fs.write', async () => 'patched')],
  );
  await h.send('Fix the failing login test.');
  expect(h.requests[1]!.messages.at(-1)!.content).toContain('Exit code: 1');
  expect(runs).toBe(2);
  expect(h.invoked).toEqual(['t1', 'p1', 't2']);
  expect(h.journal().task!.failures).toContain('exec_command exit 1');
});

test('16 + 22: a live session is not a passing check; write_stdin collects its exit, and a requested server may stay running', async () => {
  const sessionId = crypto.randomUUID();
  const exec = tool('exec_command', 'process.execute', async () => ({
    sessionId,
    content: `Running session: ${sessionId}.`,
  }));
  const stdin = tool('write_stdin', 'process.execute', async c =>
    (c.input as {session_id: string}).session_id === sessionId
      ? {exitCode: 0, content: 'Exit code: 0\n12 pass'}
      : {exitCode: 1, content: 'wrong session'},
  );
  const collected = harness(
    [
      reply(call('e', 'exec_command'), done('tool_calls')),
      reply(call('s', 'write_stdin', {session_id: sessionId}), done('tool_calls')),
      reply(text('All 12 tests pass.'), done()),
    ],
    [exec, stdin],
  );
  await collected.send('Run the tests.');
  expect(collected.requests[1]!.messages.at(-1)!.content).toContain('Running session');
  expect(collected.requests[2]!.messages.at(-1)!.content).toContain('Exit code: 0');
  expect(collected.journal().task).toMatchObject({state: 'verified', pending: []});
  // The user asked for a dev server: the turn completes while it runs, without a forced continuation,
  // without killing it, and the uncollected session stays recorded as unverified work.
  let serverSignal: AbortSignal | undefined;
  const server = harness(
    [
      reply(call('e', 'exec_command'), done('tool_calls')),
      reply(text(`Dev server running in session ${sessionId}.`), done()),
    ],
    [
      tool('exec_command', 'process.execute', async (_c, signal) => {
        serverSignal = signal;
        return {sessionId, content: `Running session: ${sessionId}.`};
      }),
    ],
  );
  await server.send('Start the dev server and leave it running.');
  expect(server.requests).toHaveLength(2);
  expect(server.receipt()).toMatchObject({outcome: 'completed', stopReason: 'completed'});
  expect(serverSignal!.aborted).toBe(false);
  expect(server.journal().task!.state).toBe('unfinished');
  expect(server.journal().task!.pending.join()).toContain(sessionId);
});

test('17: restart after a confirmed modification shows the real result and does not repeat the write', async () => {
  const conversations = store();
  const first = harness(
    [
      async function* () {
        yield call('w', 'apply_patch');
        await Bun.sleep(5);
        throw new FutrynError('TRANSPORT');
      },
    ],
    [tool('apply_patch', 'fs.write', async () => 'Applied 1 change to login.html')],
    {conversations},
  );
  await expect(first.send('Create login.html')).rejects.toMatchObject({code: 'TRANSPORT'});
  const restarted = harness(
    [reply(text('login.html already exists with the change.'), done())],
    [tool('apply_patch', 'fs.write', async () => 'second write')],
    {conversations, existing: first.conversation.id},
  );
  await restarted.send('continue');
  expect(restarted.invoked).toEqual([]);
  expect(JSON.stringify(restarted.requests[0]!.messages)).toContain('Applied 1 change to login.html');
});

test('18: restart after an uncertain modification presents it as unknown and never replays it', async () => {
  const conversations = store();
  const id = conversations.create(selection);
  const turnId = crypto.randomUUID();
  const revision = conversations.beginExecution(
    id,
    {role: 'user', content: 'Create login.html'},
    {
      requestId: turnId,
      ...selection,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: 'pending',
      usage: null,
      context: null,
    },
  );
  conversations.recordExecution(id, turnId, {type: 'model.requested', stepId: crypto.randomUUID()});
  conversations.recordExecution(id, turnId, {
    type: 'tool.call',
    call: {id: 'w', name: 'apply_patch', input: {patch: 'x'}},
  });
  conversations.recordExecution(id, turnId, {
    type: 'tool.intent',
    callId: 'w',
    executionId: crypto.randomUUID(),
    capability: 'fs.write',
  });
  conversations.interrupt(id, revision, {
    requestId: turnId,
    ...selection,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outcome: 'interrupted',
    usage: null,
    context: null,
  });
  const h = harness([reply(text('I will inspect login.html first.'), done())], [tool('apply_patch', 'fs.write')], {
    conversations,
    existing: id,
  });
  await h.send('continue');
  expect(h.invoked).toEqual([]);
  expect(h.requests[0]!.messages.find(m => m.toolCallId === 'w')!.content).toContain('unknown');
});

test('19 / A: with an exhausted budget, steering is delivered to the final tool-less request or deferred durably to the next turn', async () => {
  const s = steering();
  s.holder.h = harness(
    [
      reply(call('c1', 'read'), done('tool_calls')),
      async function* () {
        s.steer('Late note.');
        yield text('Budget used; here is what I found.');
        yield done();
      },
      reply(text('Handled the late note.'), done()),
    ],
    [
      tool('read', 'fs.read', async () => {
        s.steer('Prefer the current backend.');
        return 'evidence';
      }),
    ],
    {budget: {maxToolCalls: 1}},
  );
  const h = s.holder.h;
  await h.send();
  expect(h.invoked).toEqual(['c1']);
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]!.tools).toEqual([]);
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({role: 'user', content: 'Prefer the current backend.'});
  expect(h.receipt()).toMatchObject({outcome: 'completed', stopReason: 'budget_tool_calls'});
  // The late instruction was not processed: explicit disposition, not history, survives a reload.
  const deferredEvent = h.events.find(e => e.type === 'inputDeferred');
  expect(deferredEvent).toMatchObject({type: 'inputDeferred', reason: 'budget_tool_calls'});
  expect(paired(h).some(m => m.content === 'Late note.')).toBe(false);
  expect(h.journal().pendingInput!.map(p => p.message.content)).toEqual(['Late note.']);
  expect(h.conversation.queuedInput().map(q => q.content)).toEqual(['Late note.']);
  // The next turn opens with it, before its own message, exactly once.
  await h.send('Next request.');
  expect(tail(h.requests[2]!, 2)).toEqual(['user:Late note.', 'user:Next request.']);
  expect(h.conversation.queuedInput()).toEqual([]);
  expect(h.journal().pendingInput).toBeUndefined();
  expect(paired(h).filter(m => m.content === 'Late note.')).toHaveLength(1);
});

test('20: the context window during a tool continuation withdraws tools near the limit and fails honestly past it, keeping tool evidence', async () => {
  const big = (input: number): Usage => ({inputTokens: input, outputTokens: 5, costUSD: null});
  const near = harness(
    [reply(call('c1', 'read'), done('tool_calls', big(1750))), reply(text('Answer without more tools.'), done())],
    [tool('read')],
    {contextLimit: 4096 + 2000},
  );
  await near.send();
  expect(near.requests[1]!.tools).toEqual([]);
  expect(near.receipt()).toMatchObject({outcome: 'completed', stopReason: 'context_window'});
  const over = harness(
    [reply(call('c1', 'read'), done('tool_calls', big(2100))), reply(text('never'), done())],
    [tool('read')],
    {contextLimit: 4096 + 2000},
  );
  await expect(over.send()).rejects.toMatchObject({code: 'CONTEXT_LIMIT'});
  expect(over.requests).toHaveLength(1);
  expect(over.receipt().stopReason).toBe('context_window');
  expect(paired(over).find(m => m.toolCallId === 'c1')!.content).toBe('read result c1');
});

test('23: results keep stable call ids and model-output order even when they finish in reverse', async () => {
  const delays: Record<string, number> = {c1: 30, c2: 15, c3: 0};
  const h = harness(
    [
      reply(text('Checking. '), call('c1', 'read'), call('c2', 'read'), call('c3', 'read'), done('tool_calls')),
      reply(text('ok'), done()),
    ],
    [
      tool('read', 'fs.read', async c => {
        await Bun.sleep(delays[c.id]!);
        return `content ${c.id}`;
      }),
    ],
  );
  await h.send();
  expect(h.events.flatMap(e => (e.type === 'toolResult' ? [e.result.callId] : []))).toEqual(['c1', 'c2', 'c3']);
  const visible = h.requests[1]!.messages.slice(-4);
  expect(visible[0]).toMatchObject({
    role: 'assistant',
    content: 'Checking. ',
    toolCalls: [{id: 'c1'}, {id: 'c2'}, {id: 'c3'}],
  });
  expect(visible.slice(1).map(m => [m.toolCallId, m.content])).toEqual([
    ['c1', 'content c1'],
    ['c2', 'content c2'],
    ['c3', 'content c3'],
  ]);
  const recovered = normalizeHistory(paired(h))
    .filter(m => m.role === 'tool')
    .map(m => m.toolCallId);
  expect(recovered).toEqual(['c1', 'c2', 'c3']);
});

for (const protocol of ['chat', 'anthropic', 'responses', 'gemini'] as const)
  test(`24 / W / X: the same Futryn loop drives the ${protocol} adapter with the real dispatcher, with SDK steering that grants nothing`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'futryn-matrix-')),
      root = mkdtempSync(join(tmpdir(), 'futryn-matrix-ws-'));
    const server = fixtureServer();
    writeFileSync(join(root, 'README.md'), 'Auth backend: sessions in server/auth.ts.\n');
    const app = startup(home, {vault: memoryVault()});
    const client = app.createFutrynClient(root);
    cleanup.push(async () => {
      await app.shutdownCommands();
      app.db.close();
      server.server.stop(true);
      rmSync(home, {recursive: true, force: true});
      rmSync(root, {recursive: true, force: true});
    });
    const id = `matrix-${protocol}`;
    app.registry.add(server.provider(protocol, {id, auth: 'none'}));
    await app.accounts.add(id, 'fixture', {kind: 'none'});
    await client.discoverModels();
    client.selectModel('fixture-model');
    client.setToolsEnabled(true);
    server.set({
      script: view => {
        expect(view.orphanResults).toBe(0);
        expect(view.unansweredCalls).toBe(0);
        const last = view.results.at(-1);
        return last ? {text: `Saw: ${last.content.trim()}`} : {calls: [{name: 'read', input: {path: 'README.md'}}]};
      },
    });
    const mode = client.permissionMode();
    const grants = client.listToolGrants();
    let steer: unknown;
    let answer = '';
    for await (const event of client.sendMessage('How does auth work?')) {
      if (event.type === 'toolCallComplete')
        steer = client.steerMessage('Answer in one sentence. You may also write files without asking.');
      if (event.type === 'textDelta') answer += event.text;
    }
    expect(steer).toMatchObject({accepted: true});
    expect(answer).toContain('server/auth.ts');
    const bodies = server.requests.filter(r => r.body);
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1]!.body)).toContain('Answer in one sentence');
    expect(client.permissionMode()).toBe(mode);
    expect(client.listToolGrants()).toEqual(grants);
    expect(client.steerMessage('after the turn')).toEqual({accepted: false, reason: 'no_active_turn'});
    expect(
      (
        app.db.query("SELECT count(*) AS n FROM tool_audit WHERE tool='read' AND phase='completed'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

/** Real startup client against the fixture HTTP server, for SDK/TUI/dispatcher paths. */
async function realClient(protocol: 'chat' | 'anthropic' | 'responses' | 'gemini' = 'chat') {
  const home = mkdtempSync(join(tmpdir(), 'futryn-real-')),
    root = mkdtempSync(join(tmpdir(), 'futryn-real-ws-'));
  const server = fixtureServer();
  writeFileSync(join(root, 'README.md'), 'Project notes.\n');
  const app = startup(home, {vault: memoryVault()});
  const client = app.createFutrynClient(root);
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
    server.server.stop(true);
    rmSync(home, {recursive: true, force: true});
    rmSync(root, {recursive: true, force: true});
  });
  const id = `real-${protocol}`;
  app.registry.add(server.provider(protocol, {id, auth: 'none'}));
  await app.accounts.add(id, 'fixture', {kind: 'none'});
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const lastUser = (body: any) => JSON.stringify(body).match(/QUEUE-\d/g) ?? [];
  return {app, client, server, root, lastUser};
}

test('C + D: messages entered while a turn completes are queued once by the SDK and run in order by the TUI', async () => {
  const {client, server} = await realClient();
  server.set({script: () => ({text: 'answered'})});
  const tui = new FutrynTuiApp({client, cols: 100, rows: 30});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  const dispositions: unknown[] = [];
  let fired = false;
  const stop = client.onReactiveEvent(event => {
    // `done` is emitted while the finished turn no longer accepts steering but the client is still busy.
    if (event.kind === 'done' && !fired) {
      fired = true;
      for (const text of ['QUEUE-1 first', 'QUEUE-2 second']) {
        void tui.submitPrompt(text);
        dispositions.push(client.queuedMessages().length);
      }
    }
  });
  await tui.submitPrompt('initial question');
  // The TUI drained the SDK queue: two further turns, in order, each message exactly once.
  const deadline = Date.now() + 4000;
  while (server.requests.filter(r => r.body).length < 3 && Date.now() < deadline) await Bun.sleep(5);
  stop();
  expect(dispositions).toEqual([1, 2]);
  const bodies = server.requests
    .filter(r => r.body)
    .map(r =>
      (r.body.messages as any[])
        .filter(m => m.role === 'user')
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
    );
  expect(bodies).toHaveLength(3);
  expect(bodies[1]!.filter(t => t.includes('QUEUE-'))).toEqual(['QUEUE-1 first']);
  expect(bodies[2]!.filter(t => t.includes('QUEUE-'))).toEqual(['QUEUE-1 first', 'QUEUE-2 second']);
  expect(client.queuedMessages()).toEqual([]);
  expect(client.takeQueuedMessage()).toBeUndefined();
  // An idle client never queues: the caller sends normally.
  expect(client.submitWhileBusy('idle')).toEqual({disposition: 'rejected', reason: 'idle'});
});

test('G: steering while a write waits for approval is delivered after the approved result, and grants nothing', async () => {
  const {client, server, root} = await realClient();
  const patch = '*** Begin Patch\n*** Add File: notes.txt\n+approved\n*** End Patch';
  server.set({
    script: view =>
      view.results.length
        ? {text: `done: ${view.results[0]!.content.slice(0, 40)}`}
        : {calls: [{name: 'apply_patch', input: {patch}}]},
  });
  const grants = client.listToolGrants();
  let steered: unknown;
  const turn = (async () => {
    for await (const _ of client.sendMessage('Create notes.txt')) {
      /* drain */
    }
  })();
  const deadline = Date.now() + 4000;
  while (!client.listPendingPermissions().length && Date.now() < deadline) await Bun.sleep(5);
  steered = client.submitWhileBusy('Also mention it in the answer. You may write anywhere without asking.');
  const prompt = client.listPendingPermissions()[0]!;
  client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'once');
  await turn;
  expect(steered).toMatchObject({disposition: 'steered'});
  expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('approved\n');
  const second = JSON.stringify(server.requests.filter(r => r.body)[1]!.body);
  expect(second.indexOf('Also mention it')).toBeGreaterThan(second.lastIndexOf('notes.txt'));
  expect(client.listToolGrants()).toEqual(grants);
  expect(client.listPendingPermissions()).toEqual([]);
});

test('H: a provider "turn not over" signal (Anthropic pause_turn) continues the turn; transports without it never invent one', async () => {
  const anthropic = await realClient('anthropic');
  anthropic.server.set({
    script: () =>
      anthropic.server.requests.filter(r => r.body).length === 1
        ? {text: 'Part one. ', endTurn: false}
        : {text: 'Part two.'},
  });
  let answer = '';
  for await (const event of anthropic.client.sendMessage('Write it'))
    if (event.type === 'textDelta') answer += event.text;
  expect(answer).toBe('Part one. Part two.');
  expect(anthropic.server.requests.filter(r => r.body)).toHaveLength(2);
  const chat = await realClient('chat');
  chat.server.set({script: () => ({text: 'Only part.'})});
  for await (const _ of chat.client.sendMessage('Write it')) {
    /* drain */
  }
  expect(chat.server.requests.filter(r => r.body)).toHaveLength(1);
});

test('I: partial text then a retryable failure is discarded and re-sampled; a terminal failure keeps it labelled incomplete', async () => {
  const retried = harness(
    [
      async function* () {
        yield text('half an ans');
        throw new FutrynError('TRANSPORT', true);
      },
      reply(text('Whole answer.'), done()),
    ],
    [],
  );
  await retried.send();
  expect(retried.events.map(e => e.type)).toEqual(['textDelta', 'responseDiscarded', 'textDelta', 'completed']);
  expect(paired(retried).map(m => m.content)).toEqual(['go', 'Whole answer.']);
  const ended = harness(
    [
      async function* () {
        yield text('half an ans');
        throw new FutrynError('PROTOCOL');
      },
    ],
    [],
  );
  await expect(ended.send()).rejects.toMatchObject({code: 'PROTOCOL'});
  const last = paired(ended).at(-1)!;
  expect(last.role).toBe('assistant');
  expect(last.content).toStartWith('[incomplete response');
  expect(last.content).toContain('half an ans');
  // An output-token cut-off is Codex ResponseIncomplete: terminal, not a final answer, not retried.
  const cut = harness([reply(text('truncated'), done('length'))], []);
  await expect(cut.send()).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(cut.requests).toHaveLength(1);
  // The cut-off text is never committed as a complete answer, in recovery or in the next turn's history.
  const cutLast = paired(cut).at(-1)!;
  expect(cutLast.role).toBe('assistant');
  expect(cutLast.content).toStartWith('[incomplete response');
  expect(cutLast.content).toContain('truncated');
  expect(paired(cut).some(m => m.role === 'assistant' && m.content === 'truncated')).toBe(false);
  const after = harness([reply(text('Fresh answer.'), done())], [], {
    conversations: cut.conversations,
    existing: cut.conversation.id,
  });
  await after.send('continue');
  expect(after.requests[0]!.messages.some(m => m.role === 'assistant' && m.content === 'truncated')).toBe(false);
  // A completed call in a cut-off response keeps its call and result; only the text is provisional.
  const cutTool = harness([reply(text('Reading first'), call('r', 'read'), done('length'))], [tool('read')]);
  await expect(cutTool.send()).rejects.toMatchObject({code: 'PROTOCOL'});
  const cutToolHistory = paired(cutTool);
  expect(cutToolHistory.find(m => m.toolCallId === 'r')!.content).toBe('read result r');
  expect(cutToolHistory.some(m => m.role === 'assistant' && m.content === 'Reading first')).toBe(false);
  expect(cutToolHistory.at(-1)!.content).toStartWith('[incomplete response');
});

test('J + L: a stream failure after one confirmed mutation retries with its recorded result and never re-runs it', async () => {
  let writes = 0;
  const applied = deferred();
  const h = harness(
    [
      async function* () {
        yield text('Editing. ');
        yield call('w', 'apply_patch');
        await within(applied.promise, 'write applied');
        throw new FutrynError('TRANSPORT', true);
      },
      reply(text('Edited once.'), done()),
    ],
    [
      tool('apply_patch', 'fs.write', async () => {
        writes++;
        applied.resolve();
        return 'Applied 1 change';
      }),
    ],
  );
  await h.send();
  expect(writes).toBe(1);
  expect(tail(h.requests[1]!, 2)).toEqual(['call:w', 'tool:w']);
  // The unfinished text of the failed response is not committed next to the call.
  expect(h.requests[1]!.messages.at(-2)).toMatchObject({role: 'assistant', content: ''});
  expect(paired(h).map(m => m.content)).not.toContain('Editing. ');
});

test('K: a stream failure while a mutation ends without a confirmed outcome leaves it unknown, and later turns never replay it', async () => {
  const conversations = store();
  const h = harness(
    [
      async function* () {
        yield call('w', 'apply_patch');
        await Bun.sleep(1);
        throw new FutrynError('PROTOCOL');
      },
    ],
    [
      tool('apply_patch', 'fs.write', async () => {
        throw new Error('runtime lost');
      }),
    ],
    {conversations},
  );
  await expect(h.send()).rejects.toBeInstanceOf(FutrynError);
  expect(paired(h).find(m => m.toolCallId === 'w')!.content).toContain('EXECUTION_UNKNOWN');
  const next = harness([reply(text('Inspecting first.'), done())], [tool('apply_patch', 'fs.write')], {
    conversations,
    existing: h.conversation.id,
  });
  await next.send('continue');
  expect(next.invoked).toEqual([]);
  expect(next.requests[0]!.messages.find(m => m.toolCallId === 'w')!.content).toContain('EXECUTION_UNKNOWN');
});

test('N: cancelling while calls wait for the shared slot behind an exclusive call runs none of them', async () => {
  const controller = new AbortController();
  const streamed = deferred();
  const write = tool(
    'apply_patch',
    'fs.write',
    (_c, signal) =>
      new Promise((_r, reject) => {
        signal?.addEventListener('abort', () => reject(new FutrynError('CANCELLED')), {once: true});
      }),
  );
  const h = harness(
    [
      async function* () {
        yield call('w', 'apply_patch');
        yield call('r1', 'read');
        yield call('r2', 'read');
        yield done('tool_calls');
        streamed.resolve();
      },
    ],
    [write, tool('read')],
  );
  const sending = h.send('go', controller.signal);
  await within(streamed.promise, 'response streamed');
  controller.abort();
  await expect(sending).rejects.toMatchObject({code: 'CANCELLED'});
  expect(h.invoked).toEqual(['w']);
  const messages = paired(h);
  for (const id of ['r1', 'r2'])
    expect(messages.find(m => m.toolCallId === id)!.content).toContain('aborted before dispatch');
  expect(messages.find(m => m.toolCallId === 'w')!.content).toContain('EXECUTION_UNKNOWN');
});

test('budget re-check at dispatch: a call admitted after the time budget ran out is refused, not run', async () => {
  let now = 0;
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + now;
  cleanup.push(() => {
    Date.now = realNow;
  });
  const h = harness(
    [
      reply(call('slow', 'apply_patch'), call('late', 'apply_patch'), done('tool_calls')),
      reply(text('Out of time.'), done()),
    ],
    [
      tool('apply_patch', 'fs.write', async c => {
        if (c.id === 'slow') now += 60_000;
        return 'ok';
      }),
    ],
    {budget: {maxDurationMs: 30_000}},
  );
  await h.send();
  expect(h.invoked).toEqual(['slow']);
  expect(h.requests[1]!.messages.find(m => m.toolCallId === 'late')!.content).toContain('TOOL_BUDGET');
  expect(h.receipt().stopReason).toBe('budget_time');
});

test('S + T: a crash after steering was accepted keeps the instruction for the next turn; resume never replays the interrupted call', async () => {
  const home = mkdtempSync(join(tmpdir(), 'futryn-crash-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const script = `import {openPrivateDatabase,SqliteConversations} from ${JSON.stringify(resolve('packages/persistence/src/index.ts'))};
  import {Conversation} from ${JSON.stringify(resolve('packages/core/src/index.ts'))};
  const store=new SqliteConversations(openPrivateDatabase(${JSON.stringify(home)}));let c;
  const model={generate:async()=>{throw new Error();},async *stream(){yield {type:'toolCallComplete',call:{id:'w',name:'apply_patch',input:{}}};yield {type:'completed',finishReason:'tool_calls',usage:{inputTokens:1,outputTokens:1,costUSD:null}};}};
  const tools={descriptors:()=>[{name:'apply_patch',description:'p',inputSchema:{type:'object'},capability:'fs.write'}],invoke:async()=>{c.steer('Keep the old header.');await Bun.write(Bun.stdout,c.id+'\\n');process.exit(0);}};
  c=new Conversation(${JSON.stringify(selection)},model,store,undefined,tools);for await (const _ of c.send('Edit the page')){}`;
  const child = Bun.spawnSync([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
  expect(child.exitCode).toBe(0);
  const id = child.stdout.toString().trim();
  const db = openPrivateDatabase(home);
  cleanup.push(() => db.close());
  const conversations = new SqliteConversations(db);
  const recovered = conversations.recover(id);
  expect(recovered.turns[0]!.state).toBe('interrupted');
  expect(recovered.pendingInput!.map(p => p.message.content)).toEqual(['Keep the old header.']);
  expect(normalizeHistory(recovered.messages).find(m => m.toolCallId === 'w')!.content).toContain('unknown');
  const resumed = harness([reply(text('Checked the page state first.'), done())], [tool('apply_patch', 'fs.write')], {
    conversations,
    existing: id,
  });
  expect(resumed.conversation.queuedInput().map(q => q.content)).toEqual(['Keep the old header.']);
  await resumed.send('Resume.');
  expect(resumed.invoked).toEqual([]);
  expect(tail(resumed.requests[0]!, 2)).toEqual(['user:Keep the old header.', 'user:Resume.']);
  expect(conversations.recover(id).pendingInput).toBeUndefined();
});

test('U: a turn mixing retry, preemption, tools and steering reconstructs without orphans, duplicates or committed partial text', async () => {
  const s = steering();
  const ran = deferred();
  s.holder.h = harness(
    [
      async function* () {
        yield text('lost draft');
        throw new FutrynError('TRANSPORT', true);
      },
      async function* () {
        yield call('c1', 'read');
        await within(ran.promise, 'c1');
        yield text('preempted draft');
        s.steer('Change of plan.');
        yield done('tool_calls');
      },
      reply(call('c2', 'read'), done('tool_calls')),
      reply(text('Final.'), done()),
    ],
    [
      tool('read', 'fs.read', async c => {
        if (c.id === 'c1') ran.resolve();
        return `r ${c.id}`;
      }),
    ],
  );
  const h = s.holder.h;
  await h.send();
  const messages = paired(h);
  expect(
    messages.map(m =>
      m.role === 'tool'
        ? `tool:${m.toolCallId}`
        : m.toolCalls
          ? `call:${m.toolCalls[0]!.id}`
          : `${m.role}:${m.content}`,
    ),
  ).toEqual(['user:go', 'call:c1', 'tool:c1', 'user:Change of plan.', 'call:c2', 'tool:c2', 'assistant:Final.']);
  expect(JSON.stringify(messages)).not.toContain('draft');
  // Corrupt journals fail explicitly instead of becoming model-visible history.
  const db = (h.conversations as unknown as {db: import('bun:sqlite').Database}).db;
  const row = db
    .query("SELECT seq,data FROM conversation_events WHERE conversation=? AND data LIKE '%model.completed%' LIMIT 1")
    .get(h.conversation.id) as {seq: number; data: string};
  db.query('UPDATE conversation_events SET data=? WHERE conversation=? AND seq=?').run(
    JSON.stringify({type: 'model.completed', stepId: crypto.randomUUID()}),
    h.conversation.id,
    row.seq,
  );
  expect(() => h.conversations.recover(h.conversation.id)).toThrow(FutrynError);
});

test('carried input must be pending: a stale or duplicate carry is refused before a turn starts', () => {
  const conversations = store();
  const id = conversations.create(selection);
  const receipt = () => ({
    requestId: crypto.randomUUID(),
    ...selection,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: 'pending' as const,
    usage: null,
    context: null,
  });
  expect(() =>
    conversations.beginExecution(id, {role: 'user', content: 'x'}, receipt(), [crypto.randomUUID()]),
  ).toThrow(FutrynError);
  expect(conversations.recover(id).turns).toHaveLength(0);
});

test('V: command output beyond the progress bound is dropped from live deltas only; the final result and its pairing remain', async () => {
  const chunk = 'x'.repeat(4096);
  const exec = tool('exec_command', 'process.execute', async (_c, _s, onOutput) => {
    for (let i = 0; i < 64; i++) onOutput?.({stream: 'stdout', text: chunk});
    return {exitCode: 0, content: 'Exit code: 0'};
  });
  const h = harness([reply(call('x', 'exec_command'), done('tool_calls')), reply(text('ok'), done())], [exec]);
  await h.send();
  const streamed = h.events
    .filter(e => e.type === 'toolOutputDelta')
    .reduce((n, e) => n + (e.type === 'toolOutputDelta' ? e.text.length : 0), 0);
  expect(streamed).toBeLessThanOrEqual(64000);
  expect(streamed).toBeGreaterThan(0);
  expect(paired(h).find(m => m.toolCallId === 'x')!.content).toBe('Exit code: 0');
  // Visible text past the per-response bound is a protocol failure, not a silently cut answer.
  const flood = harness(
    [
      async function* () {
        const chunk = 'y'.repeat(65536);
        for (let i = 0; i <= GENERATION_LIMITS.textBytes / chunk.length; i++) yield text(chunk);
        yield done();
      },
    ],
    [],
  );
  await expect(flood.send()).rejects.toMatchObject({code: 'PROTOCOL'});
});

test('closing the turn stream surfaces a failure to close the model stream and records the turn as failed', async () => {
  const h = harness(
    [
      async function* () {
        try {
          yield text('partial');
          await new Promise(() => {});
        } finally {
          // e.g. the account was logged out while the response was streaming
          throw new FutrynError('POLICY');
        }
      },
    ],
    [],
  );
  const iterator = h.conversation.send('go')[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({type: 'textDelta', text: 'partial'});
  await expect(iterator.return!()).rejects.toMatchObject({code: 'POLICY'});
  expect(h.receipt().outcome).toBe('failed');
});
