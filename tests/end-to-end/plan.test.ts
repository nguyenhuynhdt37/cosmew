import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionGrants} from '@futryn/security';
import {ToolDispatcher} from '@futryn/tools';
import {openInk} from '../../apps/tui/src/ink/testing/ink-session';
import {WorkspaceRoot} from '@futryn/workspace';
import type {PlanState} from '@futryn/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';

/** ADR 0042: update_plan — schema, durable plan, Plan mode, pinned checklist. */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const PLAN = {
  explanation: 'Fix the bug',
  plan: [
    {step: 'Reproduce the failure', status: 'completed'},
    {step: 'Fix the parser', status: 'in_progress', activeForm: 'Fixing the parser'},
    {step: 'Run the tests', status: 'pending'},
    {step: 'Rewrite history', status: 'cancelled'},
  ],
};

function dirs() {
  const home = mkdtempSync(join(tmpdir(), 'futryn-plan-home-')),
    root = mkdtempSync(join(tmpdir(), 'futryn-plan-project-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  return {home, root};
}

async function open(
  d: {home: string; root: string},
  script: (view: ScriptedView) => ScriptedReply,
  reuse?: ReturnType<typeof fixtureServer>,
) {
  const server = reuse ?? fixtureServer();
  if (!reuse) cleanup.push(() => server.server.stop(true));
  server.set({script});
  const app = startup(d.home, {vault: memoryVault()});
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.shutdownCommands();
    app.db.close();
  };
  cleanup.push(close);
  if (!reuse) {
    app.registry.add(server.provider('chat', {id: 'plan-model', auth: 'none'}));
    await app.accounts.add('plan-model', 'fixture', {kind: 'none'});
  }
  const client = app.createFutrynClient(d.root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const tui = await openInk(client, {width: 100});
  cleanup.push(() => tui.shutdown());
  return {app, client, tui, server, close};
}

test('schema: statuses, at most one in_progress, bounded; invalid input never changes the plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'futryn-plan-unit-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const saved: PlanState[] = [];
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    approve: async () => 'deny',
    redact: t => t,
    agentState: {updatePlan: plan => saved.push(plan)},
  });
  const call = (input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name: 'update_plan', input});
  const ok = await call(PLAN);
  expect(ok).toMatchObject({
    status: 'ok',
    content: 'Plan updated: 1/4 completed, 1 in progress, 1 pending, 1 cancelled.',
  });
  for (const bad of [
    {
      plan: [
        {step: 'a', status: 'in_progress'},
        {step: 'b', status: 'in_progress'},
      ],
    },
    {plan: [{step: 'a', status: 'done'}]},
    {plan: [{step: '', status: 'pending'}]},
    {plan: Array.from({length: 51}, (_, i) => ({step: `s${i}`, status: 'pending'}))},
    {plan: [{step: 'a', status: 'pending', extra: 1}]},
  ])
    expect((await call(bad)).status).toBe('error');
  expect(saved).toHaveLength(1);
  // Without wired session state the tool is not offered.
  const bare = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    approve: async () => 'deny',
    redact: t => t,
  });
  expect(bare.descriptors().map(d => d.name)).not.toContain('update_plan');
});

test('the plan is durable, offered in Plan mode, pinned above the composer and survives a restart', async () => {
  const d = dirs();
  const first = await open(d, view => {
    if (!view.tools.includes('update_plan')) return {text: 'NO PLAN TOOL'};
    return view.results.length ? {text: 'PLANNED'} : {calls: [{name: 'update_plan', input: PLAN}]};
  });
  // Plan mode offers update_plan (agent.state) but never write tools.
  first.client.setMode('plan');
  await first.tui.submitPrompt('Plan the fix');
  await first.tui.idle();
  const offered = first.server.requests.find(r => r.body?.tools)?.body.tools.map((t: any) => t.function.name);
  expect(offered).toContain('update_plan');
  expect(offered).not.toContain('write');
  expect(first.tui.getTranscript().at(-1)!.content).toContain('PLANNED');
  expect(first.client.plan()).toMatchObject({explanation: 'Fix the bug', items: PLAN.plan});
  const frame = first.tui.computeFrameSnapshot().plainText;
  expect(frame).toContain('Plan · 1/4 completed');
  expect(frame).toContain('✓ Reproduce the failure');
  expect(frame).toContain('▸ Fix the parser');
  expect(frame).toContain('○ Run the tests');
  expect(frame).toContain('✗ Rewrite history');
  expect(frame).toContain('⏺ update_plan(1/4 completed) · ok');
  const id = first.client.activeSession()!.id;
  await first.close();

  const second = await open(d, () => ({text: 'OK'}), first.server);
  expect(second.client.plan()).toBeNull();
  second.client.resumeSession(id);
  expect(second.client.plan()?.items.map(i => i.status)).toEqual(['completed', 'in_progress', 'pending', 'cancelled']);
});
