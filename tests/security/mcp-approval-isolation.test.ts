import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionGrants} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, ToolDispatcher, type ToolAuditRecord} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {createClientFixture} from '../../apps/tui/src/ink/testing/client-fixture';
import {toolPermissionRequest} from '../../apps/cli/src/bootstrap/approvals';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const root = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-mcp-isolation-')));
  cleanups.push(() => rmSync(path, {recursive: true, force: true}));
  return path;
};
function chain() {
  const workspace = root();
  const grants = new SessionGrants();
  const {client} = createClientFixture({
    workspace,
    toolGrants: {list: () => grants.list().map(item => item.target), clear: capability => grants.clear(capability)},
    manageMcp: async () => {
      // The host broadcasts connection/configuration changes after the operation as well.
      client.invalidateMcpPermissions();
      return {snapshot: {supported: true, configPath: '', servers: [], problems: []}};
    },
  });
  client.setToolsEnabled(true);
  let mcpCalls = 0;
  const audits: ToolAuditRecord[] = [];
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(workspace),
    grants,
    redact: text => text,
    audit: record => audits.push(record),
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false, permissionMode: client.permissionMode()}),
    approve: (request, signal) => client.requestPermission(toolPermissionRequest(request), signal),
    mcp: {
      tools: () => [
        {name: 'mcp__fixture__read', description: 'Read fixture', inputSchema: {type: 'object'}, identity: 'one'},
      ],
      call: async () => {
        mcpCalls++;
        return 'fixture';
      },
    },
  });
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const call = (name: string, input: unknown = {}) =>
    dispatcher.invoke({id: crypto.randomUUID(), name, input}, abort.signal);
  const prompt = async () => {
    for (let i = 0; i < 1000; i++) {
      const request = client.listPendingPermissions()[0];
      if (request) return request;
      await Bun.sleep(1);
    }
    throw new Error('Expected a pending approval');
  };
  return {client, grants, workspace, call, prompt, audits, mcpCalls: () => mcpCalls};
}

test('MCP mutation leaves an unrelated file approval pending until the user approves once', async () => {
  const f = chain();
  const pending = f.call('write', {path: 'created.txt', content: 'approved'});
  const request = await f.prompt();
  expect(request.capability).toBe('fs.write');
  await f.client.manageMcp({type: 'disable', name: 'fixture'});
  expect(f.client.listPendingPermissions().map(item => item.approvalId)).toContain(request.approvalId);
  expect(existsSync(join(f.workspace, 'created.txt'))).toBe(false);
  f.client.resolvePermission(request.approvalId, request.scopeHash, 'once');
  expect((await pending).status).toBe('ok');
  expect(readFileSync(join(f.workspace, 'created.txt'), 'utf8')).toBe('approved');
});

test('MCP mutation revokes pending MCP authorization and cached grants without executing', async () => {
  const f = chain();
  f.grants.grant('fs.write', 'unrelated');
  const first = f.call('mcp__fixture__read');
  const approved = await f.prompt();
  f.client.resolvePermission(approved.approvalId, approved.scopeHash, 'session');
  expect((await first).status).toBe('ok');
  expect(f.grants.list().some(item => item.capability === 'mcp.call')).toBe(true);
  await f.client.manageMcp({type: 'reconnect', name: 'fixture'});
  expect(f.grants.list()).toEqual([{capability: 'fs.write', target: 'unrelated'}]);
  const pending = f.call('mcp__fixture__read');
  const request = await f.prompt(); // SDK session cache must also have been cleared.
  await f.client.manageMcp({type: 'disable', name: 'fixture'});
  expect(await pending).toMatchObject({status: 'denied', code: 'APPROVAL_REVOKED'});
  expect(f.audits).toContainEqual(
    expect.objectContaining({
      phase: 'decided',
      decision: 'deny',
      reason: 'approval-revoked',
      scopeHash: expect.any(String),
    }),
  );
  expect(f.mcpCalls()).toBe(1);
  expect(() => f.client.resolvePermission(request.approvalId, request.scopeHash, 'once')).toThrow();
});

test('MCP mutation preserves shell prompts and unrelated SDK session answers', async () => {
  const f = chain();
  const input = {capability: 'fs.read' as const, action: 'Read', target: 'secret.txt', reason: 'fixture'};
  const read = f.client.requestPermission(input);
  const readRequest = await f.prompt();
  f.client.resolvePermission(readRequest.approvalId, readRequest.scopeHash, 'session');
  expect(await read).toBe('session');
  const command = f.client.requestPermission({
    capability: 'process.execute',
    action: 'Run',
    target: 'fixture command',
    reason: 'fixture',
  });
  const shellRequest = await f.prompt();
  await f.client.manageMcp({type: 'disable', name: 'fixture'});
  expect(f.client.listPendingPermissions().map(item => item.approvalId)).toContain(shellRequest.approvalId);
  f.client.resolvePermission(shellRequest.approvalId, shellRequest.scopeHash, 'once');
  expect(await command).toBe('once');
  expect(await f.client.requestPermission(input)).toBe('session');
});

