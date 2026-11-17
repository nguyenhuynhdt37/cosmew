import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
import {defaultAppearance} from '@futryn/contracts';
import {deriveTokensFromTriplet, renderSettingsOverlay} from '@futryn/tui';
import {configurationRows, SETTINGS_SECTIONS} from '../../apps/tui/src/features/settings/logic';

const plain = (lines: {spans: {text: string}[]}[]) =>
  lines.map(line => line.spans.map(s => s.text).join('')).join('\n');

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

test('config sections expose real actions, disabled settings and secret-free provenance at small sizes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-config-view-'));
  const app = startup(dir, {vault: memoryVault()});
  try {
    const client = app.createFutrynClient(dir);
    const appearance = defaultAppearance();
    const tokens = deriveTokensFromTriplet('#fafafa', '#252525', '#245db8');
    for (const section of SETTINGS_SECTIONS) {
      const rows = configurationRows(client, section, appearance, 'light');
      expect(rows.length).toBeGreaterThan(0);
      for (const [width, height] of [
        [28, 8],
        [80, 18],
        [120, 28],
      ]) {
        const lines = renderSettingsOverlay({
          width: width!,
          height: height!,
          appearance,
          effectiveMode: 'light',
          selectedIndex: rows.length - 1,
          section,
          rows,
          tokens,
          borderStyle: 'rounded',
        });
        expect(lines).toHaveLength(height!);
        expect(lines.every(line => line.spans.reduce((n, span) => n + span.text.length, 0) === width)).toBe(true);
        expect(plain(lines)).not.toContain('credential');
      }
    }
    expect(
      configurationRows(client, 'General', appearance, 'light').some(
        row => row.label === 'Notifications' && row.disabled,
      ),
    ).toBe(true);
    expect(client.appearanceSource('syntaxHighlighting')).toBe('default');
    client.updateAppearance({sidebar: true}, 'global');
    client.updateAppearance({sidebar: false}, 'project');
    expect(client.appearanceSource('sidebar')).toBe('workspace');
    expect(client.getAppearance().sidebar).toBe(false);
    client.updateAppearance({sidebar: true}, 'global');
    expect(client.getAppearance().sidebar).toBe(false);
    expect(client.appearanceSource('sidebar')).toBe('workspace');
    expect(client.appearanceSource('syntaxHighlighting')).toBe('user');
  } finally {
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('config keyboard edits apply to the runtime and persist with explicit workspace precedence', async () => {
  const {FutrynTuiApp} = await import('@futryn/tui');
  const dir = mkdtempSync(join(tmpdir(), 'futryn-config-keys-'));
  let app = startup(dir, {vault: memoryVault()});
  let tui: InstanceType<typeof FutrynTuiApp> | undefined;
  try {
    let client = app.createFutrynClient(dir);
    tui = new FutrynTuiApp({client, cols: 80, rows: 24});
    await tui.initialize();
    await tui.executeSlashCommand('/config');
    expect(tui.computeFrameSnapshot().plainText).toContain('/config · General');
    await tui.handleKey('Tab');
    await tui.handleKey('Tab');
    expect(tui.computeFrameSnapshot().plainText).toContain('/config · Agent');
    for (let i = 0; i < 3; i++) await tui.handleKey('ArrowDown');
    await tui.handleKey('ArrowRight');
    expect(client.turnBudget()?.maxSteps).toBe(8);
    for (let i = 0; i < 3; i++) await tui.handleKey('Tab');
    expect(tui.computeFrameSnapshot().plainText).toContain('/config · Appearance · user');
    await tui.handleKey('Ctrl+G');
    expect(tui.computeFrameSnapshot().plainText).toContain('/config · Appearance · workspace');
    await tui.handleKey('ArrowRight');
    expect(client.appearanceSource('theme')).toBe('workspace');
    expect(client.getAppearance().theme).toBe('dark');
    await tui.handleKey('Escape');
    await tui.handleKey('x');
    expect(tui.computeFrameSnapshot().plainText).toContain('x');
    await tui.shutdown();
    tui = undefined;
    app.db.close();
    app = startup(dir, {vault: memoryVault()});
    client = app.createFutrynClient(dir);
    expect(client.turnBudget()?.maxSteps).toBe(8);
    expect(client.getAppearance().theme).toBe('dark');
    expect(client.getAppearance(false).theme).not.toBe('dark');
  } finally {
    await tui?.shutdown();
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('config never renders vault credentials and rejects permission-bearing preference keys atomically', async () => {
  const {fixtureServer} = await import('../fixtures');
  const dir = mkdtempSync(join(tmpdir(), 'futryn-config-secret-'));
  const server = fixtureServer();
  const vault = memoryVault();
  const app = startup(dir, {vault});
  try {
    app.registry.add(server.provider('chat', {id: 'configuration-provider', auth: 'api-key'}));
    await app.accounts.add(
      'configuration-provider',
      'configuration-account',
      {kind: 'keyring', key: '00000000-0000-4000-8000-000000000017'},
      'configuration-sensitive-api-value',
    );
    const client = app.createFutrynClient(dir);
    const output = SETTINGS_SECTIONS.flatMap(section =>
      configurationRows(client, section, defaultAppearance(), 'dark'),
    );
    expect(JSON.stringify(output)).not.toContain('configuration-sensitive-api-value');
    expect(JSON.stringify(output)).not.toContain('00000000-0000-4000-8000-000000000017');
    const before = app.settings.read();
    expect(() =>
      app.settings.update(settings => {
        (settings as unknown as Record<string, unknown>).agentPreferences = {
          turnBudget: {maxToolCalls: 1},
          delegated: true,
        };
      }),
    ).toThrow();
    expect(app.settings.read()).toEqual(before);
    expect(client.toolsEnabled()).toBe(false);
  } finally {
    app.db.close();
    server.server.stop(true);
    rmSync(dir, {recursive: true, force: true});
  }
});

test('status identifies effective runtime, sandbox, workspace, session, mode and approval policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-runtime-status-'));
  const app = startup(dir, {vault: memoryVault()});
  try {
    const client = app.createFutrynClient(dir);
    const status = client.status();
    expect(status.terminalRuntime.available).toBe(false);
    expect(status.terminalRuntime.reason).toContain('consent');
    const {reportRows} = require('../../apps/tui/src/features/reports/logic');
    const text = reportRows(client, 'status').join('\n');
    expect(text).toContain(dir);
    expect(text).toContain('Mode');
    expect(text).toContain('Permissions');
    expect(text).toContain('Session');
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
    client.setPermissionMode('bypassPermissions');
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
    client.setPermissionMode('auto');
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
    client.setPermissionMode('auto');
    const originalDelete = app.conversations.delete.bind(app.conversations);
    app.conversations.delete = () => {
      throw new Error('injected storage failure');
    };
    expect(() => client.deleteSession(session.id)).toThrow('injected storage failure');
    expect(client.activeSession()?.id).toBe(session.id);
    expect(client.mode()).toBe('plan');
    expect(client.permissionMode()).toBe('auto');
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
  const {providerPresets} = await import('@futryn/models');
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
    client.setPermissionMode('bypassPermissions');
    expect(() => client.resumeSession('invalid-session')).toThrow();
    expect(client.permissionMode()).toBe('bypassPermissions');
    client.createSession();
    expect(client.permissionMode()).toBe('default');
    client.setPermissionMode('auto');
    client.resumeSession(first.id);
    expect(client.permissionMode()).toBe('default');
  } finally {
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
