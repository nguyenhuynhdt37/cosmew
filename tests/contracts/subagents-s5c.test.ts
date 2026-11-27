import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
  HostAgentsConfig,
  ModelEvent,
  ModelInfo,
  SubagentParentLimits,
  SubagentWorktreePort,
  Usage,
} from '@cosmew/contracts';
import {
  BUILTIN_AGENT_PROFILES,
  SubagentManager,
  deductChildLimits,
  inheritChildLimits,
  reserveForChildren,
  NO_RESERVATION,
  normalizeAgentsConfig,
  type ChildRunContext,
} from '@cosmew/agents';
import {loadHostAgents} from '@cosmew/models';
import {SqliteConversations, openPrivateDatabase} from '@cosmew/persistence';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const baseConfig = (): HostAgentsConfig => normalizeAgentsConfig({});
const usage = (input: number, output: number, cost: number | null = null) => ({
  inputTokens: input,
  outputTokens: output,
  costUSD: cost,
});

test('inheritChildLimits: child gets the parent caps minus parent and running-sibling usage; spent caps refuse', () => {
  const parent: SubagentParentLimits = {
    maxOutputTokens: 1000,
    maxEstimatedCostUSD: 1,
    budget: {maxTokens: 10_000, maxCostUSD: 2, maxDurationMs: 60_000, maxSteps: 7},
    usage: usage(2000, 300, 0.5),
    elapsedMs: 10_000,
  };
  const result = inheritChildLimits(
    parent,
    {tokens: 1200, outputTokens: 200, budgetCostUSD: 0.25, capCostUSD: 0.25},
    baseConfig(),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.limits.maxOutputTokens).toBe(500); // 1000 - (300 + 200)
  expect(result.limits.maxEstimatedCostUSD).toBeCloseTo(0.25);
  expect(result.limits.budget).toMatchObject({maxTokens: 6500, maxSteps: 7, maxDurationMs: 50_000});
  expect(result.limits.budget.maxCostUSD).toBeCloseTo(1.25);

  // Each cap on its own refuses once spent.
  const spent = (patch: Partial<SubagentParentLimits>, used = usage(0, 0)) =>
    inheritChildLimits({budget: {}, usage: used, elapsedMs: 0, ...patch}, NO_RESERVATION, baseConfig());
  expect(spent({maxOutputTokens: 100}, usage(10, 100)).ok).toBe(false);
  expect(spent({budget: {maxTokens: 100}}, usage(60, 40)).ok).toBe(false);
  expect(spent({budget: {maxCostUSD: 1}}, usage(1, 1, 1)).ok).toBe(false);
  expect(spent({maxEstimatedCostUSD: 1}, usage(1, 1, 1.5)).ok).toBe(false);
  expect(spent({budget: {maxDurationMs: 5000}, elapsedMs: 5000}).ok).toBe(false);
  // No caps at all: nothing is invented.
  expect(inheritChildLimits(undefined, NO_RESERVATION, baseConfig())).toEqual({ok: true, limits: {budget: {}}});
});

test('[agents] max_child_* ceilings apply on top of the inherited remainder', () => {
  const loaded = loadHostAgents({
    agents: {max_child_tokens: 5000, max_child_duration_ms: 30_000, max_child_cost_usd: 0.5},
  });
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded).toMatchObject({maxChildTokens: 5000, maxChildDurationMs: 30_000, maxChildCostUSD: 0.5});
  const bad = loadHostAgents({agents: {max_child_tokens: -1, max_child_cost_usd: 'x'}});
  expect(bad.maxChildTokens).toBeUndefined();
  expect(bad.diagnostics).toHaveLength(2);

  const config = normalizeAgentsConfig(loaded);
  const limits = inheritChildLimits(
    {budget: {maxTokens: 3000, maxDurationMs: 90_000}, usage: null, elapsedMs: 0},
    NO_RESERVATION,
    config,
  );
  expect(limits.ok && limits.limits.budget).toEqual({maxTokens: 3000, maxDurationMs: 30_000, maxCostUSD: 0.5});
});

test('parallel children cannot together exceed the parent cap; a finished child releases its unused reservation', () => {
  const parent: SubagentParentLimits = {
    maxEstimatedCostUSD: 1,
    maxOutputTokens: 1000,
    budget: {maxTokens: 10_000, maxCostUSD: 1},
    usage: null,
    elapsedMs: 0,
  };
  // Child A takes the whole remainder as its grant; B finds nothing left to promise.
  const a = inheritChildLimits(parent, NO_RESERVATION, baseConfig());
  expect(a.ok).toBe(true);
  if (!a.ok) return;
  const reserved = reserveForChildren([{limits: a.limits, usage: null}]);
  expect(reserved).toMatchObject({tokens: 10_000, outputTokens: 1000, capCostUSD: 1});
  expect(inheritChildLimits(parent, reserved, baseConfig()).ok).toBe(false);
  // A smaller grant leaves the rest to a sibling, and the sum of grants never exceeds the cap.
  const noOutputCap = {...parent, maxOutputTokens: undefined, maxEstimatedCostUSD: undefined};
  const small = inheritChildLimits(
    noOutputCap,
    NO_RESERVATION,
    normalizeAgentsConfig({maxChildTokens: 4000, maxChildCostUSD: 0.4}),
  );
  if (!small.ok) throw new Error('expected grant');
  const b = inheritChildLimits(noOutputCap, reserveForChildren([{limits: small.limits, usage: null}]), baseConfig());
  if (!b.ok) throw new Error('expected grant');
  expect((small.limits.budget.maxTokens ?? 0) + (b.limits.budget.maxTokens ?? 0)).toBeLessThanOrEqual(10_000);
  expect((small.limits.budget.maxCostUSD ?? 0) + (b.limits.budget.maxCostUSD ?? 0)).toBeLessThanOrEqual(1 + 1e-9);
  // Released (child finished, usage folded into the parent): only what it actually spent counts.
  const folded = inheritChildLimits({...parent, usage: usage(100, 50, 0.1)}, NO_RESERVATION, baseConfig());
  expect(folded.ok && folded.limits.maxEstimatedCostUSD).toBeCloseTo(0.9);
  // A running child that overshoots its grant reserves what it used.
  expect(reserveForChildren([{limits: small.limits, usage: usage(9000, 10, 0.9)}]).tokens).toBe(9010);
});

