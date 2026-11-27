import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
  CONTRACT_VERSION,
  DEFAULT_AGENT_MAX_DEPTH,
  DEFAULT_AGENT_MAX_THREADS,
  agentToolInputSchema,
  type ToolDescriptor,
} from '@cosmew/contracts';
import {
  BUILTIN_AGENT_PROFILES,
  SubagentScheduler,
  effectiveSubagentSandbox,
  exceedsAgentDepth,
  filterSubagentTools,
  formatSubagentResultContent,
  isToolAllowedForProfile,
  nextAgentDepth,
  normalizeAgentsConfig,
  parseSubagentResultContent,
  prepareForkedParentMessages,
  resolveAgentProfile,
  resolveSubagentModelAndEffort,
} from '@cosmew/agents';
import {loadHostAgents} from '@cosmew/models';
import {SqliteConversations, openPrivateDatabase} from '@cosmew/persistence';
import {SessionGrants} from '@cosmew/security';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const SAMPLE_DESCRIPTORS: ToolDescriptor[] = [
  {name: 'read', capability: 'fs.read', parallel: true, description: 'read', inputSchema: {}},
  {name: 'glob', capability: 'fs.read', parallel: true, description: 'glob', inputSchema: {}},
  {name: 'grep', capability: 'fs.read', parallel: true, description: 'grep', inputSchema: {}},
  {name: 'lsp', capability: 'code.intel', parallel: true, description: 'lsp', inputSchema: {}},
  {name: 'lsp_rename', capability: 'fs.write', description: 'lsp_rename', inputSchema: {}},
  {name: 'web_search', capability: 'network.search', parallel: true, description: 'web_search', inputSchema: {}},
  {name: 'web_fetch', capability: 'network.fetch', parallel: true, description: 'web_fetch', inputSchema: {}},
  {name: 'skill', capability: 'fs.read', parallel: true, description: 'skill', inputSchema: {}},
  {name: 'memory', capability: 'agent.state', parallel: true, description: 'memory', inputSchema: {}},
  {name: 'exec_command', capability: 'process.execute', description: 'exec_command', inputSchema: {}},
  {name: 'write_stdin', capability: 'process.execute', description: 'write_stdin', inputSchema: {}},
  {name: 'apply_patch', capability: 'fs.write', description: 'apply_patch', inputSchema: {}},
  {name: 'edit', capability: 'fs.write', description: 'edit', inputSchema: {}},
  {name: 'write', capability: 'fs.write', description: 'write', inputSchema: {}},
  {name: 'update_plan', capability: 'agent.state', description: 'update_plan', inputSchema: {}},
  {name: 'request_user_input', capability: 'user.input', description: 'request_user_input', inputSchema: {}},
  {name: 'agent', capability: 'agent.spawn', parallel: true, description: 'agent', inputSchema: {}},
];

test('contract version is bumped to 1.68 and Codex defaults are preserved', () => {
  expect(CONTRACT_VERSION).toBe('1.68');
  expect(DEFAULT_AGENT_MAX_THREADS).toBe(6);
  expect(DEFAULT_AGENT_MAX_DEPTH).toBe(1);
  expect(
    agentToolInputSchema.safeParse({
      agent_type: 'explore',
      description: 'find auth routes',
      prompt: 'Check where login is handled.',
    }).success,
  ).toBe(true);
});