test('approving once and changing to acceptEdits still revokes the in-flight write without replay', async () => {
  const f = chain();
  const pending = f.call('write', {path: 'not-replayed.txt', content: 'never'});
  const request = await f.prompt();
  f.client.resolvePermission(request.approvalId, request.scopeHash, 'once');
  f.client.setPermissionMode('acceptEdits');
  expect(await pending).toMatchObject({status: 'denied', code: 'APPROVAL_REVOKED'});
  expect(existsSync(join(f.workspace, 'not-replayed.txt'))).toBe(false);
  expect(f.client.listPendingPermissions()).toHaveLength(0);
});

for (const change of ['mode', 'rule'] as const)
  test(`global ${change} changes still revoke unrelated pending approval`, async () => {
    const f = chain();
    const pending = f.call('write', {path: 'blocked.txt', content: 'never'});
    const request = await f.prompt();
    if (change === 'mode') f.client.setPermissionMode('plan');
    else f.client.addPermissionRule('deny', 'Edit(./blocked.txt)');
    expect(await pending).toMatchObject({status: 'denied', code: 'APPROVAL_REVOKED'});
    expect(existsSync(join(f.workspace, 'blocked.txt'))).toBe(false);
    expect(() => f.client.resolvePermission(request.approvalId, request.scopeHash, 'once')).toThrow();
  });

test('scoped epochs preserve unrelated approvals and global clear always advances both', () => {
  const grants = new SessionGrants();
  const child = grants.createChild();
  grants.grant('fs.read', 'file');
  grants.grant('mcp.call', 'server');
  child.grant('mcp.call', 'child-server');
  const fsBefore = grants.generationFor('fs.read');
  const mcpBefore = grants.generationFor('mcp.call');
  const oldGeneration = grants.generation;
  grants.clear('mcp.call');
  expect(grants.generation).toBeGreaterThan(oldGeneration);
  expect(grants.generationFor('fs.read')).toBe(fsBefore);
  expect(grants.generationFor('mcp.call')).toBeGreaterThan(mcpBefore);
  expect(grants.has('fs.read', 'file')).toBe(true);
  expect(child.has('fs.read', 'file')).toBe(true);
  expect(child.has('mcp.call', 'child-server')).toBe(false);
  const scoped = grants.generationFor('mcp.call');
  grants.clear();
  expect(grants.generationFor('mcp.call')).toBeGreaterThan(scoped);
  expect(grants.generationFor('fs.read')).toBeGreaterThan(fsBefore);
  expect(child.has('fs.read', 'file')).toBe(false);
});

test('real MCP manager broadcasts preserve another client file approval', async () => {
  const home = root();
  const workspace = root();
  const app = startup(home, {vault: memoryVault()});
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  const one = app.createFutrynClient(workspace);
  const two = app.createFutrynClient(workspace);
  const pending = two.requestPermission({
    capability: 'fs.write',
    action: 'Write',
    target: 'example.txt',
    reason: 'fixture',
  });
  const request = two.listPendingPermissions()[0]!;
  await one.manageMcp({
    type: 'add',
    name: 'disabled-fixture',
    config: {transport: 'stdio', command: '/nonexistent-fixture', enabled: false},
  });
  expect(two.listPendingPermissions().map(item => item.approvalId)).toContain(request.approvalId);
  two.resolvePermission(request.approvalId, request.scopeHash, 'once');
  expect(await pending).toBe('once');
  app.registry.add({
    id: 'plan-fixture',
    name: 'Fixture',
    protocol: 'chat',
    baseURL: 'http://127.0.0.1:1/v1',
    auth: 'none',
    catalog: 'manual',
    metadataVersion: 1,
  });
  await app.accounts.add('plan-fixture', 'fixture', {kind: 'none'});
  const reviewer = app.createFutrynClient(workspace);
  reviewer.addManualModel('fixture-model');
  reviewer.selectModel('fixture-model');
  reviewer.setToolsEnabled(true);
  reviewer.createSession();
  reviewer.setPermissionMode('plan');
  reviewer.setUserInputAvailable(true);
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const review = reviewer.proposePlan('Review this isolated fixture plan.', abort.signal);
  const proposal = reviewer.pendingPlanApproval();
  await one.manageMcp({type: 'disable', name: 'disabled-fixture'});
  expect(reviewer.pendingPlanApproval()).toEqual(proposal);
  abort.abort();
  await expect(review).rejects.toMatchObject({code: 'CANCELLED'});
});
