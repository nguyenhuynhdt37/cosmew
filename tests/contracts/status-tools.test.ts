import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {providerPresets} from '@cosmew/models';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

async function direct(toolsCapability: 'supported' | 'unsupported' | 'unknown') {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-status-tools-'));
  const app = startup(dir, {vault: memoryVault()});
  cleanups.push(() => {
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  });
  app.registry.add(providerPresets.find(p => p.id === 'openai')!);
  const key = crypto.randomUUID();
  await app.vault.set(key, 'sk-fixture-key');
  const account = await app.accounts.add('openai', 'direct', {kind: 'keyring', key}, 'sk-fixture-key');
  const client = app.createFutrynClient(dir);
  client.addManualModel('gpt-fixture', account.id);
  client.selectModel('gpt-fixture');
  app.settings.update(s => {
    const model = s.catalogs.find(c => c.accountId === account.id)!.models.find(m => m.id === 'gpt-fixture')!;
    model.capabilities.tools = toolsCapability;
  });
  return {app, client, account};
}

test('status lists Futryn tools only when consent, a Futryn-run backend and a tools-capable model all hold', async () => {
  const {client} = await direct('supported');
  // No folder consent: nothing is offered and the status says so.
  expect(client.status()).toMatchObject({toolsEnabled: false, workspaceReadStatus: 'disabled'});
  expect(client.availableTools()).toEqual([]);
  client.setToolsEnabled(true);
  expect(client.status()).toMatchObject({toolsEnabled: true, workspaceReadStatus: 'read-only'});
  expect(client.status().executionBackend?.kind).toBe('hannes');
  expect(client.availableTools()).toContain('read');
});

test('a model that cannot call tools gets no tool list and toolsEnabled false, even with folder consent', async () => {
  const {client} = await direct('unsupported');
  client.setToolsEnabled(true);
  expect(client.status()).toMatchObject({toolsEnabled: false, workspaceReadStatus: 'unavailable'});
  expect(client.availableTools()).toEqual([]);
});

test('P1 hooks truthfully report unsupported and MCP exposes management capability flags', async () => {
  const {client} = await direct('supported');
  expect(client.hooks()).toEqual({supported: false, hooks: []});
  const report = client.mcpServers();
  expect(report.supported).toEqual({stdioManagement: true, oauthManagement: true});
  expect(report.servers.every(server => typeof server.toolCount === 'number')).toBe(true);
  expect(client.sendQueuedNow()).toBe('idle');
  expect(client.retractQueuedInput()).toBe('');
});

test('SDK queued snapshot includes durable inbox and retract returns text once', async () => {
  const {app, client} = await direct('supported');
  const session = client.createSession();
  app.conversations.enqueueNextTurn(session.id, 'first');
  app.conversations.enqueueNextTurn(session.id, 'second');
  expect(client.queuedInput().map(p => p.content)).toEqual(['first', 'second']);
  const copy = client.queuedInput() as {steerId: string; content: string}[];
  copy[0]!.content = 'changed by caller';
  expect(client.queuedInput()[0]!.content).toBe('first');
  expect(client.retractQueuedInput()).toBe('first\nsecond');
  expect(client.queuedInput()).toEqual([]);
  expect(client.retractQueuedInput()).toBe('');
});
