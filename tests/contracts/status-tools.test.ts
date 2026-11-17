import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {providerPresets} from '@futryn/models';
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

test('Codex bridge reports tools only after consent; chat-only backend never lists tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-status-codex-'));
  const app = startup(dir, {vault: memoryVault()});
  cleanups.push(() => {
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  });
  app.registry.add(providerPresets.find(p => p.id === 'chatgpt')!);
  const account = await app.accounts.add('chatgpt', 'codex', {
    kind: 'runtime',
    key: crypto.randomUUID(),
    runtime: 'codex',
  });
  const client = app.createFutrynClient(dir);
  client.addManualModel('gpt-5', account.id);
  client.selectModel('gpt-5');
  expect(client.status().executionBackend?.kind).toBe('chat-only');
  expect(client.status().toolsEnabled).toBe(false);
  expect(client.availableTools()).toEqual([]);
  client.setToolsEnabled(true);
  expect(client.status().executionBackend?.kind).toBe('codex-bridge');
  expect(client.status().toolsEnabled).toBe(true);
  expect(client.availableTools().length).toBeGreaterThan(0);
});
