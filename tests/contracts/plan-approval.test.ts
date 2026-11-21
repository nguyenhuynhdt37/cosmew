import {afterEach, expect, test} from 'bun:test';
import {chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionGrants} from '@cosmew/security';
import {ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'fyn-plan-review-home-'));
  const root = mkdtempSync(join(tmpdir(), 'fyn-plan-review-root-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add({
    id: 'review-model',
    name: 'Review fixture',
    protocol: 'chat',
    baseURL: 'http://127.0.0.1:1/v1',
    auth: 'none',
    catalog: 'manual',
    metadataVersion: 1,
    timeoutMs: 1000,
  });
  await app.accounts.add('review-model', 'fixture', {kind: 'none'});
  const client = app.createFutrynClient(root);
  client.addManualModel('fixture-model');
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  client.createSession();
  client.setPermissionMode('plan');
  client.setUserInputAvailable(true);
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    approve: async () => 'deny',
    redact: t => t.replaceAll('SECRET', '[redacted]'),
    agentState: {
      canProposePlan: () => client.canProposePlan(),
      proposePlan: (plan, signal) => client.proposePlan(plan, signal),
    },
  });
  const call = (signal?: AbortSignal, input: unknown = {plan: 'Implement SECRET parser'}) =>
    dispatcher.invoke({id: crypto.randomUUID(), name: 'exit_plan_mode', input}, signal);
  return {app, client, call, dispatcher, root};
}

test('plan review is explicit, redacted, durable and transitions only on the selected approval', async () => {
  const {client, call, dispatcher} = await setup();
  const seen: string[] = [];
  client.onPlanProposed(plan => {
    seen.push(plan.plan);
    plan.plan = 'observer mutation';
  });
  const running = call();
  expect(client.pendingPlanApproval()?.plan).toBe('Implement [redacted] parser');
  expect(client.permissionMode()).toBe('plan');
  expect(client.planProposal()?.status).toBe('proposed');
  expect(seen).toEqual(['Implement [redacted] parser']);
  client.resolvePlanApproval({feedback: 'Add cancellation tests'});
  expect((await running).content).toContain('Add cancellation tests');
  expect(client.permissionMode()).toBe('plan');
  expect(client.planProposal()?.status).toBe('feedback');
  const second = call();
  client.resolvePlanApproval('acceptEdits');
  expect((await second).status).toBe('ok');
  expect(client.permissionMode()).toBe('acceptEdits');
  expect(client.mode()).toBe('chat');
  expect(client.pendingPlanApproval()).toBeNull();
  expect(client.planProposal()?.resolution).toBe('acceptEdits');
  expect(dispatcher.descriptors().map(d => d.name)).not.toContain('exit_plan_mode');
  expect((await call()).status).toBe('error');
});

test('abort, mode changes and detached UI settle approval without granting authority', async () => {
  const {client, call} = await setup();
  const abort = new AbortController();
  const pending = call(abort.signal);
  abort.abort();
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
  expect(client.pendingPlanApproval()).toBeNull();
  expect(client.planProposal()?.status).toBe('cancelled');
  expect(() => client.resolvePlanApproval('manual')).toThrow();
  expect(client.permissionMode()).toBe('plan');
  const changed = call();
  client.setPermissionMode('default');
  await expect(changed).rejects.toMatchObject({code: 'CANCELLED'});
  client.setPermissionMode('plan');
  const detached = call();
  client.setUserInputAvailable(false);
  await expect(detached).rejects.toMatchObject({code: 'CANCELLED'});
  expect((await call()).content).toContain('unavailable');
  expect(client.permissionMode()).toBe('plan');
});

test('manual approval selects default permissions; invalid input cannot create a proposal', async () => {
  const {client, call} = await setup();
  expect((await call(undefined, {plan: ''})).status).toBe('error');
  expect(client.pendingPlanApproval()).toBeNull();
  const pending = call();
  expect(() => client.resolvePlanApproval({feedback: ''})).toThrow();
  expect(client.pendingPlanApproval()).not.toBeNull();
  client.resolvePlanApproval('manual');
  expect((await pending).status).toBe('ok');
  expect(client.permissionMode()).toBe('default');
});

test('durable proposals recover as history without restoring a live dialog or permission mode', async () => {
  const {app, client, call, root} = await setup();
  const pending = call();
  const recovered = app.createFutrynClient(root);
  recovered.resumeSession(client.activeSession()!.id);
  expect(recovered.planProposal()?.status).toBe('proposed');
  expect(recovered.pendingPlanApproval()).toBeNull();
  expect(recovered.permissionMode()).toBe('default');
  expect(() => recovered.resolvePlanApproval('acceptEdits')).toThrow();
  client.setUserInputAvailable(false);
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
});

test('failed durable approval write leaves plan mode and pending review unchanged', async () => {
  const {app, client, call} = await setup();
  const pending = call();
  app.db.exec(
    "CREATE TRIGGER reject_plan_resolution BEFORE UPDATE ON session_plan_approval BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END",
  );
  expect(() => client.resolvePlanApproval('acceptEdits')).toThrow();
  expect(client.permissionMode()).toBe('plan');
  expect(client.pendingPlanApproval()?.status).toBe('proposed');
  app.db.exec('DROP TRIGGER reject_plan_resolution');
  client.resolvePlanApproval({feedback: 'Revise it'});
  expect((await pending).status).toBe('ok');
});

