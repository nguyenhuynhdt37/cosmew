import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

test('configuration defaults and validated user work budget survive SQLite restart without restoring permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-config-'));
  let app = startup(dir, {vault: memoryVault()});
  try {
    let client = app.createFutrynClient(dir);
    expect(client.defaultTurnBudget()).toEqual({value: undefined, source: 'default'});
    client.setDefaultTurnBudget({maxToolCalls: 24});
    expect(client.turnBudget()).toEqual({maxToolCalls: 24});
    expect(() => client.setDefaultTurnBudget({maxToolCalls: -1})).toThrow();
    client.setPermissionMode('acceptEdits');
    app.db.close();
    app = startup(dir, {vault: memoryVault()});
    client = app.createFutrynClient(dir);
    expect(client.defaultTurnBudget()).toEqual({value: {maxToolCalls: 24}, source: 'user'});
    expect(client.turnBudget()).toEqual({maxToolCalls: 24});
    expect(client.permissionMode()).toBe('default');
    client.setDefaultTurnBudget(null);
    expect(client.defaultTurnBudget().source).toBe('default');
  } finally {
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a failed terminal status probe is displayed unavailable without crashing rendering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-probe-error-'));
  const app = startup(dir, {
    vault: memoryVault(),
    commands: () => {
      throw new Error('unavailable runtime');
    },
  });
  try {
    const client = app.createFutrynClient(dir);
    client.setToolsEnabled(true);
    expect(client.status().terminalRuntime.available).toBe(false);
  } finally {
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('session modes persist per conversation and forks across restart while session authority resets', async () => {
  const {fixtureServer} = await import('../fixtures');
  const dir = mkdtempSync(join(tmpdir(), 'futryn-session-modes-'));
  const server = fixtureServer();
  let app = startup(dir, {vault: memoryVault()});
  try {
    app.registry.add(server.provider('chat', {id: 'session-modes', auth: 'none'}));
    await app.accounts.add('session-modes', 'session-modes', {kind: 'none'});
    let client = app.createFutrynClient(dir);
    await client.discoverModels();
    client.selectModel('fixture-model');
    client.setMode('plan');
    const first = client.createSession();
    client.setMode('review');
    const second = client.createSession();
    expect(client.mode()).toBe('review');
    client.setMode('chat');
    client.setPermissionMode('plan');
    client.resumeSession(first.id);
    expect(client.mode()).toBe('review');
    expect(client.permissionMode()).toBe('default');
    const fork = client.forkSession(first.id);
    client.resumeSession(second.id);
    expect(client.mode()).toBe('chat');
    client.setPermissionMode('acceptEdits');
    expect(() => client.resumeSession('not-a-session')).toThrow();
    expect(client.activeSession()?.id).toBe(second.id);
    expect(client.permissionMode()).toBe('acceptEdits');
    app.db.close();
    app = startup(dir, {vault: memoryVault()});
    client = app.createFutrynClient(dir);
    client.resumeSession(fork.id);
    expect(client.mode()).toBe('review');
    client.resumeSession(first.id);
    expect(client.mode()).toBe('review');
    client.resumeSession(second.id);
    expect(client.mode()).toBe('chat');
    expect(client.listSessions().map(session => session.id)).toContain(first.id);
    client.deleteSession(fork.id);
    expect(app.settings.read().sessionModes?.[fork.id]).toBeUndefined();
    expect(app.settings.read().sessionModes?.[first.id]).toBe('review');
    client.setPermissionMode('acceptEdits');
    client.clearSessionView();
    expect(client.permissionMode()).toBe('default');
  } finally {
    app.db.close();
    server.server.stop(true);
    rmSync(dir, {recursive: true, force: true});
  }
});

test('failed session deletion preserves selected history and authorization; resumed legacy mode defaults to chat', async () => {
  const {fixtureServer} = await import('../fixtures');
  const dir = mkdtempSync(join(tmpdir(), 'futryn-session-failure-'));
  const server = fixtureServer();
  const app = startup(dir, {vault: memoryVault()});
  try {
    app.registry.add(server.provider('chat', {id: 'session-failure', auth: 'none'}));
    await app.accounts.add('session-failure', 'session-failure', {kind: 'none'});
    const client = app.createFutrynClient(dir);
    await client.discoverModels();
    client.selectModel('fixture-model');
    const session = client.createSession();
    client.setMode('plan');
    client.setPermissionMode('acceptEdits');
    const originalDelete = app.conversations.delete.bind(app.conversations);
    app.conversations.delete = () => {
      throw new Error('injected storage failure');
    };
    expect(() => client.deleteSession(session.id)).toThrow('injected storage failure');
    expect(client.activeSession()?.id).toBe(session.id);
    expect(client.mode()).toBe('plan');
    expect(client.permissionMode()).toBe('acceptEdits');
    expect(app.settings.read().sessionModes?.[session.id]).toBe('plan');
    app.conversations.delete = originalDelete;
    app.settings.update(settings => {
      delete settings.sessionModes?.[session.id];
    });
    client.resumeSession(session.id);
    expect(client.mode()).toBe('chat');
    expect(client.permissionMode()).toBe('default');
    expect(client.deleteSession(session.id)).toBe(true);
    expect(client.activeSession()).toBeNull();
  } finally {
    app.db.close();
    server.server.stop(true);
    rmSync(dir, {recursive: true, force: true});
  }
});

test('new and resumed sessions reset the permission mode while invalid resume leaves it intact', async () => {
  const {providerPresets} = await import('@cosmew/models');
  const dir = mkdtempSync(join(tmpdir(), 'futryn-session-mode-'));
  const app = startup(dir, {vault: memoryVault()});
  try {
    app.registry.add(providerPresets.find(provider => provider.id === 'ollama')!);
    const account = await app.accounts.add('ollama', 'mode-local', {kind: 'none'});
    const client = app.createFutrynClient(dir);
    client.addManualModel('gpt-5', account.id);
    client.selectModel('gpt-5');
    const first = client.createSession();
    client.setToolsEnabled(true);
    client.setPermissionMode('plan');
    expect(() => client.resumeSession('invalid-session')).toThrow();
    expect(client.permissionMode()).toBe('plan');
    client.createSession();
    expect(client.permissionMode()).toBe('default');
    client.setPermissionMode('acceptEdits');
    client.resumeSession(first.id);
    expect(client.permissionMode()).toBe('default');
  } finally {
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
