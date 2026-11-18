import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SLASH_COMMANDS} from '@futryn/sdk';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer} from '../fixtures';

// Provider sign-in dialogs (provider list, API key/env/no-auth, OAuth, custom endpoint, logout) are covered by the
// Ink dialog tests in apps/tui/src/ink/features/picker/dialogs.test.tsx and the host tests; this file keeps the
// SDK-level connection and permission-binding invariants.
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function setup() {
  const server = fixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'futryn-connect-'));
  const app = startup(dir);
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  cleanups.push(() => server.server.stop(true));
  cleanups.push(() => app.db.close());
  app.registry.add(server.provider('chat', {id: 'fixture', auth: 'none', catalog: 'openai', timeoutMs: 500}));
  return {app, client: app.createFutrynClient(dir), server, dir};
}

test('permission approvals bind the full target, expire, reject forged scopes and never enable tools', async () => {
  const {client} = await setup();
  const prefix = '/workspace/' + 'a'.repeat(150);
  const first = client.enqueuePermissionRequest({
    capability: 'fs.write',
    action: 'Write',
    target: prefix + '/first',
    reason: 'Fixture',
  });
  client.resolvePermission(first.approvalId, first.scopeHash, 'session');
  const second = client.enqueuePermissionRequest({
    capability: 'fs.write',
    action: 'Write',
    target: prefix + '/second',
    reason: 'Fixture',
  });
  expect(second.scopeHash).not.toBe(first.scopeHash);
  expect(second.status).toBe('pending');
  expect(() => client.resolvePermission(second.approvalId, first.scopeHash, 'once')).toThrow();
  const expired = client.enqueuePermissionRequest({
    capability: 'network.connect',
    action: 'Connect',
    target: 'https://example.com',
    reason: 'Fixture',
    ttlMs: -1,
  });
  expect(() => client.resolvePermission(expired.approvalId, expired.scopeHash, 'once')).toThrow();
  expect(client.listPermissions()).toHaveLength(3); // No production demo requests.
  expect(client.capabilities().generalToolsExecution).toBe('not-implemented');
  client.clearSessionView();
  const nextSession = client.enqueuePermissionRequest({
    capability: 'fs.write',
    action: 'Write',
    target: prefix + '/first',
    reason: 'New session',
  });
  expect(nextSession.status).toBe('pending');
});

test('every public sign-in command is canonical metadata shared by help, autocomplete and the router', () => {
  for (const command of ['/login', '/connect', '/logout', '/switch', '/model', '/models'])
    expect(SLASH_COMMANDS.some(c => c.command === command || c.aliases?.includes(command))).toBe(true);
});