function manager(options: {
  config?: Partial<HostAgentsConfig>;
  depth?: number;
  limits?: () => SubagentParentLimits | undefined;
  worktrees?: SubagentWorktreePort;
  handoff?: () => string;
  redact?: (text: string) => string;
  models?: Record<string, string>;
  modelEfforts?: Record<string, string[]>;
  run?: (context: ChildRunContext, signal: AbortSignal) => Promise<string>;
  runEvents?: (context: ChildRunContext, signal: AbortSignal) => AsyncIterable<ModelEvent>;
  onParentUsage?: (usage: Usage) => void;
  deliverToParent?: (parentId: string, text: string) => 'steered' | 'queued';
}) {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-s5c-'));
  const db = openPrivateDatabase(dir);
  cleanup.push(() => {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  });
  const store = new SqliteConversations(db, s => s);
  const selection = {accountId: '00000000-0000-4000-8000-000000000010', modelId: 'parent-model'};
  const parentId = store.create(selection);
  const contexts: ChildRunContext[] = [];
  const subagents = new SubagentManager({
    depth: options.depth,
    getConfig: () => ({maxThreads: 4, maxDepth: 2, ...options.config}),
    getParentState: () => ({
      sessionId: parentId,
      selection,
      analysisOnly: false,
      messages: [],
      limits: options.limits?.(),
    }),
    lookupModel: ref => {
      const bare = ref.includes(':') ? ref.split(':').slice(1).join(':') : ref;
      const id =
        options.models?.[ref] ?? options.models?.[bare] ?? (bare === 'parent-model' ? 'parent-model' : undefined);
      if (!id) return undefined;
      const reasoningEfforts = options.modelEfforts?.[id];
      return {
        selection: {...selection, modelId: id},
        model: {
          id,
          capabilities: {tools: 'supported'},
          ...(reasoningEfforts ? {reasoningEfforts} : {}),
        } as unknown as ModelInfo,
      };
    },
    availableModelIds: () => ['parent-model'],
    store,
    worktrees: options.worktrees,
    worktreeHandoff: options.handoff,
    runChildTurn: async function* (context, signal) {
      contexts.push(context);
      if (options.runEvents) {
        yield* options.runEvents(context, signal);
        return;
      }
      yield {type: 'started', requestId: crypto.randomUUID()} as never;
      yield {type: 'textDelta', text: await (options.run?.(context, signal) ?? Promise.resolve('done'))} as never;
    },
    addParentUsage: u => options.onParentUsage?.(u),
    deliverToParent: options.deliverToParent,
    redact: options.redact ?? (text => text),
    waitMinMs: 5,
  });
  return {subagents, store, parentId, contexts, selection};
}
const spawn = (m: ReturnType<typeof manager>, extra: Record<string, unknown> = {}) =>
  m.subagents.run('call-1', {agent_type: 'explore', description: 'look', prompt: 'go', ...extra});

test('a child receives the parent turn caps; the parent refuses new agent calls once its cap is spent', async () => {
  let limits: SubagentParentLimits = {
    maxOutputTokens: 800,
    maxEstimatedCostUSD: 2,
    budget: {maxTokens: 5000},
    usage: usage(1000, 300, 0.4),
    elapsedMs: 0,
  };
  const m = manager({limits: () => limits});
  const ok = await spawn(m);
  expect(ok.status).toBe('ok');
  expect(m.contexts[0]!.limits.maxOutputTokens).toBe(500);
  expect(m.contexts[0]!.limits.maxEstimatedCostUSD).toBeCloseTo(1.6);
  expect(m.contexts[0]!.limits.budget.maxTokens).toBe(3700);

  limits = {...limits, usage: usage(4000, 1000, 0.4)}; // 5000 tokens used: the token budget is spent
  const refused = await spawn(m);
  expect(refused).toMatchObject({status: 'error', code: 'AGENT_BUDGET_EXHAUSTED'});
  expect(m.contexts).toHaveLength(1); // no second child ran
  expect(m.store.listSubagentSessions(m.parentId)).toHaveLength(1);

  limits = {...limits, usage: usage(10, 900, 0.4)}; // output cap (800) spent
  expect((await spawn(m)).code).toBe('AGENT_BUDGET_EXHAUSTED');
});

test('running siblings count against the cap before they finish', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const m = manager({
    limits: () => ({budget: {maxTokens: 1000}, usage: usage(100, 0), elapsedMs: 0}),
    run: async context => {
      if (context.prompt === 'first') await gate;
      return 'ok';
    },
  });
  // A running child has used 900 tokens (reported through consumeTurn's usage events, mirrored on the task).
  const first = m.subagents.run('call-a', {agent_type: 'explore', description: 'a', prompt: 'first', background: true});
  const id = JSON.parse((await first).content).id as string;
  const liveTask = m.subagents.scheduler.getTask(id)!;
  liveTask.usage = usage(500, 400);
  liveTask.turnUsage = usage(500, 400);
  expect((await spawn(m, {prompt: 'second'})).code).toBe('AGENT_BUDGET_EXHAUSTED');
  release();
});