test('built-in profiles restrict tool sets and sandbox modes (never widening parent authority)', () => {
  const explore = BUILTIN_AGENT_PROFILES.explore;
  const worker = BUILTIN_AGENT_PROFILES.worker;
  const general = BUILTIN_AGENT_PROFILES.general;
  const plan = BUILTIN_AGENT_PROFILES.plan;

  const exploreTools = filterSubagentTools(SAMPLE_DESCRIPTORS, explore, {depth: 1, maxDepth: 1}).map(d => d.name);
  expect(exploreTools).toEqual(['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'exec_command']);
  expect(exploreTools).not.toContain('edit');
  expect(exploreTools).not.toContain('write');
  expect(exploreTools).not.toContain('apply_patch');
  expect(exploreTools).not.toContain('request_user_input');
  expect(exploreTools).not.toContain('agent');
  expect(exploreTools).not.toContain('memory');

  // In parent Plan/Review (analysisOnly) mode, explore also loses exec_command.
  const exploreInPlanMode = filterSubagentTools(SAMPLE_DESCRIPTORS, explore, {
    depth: 1,
    maxDepth: 1,
    parentAnalysisOnly: true,
  }).map(d => d.name);
  expect(exploreInPlanMode).not.toContain('exec_command');

  // Worker has full tools except request_user_input, memory, and agent (at depth 1 == maxDepth 1).
  const workerTools = filterSubagentTools(SAMPLE_DESCRIPTORS, worker, {depth: 1, maxDepth: 1}).map(d => d.name);
  expect(workerTools).toContain('edit');
  expect(workerTools).toContain('write');
  expect(workerTools).toContain('apply_patch');
  expect(workerTools).toContain('exec_command');
  expect(workerTools).not.toContain('request_user_input');
  expect(workerTools).not.toContain('memory');
  expect(workerTools).not.toContain('agent');
  expect(isToolAllowedForProfile('agent', worker, {depth: 1, maxDepth: 1})).toBe(false);
  expect(isToolAllowedForProfile('agent', worker, {depth: 1, maxDepth: 2})).toBe(true);

  // General has full tools except request_user_input, memory, and agent at depth 1.
  const generalTools = filterSubagentTools(SAMPLE_DESCRIPTORS, general, {depth: 1, maxDepth: 1}).map(d => d.name);
  expect(generalTools).toEqual(workerTools);

  // Plan is strictly read-only plus update_plan (no exec_command, no writes).
  const planTools = filterSubagentTools(SAMPLE_DESCRIPTORS, plan, {depth: 1, maxDepth: 1}).map(d => d.name);
  expect(planTools).toEqual(['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'update_plan']);

  // Explore and Plan clamp parent sandbox to read-only with escalation disabled.
  const parent: {
    enabled: boolean;
    readOnly?: boolean;
    allowUnsandboxed: boolean;
    excludedCommands: string[];
    additionalDirectories: string[];
    network: boolean;
  } = {
    enabled: false,
    allowUnsandboxed: true,
    excludedCommands: ['git'],
    additionalDirectories: ['/tmp/extra'],
    network: true,
  };
  expect(effectiveSubagentSandbox(parent, explore)).toEqual({
    enabled: true,
    readOnly: true,
    allowUnsandboxed: false,
    excludedCommands: [],
    additionalDirectories: [],
    network: false,
  });
  // Worker inherits parent sandbox.
  expect(effectiveSubagentSandbox(parent, worker)).toEqual(parent);
});

test('host config parses [agents] max_threads, max_depth and per-role overrides with diagnostics', () => {
  const valid = loadHostAgents({
    agents: {
      max_threads: 4,
      max_depth: 2,
      model: 'fast-default',
      reasoning_effort: 'medium',
      explore: {
        model: 'haiku-explore',
        reasoning_effort: 'low',
      },
      worker: {
        model: 'sonnet-worker',
        reasoning_effort: 'high',
      },
    },
  });
  expect(valid.diagnostics).toEqual([]);
  expect(valid.maxThreads).toBe(4);
  expect(valid.maxDepth).toBe(2);
  expect(valid.defaultModel).toBe('fast-default');
  expect(valid.defaultReasoningEffort).toBe('medium');
  expect(valid.roles.explore).toEqual({model: 'haiku-explore', reasoningEffort: 'low'});
  expect(valid.roles.worker).toEqual({model: 'sonnet-worker', reasoningEffort: 'high'});

  const invalid = loadHostAgents({
    agents: {
      max_threads: 99,
      max_depth: 0,
      reasoning_effort: 'extreme',
      unknown_role: {model: 'x'},
    },
  });
  expect(invalid.maxThreads).toBe(DEFAULT_AGENT_MAX_THREADS);
  expect(invalid.maxDepth).toBe(DEFAULT_AGENT_MAX_DEPTH);
  expect(invalid.diagnostics.length).toBeGreaterThanOrEqual(4);
});

test('SubagentScheduler enforces max_threads (6 default) and rejects the 7th concurrent reservation', () => {
  const scheduler = new SubagentScheduler(DEFAULT_AGENT_MAX_THREADS);
  const reservations = [];
  for (let i = 0; i < 6; i++) {
    const res = scheduler.tryReserveSlot();
    expect(res.ok).toBe(true);
    if (res.ok) reservations.push(res.reservation);
  }
  expect(scheduler.activeCount()).toBe(6);
  const seventh = scheduler.tryReserveSlot();
  expect(seventh).toEqual({ok: false, maxThreads: 6, active: 6});

  reservations[0]!.release();
  expect(scheduler.activeCount()).toBe(5);
  const afterRelease = scheduler.tryReserveSlot();
  expect(afterRelease.ok).toBe(true);
  if (afterRelease.ok) afterRelease.reservation.release();
  for (const r of reservations.slice(1)) r.release();
  expect(scheduler.activeCount()).toBe(0);
});

test('SessionGrants.createChild inherits only fs.read and revokes when parent clears', () => {
  const parent = new SessionGrants();
  parent.grant('fs.read', '/workspace/.env');
  parent.grant('process.execute', 'cmd-grant');
  parent.grant('fs.write', 'patch-grant');
  parent.grant('network.connect', 'https://example.com');

  const child = parent.createChild();
  expect(child.has('fs.read', '/workspace/.env')).toBe(true);
  expect(child.has('process.execute', 'cmd-grant')).toBe(false);
  expect(child.has('fs.write', 'patch-grant')).toBe(false);
  expect(child.has('network.connect', 'https://example.com')).toBe(false);

  // Child-specific grant does not leak into parent.
  child.grant('process.execute', 'child-only-cmd');
  expect(child.has('process.execute', 'child-only-cmd')).toBe(true);
  expect(parent.has('process.execute', 'child-only-cmd')).toBe(false);

  // Clearing parent clears child grants too.
  parent.clear();
  expect(child.has('fs.read', '/workspace/.env')).toBe(false);
  expect(child.has('process.execute', 'child-only-cmd')).toBe(false);
});

test('prepareForkedParentMessages strips unanswered in-flight tool calls and preserves completed turns', () => {
  const messages = prepareForkedParentMessages([
    {role: 'user', content: 'Inspect files'},
    {
      role: 'assistant',
      content: 'Reading a.ts and spawning subagent',
      toolCalls: [
        {id: 'call-read', name: 'read', input: {path: 'a.ts'}},
        {id: 'call-agent', name: 'agent', input: {agent_type: 'explore', description: 'sub', prompt: 'go'}},
      ],
    },
    {role: 'tool', content: 'export const a = 1;', toolCallId: 'call-read', toolName: 'read'},
  ]);
  expect(messages).toEqual([
    {role: 'user', content: 'Inspect files'},
    {
      role: 'assistant',
      content: 'Reading a.ts and spawning subagent',
      toolCalls: [{id: 'call-read', name: 'read', input: {path: 'a.ts'}}],
    },
    {role: 'tool', content: 'export const a = 1;', toolCallId: 'call-read', toolName: 'read'},
  ]);
});

test('formatSubagentResultContent and parseSubagentResultContent round-trip activity and summary', () => {
  const formatted = formatSubagentResultContent({
    agentId: '00000000-0000-4000-8000-000000000001',
    agentType: 'explore',
    description: 'find token verifier',
    toolCount: 2,
    usage: {inputTokens: 120, outputTokens: 30, costUSD: null},
    steps: [
      {kind: 'tool', toolName: 'glob', target: 'src/**/*.ts', status: 'ok'},
      {kind: 'tool', toolName: 'read', target: 'src/auth.ts', status: 'ok'},
    ],
    summary: 'verifyToken is in src/auth.ts:12.',
  });
  const parsed = parseSubagentResultContent(formatted);
  expect(parsed.agentType).toBe('explore');
  expect(parsed.description).toBe('find token verifier');
  expect(parsed.toolCount).toBe(2);
  expect(parsed.totalTokens).toBe(150);
  expect(parsed.summary).toBe('verifyToken is in src/auth.ts:12.');
  expect(parsed.steps).toEqual([
    {kind: 'tool', toolName: 'glob', target: 'src/**/*.ts', status: 'ok'},
    {kind: 'tool', toolName: 'read', target: 'src/auth.ts', status: 'ok'},
    {kind: 'text', text: 'verifyToken is in src/auth.ts:12.'},
  ]);
});

test('subagent persistence hides child sessions from list() and recovers interrupted children on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-subagent-store-'));
  const db = openPrivateDatabase(dir);
  cleanup.push(() => {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  });
  const store = new SqliteConversations(db, s => s);
  const selection = {accountId: '00000000-0000-4000-8000-000000000010', modelId: 'fixture-model'};
  const parentId = store.create(selection);
  store.append(parentId, {role: 'user', content: 'Parent prompt'}, 'committed');

  const childId = store.create(selection);
  const now = new Date().toISOString();
  store.saveSubagentSession({
    id: childId,
    parentConversationId: parentId,
    parentTurnId: 'turn-1',
    callId: 'call-1',
    depth: 1,
    agentType: 'explore',
    description: 'check schema',
    prompt: 'Inspect database.ts',
    selection,
    forkContext: false,
    background: false,
    status: 'running',
    createdAt: now,
    finishedAt: null,
  });
  // Begin a turn in a separate process that exits abruptly (simulates a crash mid-run).
  const script = `import {openPrivateDatabase,SqliteConversations} from ${JSON.stringify(resolve('packages/persistence/src/index.ts'))};
const db=openPrivateDatabase(${JSON.stringify(dir)});const store=new SqliteConversations(db,s=>s);
store.beginExecution(${JSON.stringify(childId)},{role:'user',content:'Inspect database.ts'},{requestId:crypto.randomUUID(),accountId:${JSON.stringify(selection.accountId)},modelId:${JSON.stringify(selection.modelId)},startedAt:new Date().toISOString(),finishedAt:null,outcome:'pending',usage:null,context:null});
process.exit(0);`;
  db.close();
  const crashed = Bun.spawnSync([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
  expect(crashed.exitCode).toBe(0);
  const reopened = openPrivateDatabase(dir);
  cleanup.push(() => reopened.close());
  const storeAfterRestart = new SqliteConversations(reopened, s => s);

  // User session list only contains the parent session, never the child subagent session.
  expect(storeAfterRestart.list().map(s => s.id)).toEqual([parentId]);

  // After restart the child's unfinished turn is recovered as interrupted (never re-run).
  const recoveredChild = storeAfterRestart.getSubagentSession(childId);
  expect(recoveredChild?.status).toBe('interrupted');
  expect(recoveredChild?.errorCode).toBe('PROCESS_EXIT');
  expect(recoveredChild?.finishedAt).not.toBeNull();

  // Deleting the parent session cascades and removes the child conversation and subagent record.
  expect(storeAfterRestart.delete(parentId)).toBe(true);
  expect(storeAfterRestart.get(childId)).toBeUndefined();
  expect(storeAfterRestart.getSubagentSession(childId)).toBeUndefined();
});

test('depth and model resolution helpers follow Codex and OpenCode precedence', () => {
  expect(exceedsAgentDepth(nextAgentDepth(0), 1)).toBe(false);
  expect(exceedsAgentDepth(nextAgentDepth(1), 1)).toBe(true);
  const cfg = normalizeAgentsConfig({
    maxThreads: 6,
    maxDepth: 1,
    defaultModel: 'config-default',
    roles: {explore: {model: 'role-explore', reasoningEffort: 'low'}},
  });
  const profile = resolveAgentProfile('explore', cfg.roles)!;
  const models: Record<string, {id: string; reasoningEfforts?: string[]}> = {
    'parent-model': {id: 'parent-model', reasoningEfforts: ['low', 'medium', 'high']},
    'role-explore': {id: 'role-explore', reasoningEfforts: ['low', 'medium']},
    'explicit-model': {id: 'explicit-model', reasoningEfforts: ['high']},
  };
  const lookup = (ref: string, accountId: string) => {
    const m = models[ref];
    if (!m) return undefined;
    return {
      selection: {accountId, modelId: m.id},
      model: {
        id: m.id,
        name: m.id,
        providerId: 'fixture',
        capabilities: {streaming: 'supported', tools: 'supported', vision: 'unknown', reasoning: 'supported'},
        reasoningEfforts: m.reasoningEfforts,
      } as any,
    };
  };
  const byRole = resolveSubagentModelAndEffort({
    parentSelection: {accountId: 'acc', modelId: 'parent-model'},
    parentReasoningEffort: 'high',
    profile,
    config: cfg,
    lookupModel: lookup,
    availableModelIds: () => Object.keys(models),
  });
  expect(byRole.ok && byRole.value.selection.modelId).toBe('role-explore');
  expect(byRole.ok && byRole.value.reasoningEffort).toBe('low');

  const byExplicit = resolveSubagentModelAndEffort({
    parentSelection: {accountId: 'acc', modelId: 'parent-model'},
    parentReasoningEffort: 'high',
    profile,
    config: cfg,
    requestedModel: 'explicit-model',
    lookupModel: lookup,
    availableModelIds: () => Object.keys(models),
  });
  expect(byExplicit.ok && byExplicit.value.selection.modelId).toBe('explicit-model');
});

test('read-only explorers and planners can retrieve their own bounded evidence without receiving write tools', () => {
  const output: ToolDescriptor = {
    name: 'tool_output',
    capability: 'agent.state',
    parallel: true,
    description: 'captured output',
    inputSchema: {},
  };
  for (const role of ['explore', 'plan'] as const) {
    const tools = filterSubagentTools([...SAMPLE_DESCRIPTORS, output], BUILTIN_AGENT_PROFILES[role], {
      depth: 1,
      maxDepth: 1,
      parentAnalysisOnly: true,
    }).map(d => d.name);
    expect(tools).toContain('tool_output');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('exec_command');
  }
});

test('explore and plan profiles carry bounded default budgets and concise search instructions', () => {
  expect(BUILTIN_AGENT_PROFILES.explore.defaultBudget).toEqual({maxSteps: 12, maxToolCalls: 24});
  expect(BUILTIN_AGENT_PROFILES.plan.defaultBudget).toEqual({maxSteps: 14, maxToolCalls: 28});
  expect(BUILTIN_AGENT_PROFILES.worker.defaultBudget).toBeUndefined();
  expect(BUILTIN_AGENT_PROFILES.general.defaultBudget).toBeUndefined();

  expect(BUILTIN_AGENT_PROFILES.explore.developerInstructions).toMatch(/grep.*glob.*lsp/i);
  expect(BUILTIN_AGENT_PROFILES.explore.developerInstructions).toMatch(/same turn|parallel/i);
  expect(BUILTIN_AGENT_PROFILES.explore.developerInstructions).toMatch(/sufficient evidence/i);

  expect(BUILTIN_AGENT_PROFILES.plan.developerInstructions).toMatch(/grep.*glob.*lsp/i);
  expect(BUILTIN_AGENT_PROFILES.plan.developerInstructions).toMatch(/same turn|batch/i);
  expect(BUILTIN_AGENT_PROFILES.plan.developerInstructions).toMatch(/sufficient evidence/i);
});

test('tool_search and mcp_resource are permitted for worker/general in normal mode and withheld in read-only or parent analysis mode', () => {
  const mcpControlTools: ToolDescriptor[] = [
    ...SAMPLE_DESCRIPTORS,
    {name: 'tool_search', capability: 'agent.state', parallel: true, description: 'search mcp tools', inputSchema: {}},
    {name: 'mcp_resource', capability: 'mcp.call', parallel: true, description: 'read mcp resource', inputSchema: {}},
    {name: 'mcp__srv__ping', capability: 'mcp.call', description: 'mcp tool', inputSchema: {}},
  ];

  for (const role of ['worker', 'general'] as const) {
    const profile = BUILTIN_AGENT_PROFILES[role];
    const normal = filterSubagentTools(mcpControlTools, profile, {depth: 1, maxDepth: 1}).map(d => d.name);
    expect(normal).toContain('tool_search');
    expect(normal).toContain('mcp_resource');
    expect(normal).toContain('mcp__srv__ping');
    expect(isToolAllowedForProfile('tool_search', profile, {depth: 1, maxDepth: 1})).toBe(true);
    expect(isToolAllowedForProfile('mcp_resource', profile, {depth: 1, maxDepth: 1})).toBe(true);

    const analysis = filterSubagentTools(mcpControlTools, profile, {
      depth: 1,
      maxDepth: 1,
      parentAnalysisOnly: true,
    }).map(d => d.name);
    expect(analysis).not.toContain('tool_search');
    expect(analysis).not.toContain('mcp_resource');
    expect(analysis).not.toContain('mcp__srv__ping');
    expect(isToolAllowedForProfile('tool_search', profile, {depth: 1, maxDepth: 1, parentAnalysisOnly: true})).toBe(
      false,
    );
    expect(isToolAllowedForProfile('mcp_resource', profile, {depth: 1, maxDepth: 1, parentAnalysisOnly: true})).toBe(
      false,
    );
  }

  for (const role of ['explore', 'plan'] as const) {
    const profile = BUILTIN_AGENT_PROFILES[role];
    const offered = filterSubagentTools(mcpControlTools, profile, {depth: 1, maxDepth: 1}).map(d => d.name);
    expect(offered).not.toContain('tool_search');
    expect(offered).not.toContain('mcp_resource');
    expect(isToolAllowedForProfile('tool_search', profile, {depth: 1, maxDepth: 1})).toBe(false);
    expect(isToolAllowedForProfile('mcp_resource', profile, {depth: 1, maxDepth: 1})).toBe(false);
  }

  // Even a read-only profile with an explicit allowlist cannot retain tool_search or mcp_resource.
  const customReadOnly = {
    ...BUILTIN_AGENT_PROFILES.explore,
    allowedTools: ['read', 'tool_search', 'mcp_resource'],
  };
  expect(filterSubagentTools(mcpControlTools, customReadOnly, {depth: 1, maxDepth: 1}).map(d => d.name)).toEqual([
    'read',
  ]);
  expect(isToolAllowedForProfile('tool_search', customReadOnly, {depth: 1, maxDepth: 1})).toBe(false);
  expect(isToolAllowedForProfile('mcp_resource', customReadOnly, {depth: 1, maxDepth: 1})).toBe(false);
});

test('updateSubagentSession clears finishedAt/errorCode on resume and dead owner turns do not block updateSelection or delete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-subagent-dead-turns-'));
  const db = openPrivateDatabase(dir);
  cleanup.push(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, {recursive: true, force: true});
  });
  const store = new SqliteConversations(db, s => s.replaceAll('SECRET', '[REDACTED]'));
  const selection = {accountId: '00000000-0000-4000-8000-000000000010', modelId: 'fixture-model'};
  const nextSelection = {accountId: selection.accountId, modelId: 'upgraded-model'};
  const parentId = store.create(selection);
  const childId = store.create(selection);
  const createdAt = new Date().toISOString();

  store.saveSubagentSession({
    id: childId,
    parentConversationId: parentId,
    parentTurnId: 'turn-1',
    callId: 'call-1',
    depth: 1,
    agentType: 'explore',
    description: 'resumable child',
    prompt: 'initial prompt',
    selection,
    forkContext: false,
    background: true,
    status: 'failed',
    createdAt,
    finishedAt: createdAt,
    errorCode: 'BUDGET_SECRET',
  });
  expect(store.getSubagentSession(childId)?.errorCode).toBe('BUDGET_[REDACTED]');
  expect(store.getSubagentSession(childId)?.finishedAt).toBe(createdAt);

  // Resuming sets finishedAt: null and clears errorCode.
  store.updateSubagentSession(childId, {status: 'running', finishedAt: null});
  const rawRunning = db
    .query('SELECT status, finished_at, error_code FROM subagent_sessions WHERE id=?')
    .get(childId) as {status: string; finished_at: string | null; error_code: string | null};
  expect(rawRunning).toEqual({status: 'running', finished_at: null, error_code: null});

  // Fail again, then complete without passing errorCode -> error_code clears to NULL while explicit finishedAt persists.
  const failedAt = new Date().toISOString();
  store.updateSubagentSession(childId, {status: 'failed', finishedAt: failedAt, errorCode: 'TRANSPORT'});
  expect(store.getSubagentSession(childId)).toMatchObject({
    status: 'failed',
    finishedAt: failedAt,
    errorCode: 'TRANSPORT',
  });
  const completedAt = new Date().toISOString();
  store.updateSubagentSession(childId, {status: 'completed', finishedAt: completedAt});
  expect(store.getSubagentSession(childId)).toMatchObject({status: 'completed', finishedAt: completedAt});
  expect(store.getSubagentSession(childId)?.errorCode).toBeUndefined();

  // Omitting finishedAt preserves the existing finished_at value; errorCode: null clears error_code explicitly.
  store.updateSubagentSession(childId, {status: 'failed', errorCode: 'CANCELLED'});
  expect(store.getSubagentSession(childId)).toMatchObject({
    status: 'failed',
    finishedAt: completedAt,
    errorCode: 'CANCELLED',
  });
  store.updateSubagentSession(childId, {status: 'cancelled', errorCode: null});
  expect(store.getSubagentSession(childId)?.finishedAt).toBe(completedAt);
  expect(store.getSubagentSession(childId)?.errorCode).toBeUndefined();

  // Live turn owned by the current process MUST still block updateSelection and delete with POLICY.
  const liveId = store.create(selection);
  store.beginExecution(
    liveId,
    {role: 'user', content: 'active prompt'},
    {
      requestId: crypto.randomUUID(),
      accountId: selection.accountId,
      modelId: selection.modelId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: 'pending',
      usage: null,
      context: null,
    },
  );
  expect(() => store.updateSelection(liveId, nextSelection)).toThrow(expect.objectContaining({code: 'POLICY'}));
  expect(() => store.delete(liveId)).toThrow(expect.objectContaining({code: 'POLICY'}));

  // Spawn two crashed sessions in a separate process that exits without finishing, then call updateSelection
  // and delete directly WITHOUT calling get()/recover()/getSubagentSession() first.
  const crashParentA = store.create(selection);
  const crashParentB = store.create(selection);
  const crashChildB = store.create(selection);
  store.saveSubagentSession({
    id: crashChildB,
    parentConversationId: crashParentB,
    parentTurnId: 'turn-b',
    callId: 'call-b',
    depth: 1,
    agentType: 'explore',
    description: 'crashed child',
    prompt: 'work',
    selection,
    forkContext: false,
    background: true,
    status: 'running',
    createdAt,
    finishedAt: null,
  });
  db.close();

  const crashScript = `import {openPrivateDatabase,SqliteConversations} from ${JSON.stringify(resolve('packages/persistence/src/index.ts'))};
const db=openPrivateDatabase(${JSON.stringify(dir)});const store=new SqliteConversations(db,s=>s);
const receipt=()=>({requestId:crypto.randomUUID(),accountId:${JSON.stringify(selection.accountId)},modelId:${JSON.stringify(selection.modelId)},startedAt:new Date().toISOString(),finishedAt:null,outcome:'pending',usage:null,context:null});
store.beginExecution(${JSON.stringify(crashParentA)},{role:'user',content:'crash A'},receipt());
store.beginExecution(${JSON.stringify(crashParentB)},{role:'user',content:'crash B'},receipt());
store.beginExecution(${JSON.stringify(crashChildB)},{role:'user',content:'crash child B'},receipt());
process.exit(0);`;
  const proc = Bun.spawnSync([process.execPath, '--eval', crashScript], {stdout: 'pipe', stderr: 'pipe'});
  expect(proc.exitCode).toBe(0);

  const reopened = openPrivateDatabase(dir);
  cleanup.push(() => reopened.close());
  const reopenedStore = new SqliteConversations(reopened, s => s);

  // Immediately updateSelection on crashParentA (dead owner_pid) succeeds and marks the dead turn interrupted.
  reopenedStore.updateSelection(crashParentA, nextSelection);
  expect(reopenedStore.get(crashParentA)?.selection).toEqual(nextSelection);
  expect(reopenedStore.get(crashParentA)?.turns?.[0]?.outcome).toBe('interrupted');

  // Immediately delete crashParentB (and its dead running child) without prior recovery succeeds.
  expect(reopenedStore.delete(crashParentB)).toBe(true);
  expect(reopenedStore.get(crashParentB)).toBeUndefined();
  expect(reopenedStore.get(crashChildB)).toBeUndefined();
});