test('edited plan artifact is durable and approve with feedback returns the reviewed revision', async () => {
  const {app, client, call, root} = await setup();
  const pending = call();
  const before = client.pendingPlanApproval()!;
  expect(readFileSync(before.path!, 'utf8')).toBe(before.plan);
  const edited = client.editPlanProposal('# Revised plan\nAdd real cancellation tests', {
    id: before.id,
    expectedRevision: before.revision!,
  });
  expect(edited.revision).toBe(before.revision! + 1);
  expect(edited.path).not.toBe(before.path);
  expect(readFileSync(edited.path!, 'utf8')).toBe(edited.plan);
  expect(client.permissionMode()).toBe('plan');
  expect(() => client.editPlanProposal('stale edit', {id: before.id, expectedRevision: before.revision!})).toThrow();
  client.resolvePlanApproval({mode: 'manual', feedback: 'Include regression coverage'});
  const result = JSON.parse((await pending).content);
  expect(result).toEqual({
    kind: 'approved',
    mode: 'manual',
    feedback: 'Include regression coverage',
    plan: edited.plan,
  });
  expect(client.permissionMode()).toBe('default');
  const recovered = app.createFutrynClient(root);
  recovered.resumeSession(client.activeSession()!.id);
  expect(recovered.planProposal()).toMatchObject({
    ...edited,
    status: 'approved',
    feedback: 'Include regression coverage',
  });
  expect(recovered.pendingPlanApproval()).toBeNull();
});

test('failed revision writes and cancelled editors leave permissions and durable proposal intact', async () => {
  const {app, client, call} = await setup();
  const abort = new AbortController();
  const pending = call(abort.signal).catch(error => error.code);
  const before = client.pendingPlanApproval()!;
  app.db.exec(
    "CREATE TRIGGER reject_plan_edit BEFORE UPDATE ON session_plan_approval BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END",
  );
  expect(() => client.editPlanProposal('Changed plan')).toThrow();
  expect(client.pendingPlanApproval()).toEqual(before);
  expect(client.planProposal()).toEqual(before);
  expect(readFileSync(before.path!, 'utf8')).toBe(before.plan);
  expect(client.permissionMode()).toBe('plan');
  app.db.exec('DROP TRIGGER reject_plan_edit');
  abort.abort();
  expect(await pending).toBe('CANCELLED');
  expect(() =>
    client.editPlanProposal('Late editor save', {id: before.id, expectedRevision: before.revision!}),
  ).toThrow();
  expect(client.permissionMode()).toBe('plan');
});

test('editor text and approval feedback are redacted before artifact and durable history', async () => {
  const {app, client, call} = await setup();
  app.redactor.register('sensitive-plan-token');
  const pending = call();
  const edited = client.editPlanProposal('Keep sensitive-plan-token private');
  expect(edited.plan).not.toContain('sensitive-plan-token');
  expect(readFileSync(edited.path!, 'utf8')).toBe(edited.plan);
  client.resolvePlanApproval({mode: 'acceptEdits', feedback: 'Never log sensitive-plan-token'});
  expect((await pending).content).not.toContain('sensitive-plan-token');
  expect(client.planProposal()?.feedback).not.toContain('sensitive-plan-token');
});

test('a late editor from another session cannot replace or approve a new pending proposal', async () => {
  const {client, call} = await setup();
  const oldResult = call().catch(error => error.code);
  const old = client.pendingPlanApproval()!;
  client.createSession();
  expect(await oldResult).toBe('CANCELLED');
  client.setPermissionMode('plan');
  const currentResult = call();
  const current = client.pendingPlanApproval()!;
  expect(() => client.editPlanProposal('Late editor text', {id: old.id, expectedRevision: old.revision!})).toThrow();
  expect(client.pendingPlanApproval()).toEqual(current);
  expect(client.permissionMode()).toBe('plan');
  client.resolvePlanApproval('manual');
  await currentResult;
});

test('requesting changes after editing returns the reviewed plan without approving tools', async () => {
  const {client, call} = await setup();
  const pending = call();
  client.editPlanProposal('# User revision');
  client.resolvePlanApproval({feedback: 'Refine this revision'});
  expect(JSON.parse((await pending).content)).toEqual({
    kind: 'feedback',
    feedback: 'Refine this revision',
    plan: '# User revision',
  });
  expect(client.permissionMode()).toBe('plan');
});

test('approval refuses permissive, replaced symlink and oversized existing artifacts before granting', async () => {
  const {client, call, root} = await setup();
  const pending = call();
  const proposal = client.pendingPlanApproval()!;
  const path = proposal.path!;
  chmodSync(path, 0o644);
  expect(() => client.resolvePlanApproval('acceptEdits')).toThrow();
  expect(client.permissionMode()).toBe('plan');
  chmodSync(path, 0o600);
  const replacement = join(root, 'replacement.md');
  writeFileSync(replacement, proposal.plan, {mode: 0o600});
  unlinkSync(path);
  symlinkSync(replacement, path);
  expect(() => client.resolvePlanApproval('acceptEdits')).toThrow();
  expect(client.permissionMode()).toBe('plan');
  unlinkSync(path);
  writeFileSync(path, 'x'.repeat(130000), {mode: 0o600});
  expect(() => client.resolvePlanApproval('acceptEdits')).toThrow();
  expect(client.permissionMode()).toBe('plan');
  writeFileSync(path, proposal.plan);
  client.resolvePlanApproval('manual');
  expect((await pending).status).toBe('ok');
});