test('parallel children cannot together exceed the parent cap; the reservation is released when the child finishes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const m = manager({
    limits: () => ({maxEstimatedCostUSD: 1, budget: {maxTokens: 1000, maxCostUSD: 1}, usage: null, elapsedMs: 0}),
    run: async context => {
      if (context.prompt === 'first') await gate;
      return 'ok';
    },
  });
  const first = m.subagents.run('call-a', {agent_type: 'explore', description: 'a', prompt: 'first', background: true});
  const id = JSON.parse((await first).content).id as string;
  // The first child was granted the whole remainder, so a parallel sibling gets nothing.
  expect(m.contexts[0]!.limits.budget.maxTokens).toBe(1000);
  expect((await spawn(m, {prompt: 'second'})).code).toBe('AGENT_BUDGET_EXHAUSTED');
  expect(m.contexts).toHaveLength(1);
  release();
  await m.subagents.scheduler.getTask(id)!.done;
  // Finished: its reservation is released (usage was folded into the parent, which reports none here).
  expect((await spawn(m, {prompt: 'third'})).status).toBe('ok');
});

test('per-type model defaults and per-call model/effort override', async () => {
  const m = manager({
    config: {roles: {explore: {model: 'cheap'}}},
    models: {cheap: 'cheap', pricey: 'pricey'},
  });
  await spawn(m);
  expect(m.contexts[0]!.selection.modelId).toBe('cheap');
  await spawn(m, {agent_type: 'worker', description: 'w'});
  expect(m.contexts[1]!.selection.modelId).toBe('parent-model'); // worker has no role default
  await spawn(m, {model: 'pricey'});
  expect(m.contexts[2]!.selection.modelId).toBe('pricey'); // explicit argument beats the role default
  const unknown = await spawn(m, {model: 'nope'});
  expect(unknown).toMatchObject({status: 'error', code: 'INVALID_INPUT'});
});

function fakeWorktrees(options: {changed?: boolean; refuse?: string} = {}) {
  const calls: string[] = [];
  const port: SubagentWorktreePort = {
    acquire: id => {
      calls.push(`acquire:${id}`);
      return options.refuse
        ? {ok: false, code: 'UNSUPPORTED', message: options.refuse}
        : {
            ok: true,
            worktree: {path: `/wt/${id}`, branch: `futryn/agent-${id.slice(0, 8)}`, gitCommonDir: '/repo/.git'},
          };
    },
    finish: id => {
      calls.push(`finish:${id}`);
      return {
        changed: options.changed === true,
        worktree: {path: `/wt/${id}`, branch: 'futryn/agent-x', gitCommonDir: '/repo/.git'},
      };
    },
  };
  return {port, calls};
}

