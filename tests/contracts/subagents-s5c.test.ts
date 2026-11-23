import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {HostAgentsConfig, ModelInfo, SubagentParentLimits, SubagentWorktreePort} from '@cosmew/contracts';
import {
  SubagentManager,
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
  run?: (context: ChildRunContext, signal: AbortSignal) => Promise<string>;
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
      const id = options.models?.[ref] ?? ref;
      return id === 'parent-model' || options.models?.[ref]
        ? {
            selection: {...selection, modelId: id},
            model: {id, capabilities: {tools: 'supported'}} as unknown as ModelInfo,
          }
        : undefined;
    },
    availableModelIds: () => ['parent-model'],
    store,
    worktrees: options.worktrees,
    worktreeHandoff: options.handoff,
    runChildTurn: async function* (context, signal) {
      contexts.push(context);
      yield {type: 'started', requestId: crypto.randomUUID()} as never;
      yield {type: 'textDelta', text: await (options.run?.(context, signal) ?? Promise.resolve('done'))} as never;
    },
    addParentUsage: () => undefined,
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
  m.subagents.scheduler.getTask(id)!.usage = usage(500, 400);
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