test('isolation worktree: child runs in the worktree; unchanged is removed, changed is kept and reported', async () => {
  const clean = fakeWorktrees();
  const a = manager({worktrees: clean.port});
  const result = await spawn(a, {isolation: 'worktree'});
  expect(result.status).toBe('ok');
  expect(a.contexts[0]!.worktree?.path).toMatch(/^\/wt\//);
  expect(result.content).toContain('no changes and was removed');
  expect(clean.calls.map(c => c.split(':')[0])).toEqual(['acquire', 'finish']);
  expect(a.store.listSubagentSessions(a.parentId)[0]!.isolation).toBe('worktree');

  const dirty = fakeWorktrees({changed: true});
  const b = manager({worktrees: dirty.port});
  const kept = await spawn(b, {isolation: 'worktree'});
  expect(kept.content).toContain('Worktree kept with changes: /wt/');
  expect(kept.content).toContain('branch futryn/agent-x');

  // Without isolation no worktree is touched and the child has no worktree.
  const c = manager({worktrees: dirty.port});
  await spawn(c);
  expect(c.contexts[0]!.worktree).toBeUndefined();
});

test('isolation worktree: refusals leave nothing running (non-git, no port, nested, resume depth)', async () => {
  const nonGit = fakeWorktrees({refuse: 'isolation "worktree" needs a Git repository'});
  const a = manager({worktrees: nonGit.port});
  const refused = await spawn(a, {isolation: 'worktree'});
  expect(refused).toMatchObject({status: 'error', code: 'UNSUPPORTED'});
  expect(refused.content).toContain('needs a Git repository');
  expect(a.contexts).toHaveLength(0);
  expect(a.subagents.scheduler.activeCount()).toBe(0);
  expect(a.store.listSubagentSessions(a.parentId)[0]!.status).toBe('failed');

  expect((await spawn(manager({}), {isolation: 'worktree'})).code).toBe('UNSUPPORTED');
  const nested = manager({depth: 1, worktrees: fakeWorktrees().port});
  expect((await spawn(nested, {isolation: 'worktree'})).code).toBe('UNSUPPORTED');
});

test('a worktree child that wrote changes in the background keeps them and notifies with the path', async () => {
  const dirty = fakeWorktrees({changed: true});
  const delivered: string[] = [];
  const m = manager({worktrees: dirty.port});
  (m.subagents as unknown as {deps: {deliverToParent: (p: string, t: string) => 'queued'}}).deps.deliverToParent = (
    _p,
    t,
  ) => {
    delivered.push(t);
    return 'queued';
  };
  const started = await spawn(m, {isolation: 'worktree', background: true});
  expect(JSON.parse(started.content).status).toBe('running');
  for (let n = 0; n < 200 && !delivered.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(delivered[0]).toContain('Worktree kept with changes');
  expect(dirty.calls.filter(c => c.startsWith('finish'))).toHaveLength(1);
});

test('agent_message cannot resume an idle child into a background loop below the root session', async () => {
  const m = manager({depth: 1});
  const id = m.store.create(m.selection);
  m.store.saveSubagentSession({
    id,
    parentConversationId: m.parentId,
    parentTurnId: null,
    callId: 'c',
    depth: 2,
    agentType: 'explore',
    description: 'idle',
    prompt: 'p',
    selection: m.selection,
    forkContext: false,
    background: false,
    status: 'completed',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const outcome = await m.subagents.message({id, message: 'again'});
  expect(outcome).toMatchObject({status: 'error', code: 'UNSUPPORTED'});
  expect(m.contexts).toHaveLength(0);
  expect(m.subagents.scheduler.activeCount()).toBe(0);
});

test('foreground and background suppress whole machine handoffs if raw or decoded patch content requires redaction', async () => {
  const secret = 'secret<&token';
  const redact = (text: string) => text.replaceAll(secret, '[REDACTED]');
  for (const escaped of [false, true])
    for (const background of [false, true]) {
      const patch = '*** Begin Patch\n*** Add File: token.txt\n+' + secret + '\n*** End Patch';
      const input = {patch, expected_files: {'token.txt': null}};
      let json = JSON.stringify(input);
      if (escaped) json = json.replaceAll('<', '\\u003c').replaceAll('&', '\\u0026');
      const m = manager({worktrees: fakeWorktrees({changed: true}).port, handoff: () => json, redact});
      const delivered: string[] = [];
      (m.subagents as unknown as {deps: {deliverToParent: (p: string, t: string) => 'queued'}}).deps.deliverToParent = (
        _p,
        text,
      ) => {
        delivered.push(text);
        return 'queued';
      };
      const result = await spawn(m, {isolation: 'worktree', background});
      if (background)
        for (let n = 0; n < 200 && !delivered.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
      const output = background ? delivered[0]! : result.content;
      expect(output).toContain('Automatic patch suppressed');
      expect(output).not.toContain(secret);
      expect(output).not.toContain('secret');
      expect(output).not.toContain('*** Begin Patch');
      expect(output).not.toContain('expected_files');
    }
});

test('an unchanged machine handoff remains byte-exact in foreground and background', async () => {
  const json = JSON.stringify({
    patch: '*** Begin Patch\n*** Add File: x\n+safe\n*** End Patch',
    expected_files: {x: null},
  });
  for (const background of [false, true]) {
    const m = manager({worktrees: fakeWorktrees({changed: true}).port, handoff: () => json, redact: text => text});
    const delivered: string[] = [];
    (m.subagents as unknown as {deps: {deliverToParent: (p: string, t: string) => 'queued'}}).deps.deliverToParent = (
      _p,
      text,
    ) => {
      delivered.push(text);
      return 'queued';
    };
    const result = await spawn(m, {isolation: 'worktree', background});
    if (background)
      for (let n = 0; n < 200 && !delivered.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(background ? delivered[0]! : result.content).toContain(json);
  }
});

test('explore and plan subagents cap maxSteps and maxToolCalls via Math.min(parent, roleDefault)', async () => {
  const uncapped = manager({});
  await spawn(uncapped, {agent_type: 'explore'});
  expect(uncapped.contexts[0]!.limits.budget).toMatchObject({maxSteps: 12, maxToolCalls: 24});

  await spawn(uncapped, {agent_type: 'plan'});
  expect(uncapped.contexts[1]!.limits.budget).toMatchObject({maxSteps: 14, maxToolCalls: 28});

  await spawn(uncapped, {agent_type: 'worker'});
  expect(uncapped.contexts[2]!.limits.budget.maxSteps).toBeUndefined();
  expect(uncapped.contexts[2]!.limits.budget.maxToolCalls).toBeUndefined();

  // Parent caps tighter than role defaults stay enforced; looser parent caps get clamped down.
  let parentBudget: SubagentParentLimits = {
    budget: {maxSteps: 5, maxToolCalls: 40},
    usage: null,
    elapsedMs: 0,
  };
  const capped = manager({limits: () => parentBudget});
  await spawn(capped, {agent_type: 'explore'});
  expect(capped.contexts[0]!.limits.budget).toMatchObject({maxSteps: 5, maxToolCalls: 24});

  parentBudget = {budget: {maxSteps: 30, maxToolCalls: 10}, usage: null, elapsedMs: 0};
  await spawn(capped, {agent_type: 'plan'});
  expect(capped.contexts[1]!.limits.budget).toMatchObject({maxSteps: 14, maxToolCalls: 10});

  // Direct inheritChildLimits preserves 3-arg compatibility while clamping when roleDefaults is passed.
  const direct = inheritChildLimits(
    {budget: {maxSteps: 50, maxToolCalls: 100}, usage: null, elapsedMs: 0},
    NO_RESERVATION,
    baseConfig(),
    BUILTIN_AGENT_PROFILES.explore.defaultBudget,
  );
  expect(direct.ok && direct.limits.budget).toEqual({maxSteps: 12, maxToolCalls: 24});
});

test('background inbox loop accumulates usage across turns and inspectSubagent sums all stored turns', async () => {
  let releaseTurn1!: () => void;
  const gateTurn1 = new Promise<void>(resolve => (releaseTurn1 = resolve));
  const delivered: string[] = [];
  let turnIndex = 0;

  const m = manager({
    deliverToParent: (_p, text) => {
      delivered.push(text);
      return 'queued';
    },
    runEvents: async function* (context) {
      turnIndex++;
      yield {type: 'started', requestId: crypto.randomUUID()};
      if (turnIndex === 1) {
        await gateTurn1;
        const u1 = usage(100, 50, 0.1);
        yield {type: 'usage', usage: u1};
        yield {type: 'textDelta', text: 'part 1'};
        yield {type: 'completed', finishReason: 'stop', usage: u1};
      } else {
        const u2 = usage(40, 20, 0.05);
        yield {type: 'usage', usage: u2};
        yield {type: 'textDelta', text: `part 2: ${context.prompt}`};
        yield {type: 'completed', finishReason: 'stop', usage: u2};
      }
    },
  });

  const started = await spawn(m, {background: true, prompt: 'turn 1'});
  const id = JSON.parse(started.content).id as string;

  // Queue a follow-up in task.inbox while turn 1 is still running.
  const msgOutcome = await m.subagents.message({id, message: 'turn 2'});
  expect(JSON.parse(msgOutcome.content).delivery).toBe('queued');

  releaseTurn1();
  for (let n = 0; n < 200 && !delivered.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(delivered).toHaveLength(1);
  expect(m.contexts).toHaveLength(2);

  // Live task usage must reflect the sum across turn 1 + turn 2, never overwritten by turn 2 alone.
  const task = m.subagents.scheduler.getTask(id)!;
  expect(task.usage?.inputTokens).toBe(140);
  expect(task.usage?.outputTokens).toBe(70);
  expect(task.usage?.costUSD).toBeCloseTo(0.15);

  const inspectedLive = m.subagents.inspectSubagent(id)!;
  expect(inspectedLive.usage?.inputTokens).toBe(140);
  expect(inspectedLive.usage?.outputTokens).toBe(70);

  // Also verify inspectSubagent sums all persisted turns when no live task is in memory.
  const r1 = {
    requestId: crypto.randomUUID(),
    accountId: m.selection.accountId,
    modelId: m.selection.modelId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outcome: 'completed' as const,
    usage: usage(100, 50, 0.1),
    context: null,
  };
  const rev1 = m.store.beginExecution(id, {role: 'user', content: 'turn 1'}, r1);
  m.store.complete(id, rev1, {role: 'assistant', content: 'part 1'}, r1);
  const r2 = {
    requestId: crypto.randomUUID(),
    accountId: m.selection.accountId,
    modelId: m.selection.modelId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outcome: 'completed' as const,
    usage: usage(40, 20, 0.05),
    context: null,
  };
  const rev2 = m.store.beginExecution(id, {role: 'user', content: 'turn 2'}, r2);
  m.store.complete(id, rev2, {role: 'assistant', content: 'part 2'}, r2);
  m.subagents.scheduler.removeTask(id);

  const inspectedStored = m.subagents.inspectSubagent(id)!;
  expect(inspectedStored.usage?.inputTokens).toBe(140);
  expect(inspectedStored.usage?.outputTokens).toBe(70);
  expect(inspectedStored.usage?.costUSD).toBeCloseTo(0.15);
});

test('background inbox loop deducts spent budget before continuing and halts with BUDGET when exhausted', async () => {
  // Case 1: partial budget spent in turn 1 -> turn 2 inherits strictly reduced remaining limits.
  {
    let releaseTurn1!: () => void;
    const gateTurn1 = new Promise<void>(resolve => (releaseTurn1 = resolve));
    const delivered: string[] = [];
    let turnIndex = 0;

    const m = manager({
      limits: () => ({
        maxOutputTokens: 400,
        maxEstimatedCostUSD: 1.0,
        budget: {maxTokens: 1000, maxCostUSD: 1.0, maxDurationMs: 20_000},
        usage: null,
        elapsedMs: 0,
      }),
      deliverToParent: (_p, text) => {
        delivered.push(text);
        return 'queued';
      },
      runEvents: async function* () {
        turnIndex++;
        yield {type: 'started', requestId: crypto.randomUUID()};
        if (turnIndex === 1) {
          await gateTurn1;
          const u1 = usage(250, 150, 0.25); // 400 total tokens, 150 output, $0.25
          yield {type: 'textDelta', text: 'first'};
          yield {type: 'completed', finishReason: 'stop', usage: u1};
        } else {
          const u2 = usage(100, 50, 0.1);
          yield {type: 'textDelta', text: 'second'};
          yield {type: 'completed', finishReason: 'stop', usage: u2};
        }
      },
    });

    const started = await spawn(m, {background: true, prompt: 'one'});
    const id = JSON.parse(started.content).id as string;
    await m.subagents.message({id, message: 'two'});
    releaseTurn1();
    for (let n = 0; n < 200 && !delivered.length; n++) await new Promise(resolve => setTimeout(resolve, 5));

    expect(m.contexts).toHaveLength(2);
    expect(m.contexts[1]!.limits.budget.maxTokens).toBe(600);
    expect(m.contexts[1]!.limits.maxOutputTokens).toBe(250);
    expect(m.contexts[1]!.limits.budget.maxCostUSD).toBeCloseTo(0.75);
    expect(m.contexts[1]!.limits.maxEstimatedCostUSD).toBeCloseTo(0.75);
    expect(m.contexts[1]!.limits.budget.maxDurationMs).toBeLessThanOrEqual(20_000);
  }

  // Case 2: budget exhausted after turn 1 -> inbox follow-up must NOT run, child finishes with errorCode BUDGET.
  for (const scenario of [
    {
      name: 'maxTokens',
      parentLimits: {budget: {maxTokens: 500}, usage: null, elapsedMs: 0} as SubagentParentLimits,
      spent: usage(350, 150),
    },
    {
      name: 'maxCostUSD',
      parentLimits: {budget: {maxCostUSD: 0.2}, usage: null, elapsedMs: 0} as SubagentParentLimits,
      spent: usage(100, 50, 0.25),
    },
    {
      name: 'maxEstimatedCostUSD',
      parentLimits: {maxEstimatedCostUSD: 0.2, budget: {}, usage: null, elapsedMs: 0} as SubagentParentLimits,
      spent: usage(100, 50, 0.2),
    },
    {
      name: 'maxOutputTokens',
      parentLimits: {maxOutputTokens: 100, budget: {}, usage: null, elapsedMs: 0} as SubagentParentLimits,
      spent: usage(50, 100),
    },
  ]) {
    let releaseTurn1!: () => void;
    const gateTurn1 = new Promise<void>(resolve => (releaseTurn1 = resolve));
    const delivered: string[] = [];

    const m = manager({
      limits: () => scenario.parentLimits,
      deliverToParent: (_p, text) => {
        delivered.push(text);
        return 'queued';
      },
      runEvents: async function* () {
        yield {type: 'started', requestId: crypto.randomUUID()};
        await gateTurn1;
        yield {type: 'textDelta', text: `done-${scenario.name}`};
        yield {type: 'completed', finishReason: 'stop', usage: scenario.spent};
      },
    });

    const started = await spawn(m, {background: true, prompt: 'one'});
    const id = JSON.parse(started.content).id as string;
    await m.subagents.message({id, message: 'should-not-run'});
    releaseTurn1();
    for (let n = 0; n < 200 && !delivered.length; n++) await new Promise(resolve => setTimeout(resolve, 5));

    expect(m.contexts).toHaveLength(1);
    expect(delivered[0]).toContain('error="BUDGET"');
    const view = m.subagents.inspectSubagent(id)!;
    expect(view.status).toBe('failed');
    expect(view.errorCode).toBe('BUDGET');
  }
});

test('agent_message preserves reasoningEffort when waking an idle subagent', async () => {
  const m = manager({
    config: {
      defaultReasoningEffort: 'medium',
      roles: {explore: {reasoningEffort: 'low'}},
    },
    modelEfforts: {'parent-model': ['low', 'medium', 'high']},
  });

  // 1. Explore role with role-level reasoningEffort: 'low'.
  const expStarted = await spawn(m, {agent_type: 'explore', background: true, prompt: 'scan'});
  const expId = JSON.parse(expStarted.content).id as string;
  await m.subagents.scheduler.getTask(expId)!.done;
  expect(m.contexts[0]!.reasoningEffort).toBe('low');

  const expResumed = await m.subagents.message({id: expId, message: 'follow up'});
  expect(JSON.parse(expResumed.content).delivery).toBe('resumed');
  await m.subagents.scheduler.getTask(expId)!.done;
  expect(m.contexts[1]!.reasoningEffort).toBe('low');

  // 2. Worker role without role override inherits cfg.defaultReasoningEffort: 'medium'.
  const wrkStarted = await spawn(m, {agent_type: 'worker', description: 'edit', background: true, prompt: 'work'});
  const wrkId = JSON.parse(wrkStarted.content).id as string;
  await m.subagents.scheduler.getTask(wrkId)!.done;
  expect(m.contexts[2]!.reasoningEffort).toBe('medium');

  const wrkResumed = await m.subagents.message({id: wrkId, message: 'continue'});
  expect(JSON.parse(wrkResumed.content).delivery).toBe('resumed');
  await m.subagents.scheduler.getTask(wrkId)!.done;
  expect(m.contexts[3]!.reasoningEffort).toBe('medium');

  // 3. Even when the in-memory task is gone (restart / evicted), resume still restores profile/config reasoningEffort.
  m.subagents.scheduler.removeTask(expId);
  const expAfterRestart = await m.subagents.message({id: expId, message: 'after restart'});
  expect(JSON.parse(expAfterRestart.content).delivery).toBe('resumed');
  await m.subagents.scheduler.getTask(expId)!.done;
  expect(m.contexts[4]!.reasoningEffort).toBe('low');

  // 4. Explicit per-call reasoning_effort on spawn is preserved while the task remains in memory.
  const explicitStarted = await spawn(m, {
    agent_type: 'explore',
    reasoning_effort: 'high',
    background: true,
    prompt: 'deep scan',
  });
  const explicitId = JSON.parse(explicitStarted.content).id as string;
  await m.subagents.scheduler.getTask(explicitId)!.done;
  expect(m.contexts[5]!.reasoningEffort).toBe('high');

  const explicitResumed = await m.subagents.message({id: explicitId, message: 'keep high'});
  expect(JSON.parse(explicitResumed.content).delivery).toBe('resumed');
  await m.subagents.scheduler.getTask(explicitId)!.done;
  expect(m.contexts[6]!.reasoningEffort).toBe('high');
});

test('deductChildLimits rejects exhausted duration and updates remaining child caps across dimensions', () => {
  const initial = {
    maxOutputTokens: 300,
    maxEstimatedCostUSD: 1.0,
    budget: {maxTokens: 1000, maxCostUSD: 1.0, maxDurationMs: 5000, maxSteps: 12, maxToolCalls: 24},
  };
  const partial = deductChildLimits(initial, usage(200, 100, 0.25), 1500);
  expect(partial.ok).toBe(true);
  if (partial.ok) {
    expect(partial.limits.maxOutputTokens).toBe(200);
    expect(partial.limits.maxEstimatedCostUSD).toBeCloseTo(0.75);
    expect(partial.limits.budget).toMatchObject({
      maxTokens: 700,
      maxDurationMs: 3500,
      maxSteps: 12,
      maxToolCalls: 24,
    });
    expect(partial.limits.budget.maxCostUSD).toBeCloseTo(0.75);
  }
  const timeOut = deductChildLimits(initial, usage(10, 10, 0.01), 5000);
  expect(timeOut).toMatchObject({ok: false, what: 'time budget'});
});

test('background inbox loop checks parentCapsExceeded with projected finalUsage before starting follow-up turn', async () => {
  let releaseTurn1!: () => void;
  const gateTurn1 = new Promise<void>(resolve => (releaseTurn1 = resolve));
  const delivered: string[] = [];
  let parentSpent: Usage | null = usage(400, 200); // 600 tokens already spent by parent

  const m = manager({
    config: {maxChildTokens: 500},
    limits: () => ({budget: {maxTokens: 1000}, usage: parentSpent, elapsedMs: 0}),
    onParentUsage: u => {
      parentSpent = parentSpent
        ? {
            inputTokens: (parentSpent.inputTokens ?? 0) + (u.inputTokens ?? 0),
            outputTokens: (parentSpent.outputTokens ?? 0) + (u.outputTokens ?? 0),
            costUSD: null,
          }
        : u;
    },
    deliverToParent: (_p, text) => {
      delivered.push(text);
      return 'queued';
    },
    runEvents: async function* () {
      yield {type: 'started', requestId: crypto.randomUUID()};
      await gateTurn1;
      // Child was granted min(1000 - 600, 500) = 400 tokens; suppose parent concurrently spent 100 more tokens
      // while child used 300 tokens -> child still has 100 left in its own 400 grant, but parent total (700 + 300 = 1000) hits cap!
      parentSpent = usage(500, 200);
      yield {type: 'textDelta', text: 'turn-1-done'};
      yield {type: 'completed', finishReason: 'stop', usage: usage(200, 100)};
    },
  });

  const started = await spawn(m, {background: true, prompt: 'one'});
  const id = JSON.parse(started.content).id as string;
  await m.subagents.message({id, message: 'two-must-not-run'});
  releaseTurn1();
  for (let n = 0; n < 200 && !delivered.length; n++) await new Promise(resolve => setTimeout(resolve, 5));

  expect(m.contexts).toHaveLength(1);
  expect(delivered[0]).toContain('error="BUDGET"');
  expect(delivered[0]).toContain('parent turn budget is exhausted');
  expect(m.subagents.inspectSubagent(id)?.status).toBe('failed');
  expect(m.subagents.inspectSubagent(id)?.errorCode).toBe('BUDGET');
});

test('reservedForChildren uses per-turn turnUsage instead of cumulative task.usage across resumed turns', async () => {
  let releaseTurn2!: () => void;
  const gateTurn2 = new Promise<void>(resolve => (releaseTurn2 = resolve));
  let parentSpent: Usage | null = null;
  let turnCount = 0;

  const m = manager({
    config: {maxChildTokens: 300},
    limits: () => ({budget: {maxTokens: 700}, usage: parentSpent, elapsedMs: 0}),
    onParentUsage: u => {
      parentSpent = parentSpent
        ? {
            inputTokens: (parentSpent.inputTokens ?? 0) + (u.inputTokens ?? 0),
            outputTokens: (parentSpent.outputTokens ?? 0) + (u.outputTokens ?? 0),
            costUSD: null,
          }
        : u;
    },
    runEvents: async function* (ctx) {
      if (ctx.prompt === 'sibling') {
        yield {type: 'started', requestId: crypto.randomUUID()};
        yield {type: 'textDelta', text: 'sibling ok'};
        yield {type: 'completed', finishReason: 'stop', usage: usage(10, 10)};
        return;
      }
      turnCount++;
      yield {type: 'started', requestId: crypto.randomUUID()};
      if (turnCount === 1) {
        // Turn 1 uses 280 tokens -> folded into parentSpent (280), task.usage = 280.
        yield {type: 'textDelta', text: 'turn 1'};
        yield {type: 'completed', finishReason: 'stop', usage: usage(200, 80)};
      } else {
        // Turn 2 streams 150 tokens so far -> cumulative task.usage = 430, but turnUsage = 150 (within 300 reservation).
        // Parent spent (280) + child reservation max(300, 150) = 580 < 700, leaving 120 tokens for a sibling!
        // If cumulative task.usage (430) were used instead, 280 + 430 = 710 >= 700 would falsely exhaust the budget!
        yield {type: 'usage', usage: usage(100, 50)};
        await gateTurn2;
        yield {type: 'textDelta', text: 'turn 2'};
        yield {type: 'completed', finishReason: 'stop', usage: usage(100, 50)};
      }
    },
  });

  const first = await spawn(m, {background: true, prompt: 'turn-1'});
  const id = JSON.parse(first.content).id as string;
  await m.subagents.scheduler.getTask(id)!.done;
  expect(parentSpent).toMatchObject({inputTokens: 200, outputTokens: 80});

  const resumed = await m.subagents.message({id, message: 'turn-2'});
  expect(JSON.parse(resumed.content).delivery).toBe('resumed');
  for (let n = 0; n < 100 && m.contexts.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 10));

  const sibling = await spawn(m, {prompt: 'sibling'});
  expect(sibling.status).toBe('ok');
  expect(m.contexts.at(-1)?.limits.budget.maxTokens).toBe(120);

  releaseTurn2();
  await m.subagents.scheduler.getTask(id)!.done;
});

test('agent_message omits reasoningEffort on models without reasoningEfforts and clears stale errorCode/finishedAt', async () => {
  let shouldFail = true;
  const m = manager({
    config: {
      defaultReasoningEffort: 'medium',
      roles: {explore: {reasoningEffort: 'low'}},
    },
    // Note: modelEfforts omitted -> found.model.reasoningEfforts is undefined ([]).
    runEvents: async function* () {
      yield {type: 'started', requestId: crypto.randomUUID()};
      if (shouldFail) {
        throw new Error('boom');
      }
      yield {type: 'textDelta', text: 'recovered'};
      yield {type: 'completed', finishReason: 'stop', usage: usage(10, 5)};
    },
  });

  const started = await spawn(m, {agent_type: 'explore', background: true, prompt: 'initial'});
  const id = JSON.parse(started.content).id as string;
  await m.subagents.scheduler.getTask(id)!.done;
  expect(m.contexts[0]!.reasoningEffort).toBeUndefined();
  expect(m.subagents.inspectSubagent(id)?.status).toBe('failed');
  expect(m.subagents.inspectSubagent(id)?.errorCode).toBe('EXECUTION_FAILED');

  shouldFail = false;
  const resumed = await m.subagents.message({id, message: 'retry cleanly'});
  expect(JSON.parse(resumed.content).delivery).toBe('resumed');
  await m.subagents.scheduler.getTask(id)!.done;

  expect(m.contexts[1]!.reasoningEffort).toBeUndefined();
  const after = m.subagents.inspectSubagent(id)!;
  expect(after.status).toBe('completed');
  expect(after.errorCode).toBeUndefined();
  expect(m.store.getSubagentSession(id)?.errorCode).toBeUndefined();
});

test('agent_message rejects unsteerable follow-ups to a busy foreground subagent with AGENT_BUSY', async () => {
  let releaseFg!: () => void;
  const gateFg = new Promise<void>(resolve => (releaseFg = resolve));
  let startedId: string | undefined;

  const m = manager({
    run: async context => {
      startedId = context.agentId;
      await gateFg;
      return 'foreground done';
    },
  });

  const fgPromise = spawn(m, {background: false, prompt: 'foreground job'});
  for (let n = 0; n < 100 && !startedId; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(startedId).toBeDefined();

  const busy = await m.subagents.message({id: startedId!, message: 'cannot queue on foreground'});
  expect(busy).toEqual({
    status: 'error',
    code: 'AGENT_BUSY',
    content: 'Foreground subagent cannot queue follow-up messages while busy; wait for it to finish first.',
  });
  expect(m.subagents.scheduler.getTask(startedId!)?.inbox).toEqual([]);

  releaseFg();
  expect((await fgPromise).status).toBe('ok');
});

test('scheduler.shutdown awaits synchronous worktree/DB cleanup and preserves toolCount, steps and agentId attribution', async () => {
  const worktrees = fakeWorktrees({changed: true});
  const attributedUsages: Usage[] = [];
  const finishedEvents: Array<{toolCount: number; stepsCount: number; status: string}> = [];
  let childEnteredTool = false;

  const m = manager({
    worktrees: worktrees.port,
    onParentUsage: u => attributedUsages.push(u),
    runEvents: async function* (_ctx, signal) {
      yield {type: 'started', requestId: crypto.randomUUID()};
      yield {type: 'usage', usage: usage(30, 10)};
      yield {type: 'toolCallComplete', call: {id: 'tc-1', name: 'read', input: {path: 'a.ts'}}};
      yield {
        type: 'toolResult',
        result: {callId: 'tc-1', name: 'read', status: 'ok', content: 'file content'},
      };
      childEnteredTool = true;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      });
    },
  });

  let syncAgentId: string | undefined;
  const runPromise = m.subagents.run(
    'call-sync-shutdown',
    {agent_type: 'worker', description: 'sync isolated worker', prompt: 'work', isolation: 'worktree'},
    undefined,
    ev => {
      if (ev.type === 'subagent.started') syncAgentId = ev.agentId;
      if (ev.type === 'subagent.finished') {
        finishedEvents.push({toolCount: ev.toolCount, stepsCount: ev.steps?.length ?? 0, status: ev.status});
      }
    },
  );

  for (let n = 0; n < 100 && !childEnteredTool; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(childEnteredTool).toBe(true);
  expect(syncAgentId).toBeDefined();

  // Shutdown must wait until synchronous subagent finishes worktree cleanup and DB update.
  await m.subagents.shutdown();
  expect(worktrees.calls).toEqual([`acquire:${syncAgentId}`, `finish:${syncAgentId}`]);
  expect(m.store.getSubagentSession(syncAgentId!)?.status).toBe('cancelled');
  expect(finishedEvents).toEqual([{toolCount: 1, stepsCount: 1, status: 'cancelled'}]);
  expect(attributedUsages[0]?.breakdown?.[0]?.agentId).toBe(syncAgentId);
  expect(m.subagents.scheduler.listTasks()).toHaveLength(0);

  const outcome = await runPromise;
  expect(outcome.status).toBe('error');
  expect(outcome.code).toBe('CANCELLED');
});
