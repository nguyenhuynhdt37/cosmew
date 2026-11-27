import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SLASH_COMMANDS, parseSlashCommand} from '@cosmew/sdk';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {routeCommand, type CommandHost} from '../../apps/tui/src/ink/features/commands';
import {fixtureServer, memoryVault} from '../fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

async function setupClient() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cosmew-p0-state-'));
  const workspace = mkdtempSync(join(tmpdir(), 'cosmew-p0-ws-'));
  const extraDir = mkdtempSync(join(tmpdir(), 'cosmew-p0-extra-'));
  writeFileSync(join(extraDir, 'note.txt'), 'external allowed content\n');
  const fixture = fixtureServer();
  const app = startup(stateDir, {vault: memoryVault(), skillsHome: stateDir, memoriesHome: stateDir});
  cleanups.push(() => {
    fixture.server.stop(true);
    app.db.close();
    rmSync(stateDir, {recursive: true, force: true});
    rmSync(workspace, {recursive: true, force: true});
    rmSync(extraDir, {recursive: true, force: true});
  });
  const provider = fixture.provider('chat');
  app.registry.add(provider);
  const key = crypto.randomUUID();
  await app.vault.set(key, 'sk-p0-fixture-secret');
  const account = await app.accounts.add(provider.id, 'p0', {kind: 'keyring', key}, 'sk-p0-fixture-secret');
  const client = app.createFutrynClient(workspace);
  client.addManualModel('fixture-model', account.id);
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  return {app, client, fixture, stateDir, workspace, extraDir};
}

test('P0 slash commands are canonical in SLASH_COMMANDS and parse without unavailable errors', () => {
  for (const cmd of ['/hooks', '/add-dir', '/reload-skills', '/autocompact', '/btw']) {
    const def = SLASH_COMMANDS.find(item => item.command === cmd);
    expect(def).toBeDefined();
    expect(def?.unavailable).toBeUndefined();
  }
  expect(parseSlashCommand('/hooks').definition?.overlay).toBe('hooks');
  expect(parseSlashCommand('/add-dir /tmp').definition?.handler).toBe('add-dir');
  expect(parseSlashCommand('/reload-skills').definition?.handler).toBe('reload-skills');
  expect(parseSlashCommand('/autocompact off').definition?.handler).toBe('autocompact');
  expect(parseSlashCommand('/btw what is 2+2').definition?.handler).toBe('btw');
});

test('/add-dir adds session and persisted working directories while blocking .git and Cosmew state directory', async () => {
  const {client, stateDir, workspace, extraDir} = await setupClient();
  const notices: string[] = [];
  const host: CommandHost = {
    client,
    busy: () => false,
    open: () => {},
    notice: text => notices.push(text),
    reset: () => {},
    submit: () => true,
    exit: () => {},
  };

  // Empty /add-dir lists none initially.
  await routeCommand(host, '/add-dir');
  expect(notices.at(-1)).toContain('No additional working directories');

  // Session-only /add-dir updates snapshot immediately without modifying local settings.
  await routeCommand(host, `/add-dir ${extraDir}`);
  expect(notices.at(-1)).toContain('Added working directory for this session');
  expect(client.permissionSettings().additionalDirectories.length).toBe(1);

  // Persisted /add-dir --save writes to local settings.
  await routeCommand(host, `/add-dir --save ${extraDir}`);
  expect(notices.at(-1)).toContain('saved to local settings');
  const localSettings = JSON.parse(await Bun.file(join(workspace, '.cosmew', 'settings.local.json')).text());
  expect(localSettings.permissions.additionalDirectories).toHaveLength(1);

  // Security invariants: .git and stateDir are rejected with POLICY.
  mkdirSync(join(workspace, '.git'), {recursive: true});
  expect(() => client.addAdditionalDirectory(join(workspace, '.git'))).toThrow();
  expect(() => client.addAdditionalDirectory(stateDir)).toThrow();
});

test('/reload-skills rescans newly added skills in place without restart', async () => {
  const {client, workspace} = await setupClient();
  expect(client.skills().skills.some(s => s.name === 'hot-reload-skill')).toBe(false);

  const skillDir = join(workspace, '.cosmew', 'skills', 'hot-reload-skill');
  mkdirSync(skillDir, {recursive: true});
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: hot-reload-skill\ndescription: Added mid-session\n---\n\nRun hot reload check.\n',
  );

  const notices: string[] = [];
  const host: CommandHost = {
    client,
    busy: () => false,
    open: () => {},
    notice: text => notices.push(text),
    reset: () => {},
    submit: () => true,
    exit: () => {},
  };
  await routeCommand(host, '/reload-skills');
  expect(notices.at(-1)).toContain('Reloaded');
  expect(client.skills().skills.some(s => s.name === 'hot-reload-skill')).toBe(true);
});

test('/autocompact toggles and persists UserPreferences.autoCompact', async () => {
  const {client} = await setupClient();
  const notices: string[] = [];
  const host: CommandHost = {
    client,
    busy: () => false,
    open: () => {},
    notice: text => notices.push(text),
    reset: () => {},
    submit: () => true,
    exit: () => {},
  };

  expect(client.userPreferences().autoCompact).toBe(true);
  await routeCommand(host, '/autocompact off');
  expect(client.userPreferences().autoCompact).toBe(false);
  expect(notices.at(-1)).toBe('Auto-compact is now off.');

  await routeCommand(host, '/autocompact status');
  expect(notices.at(-1)).toBe('Auto-compact is currently off.');

  await routeCommand(host, '/autocompact');
  expect(client.userPreferences().autoCompact).toBe(true);
  expect(notices.at(-1)).toBe('Auto-compact is now on.');
});

test('/btw answers a side question with no tools and without mutating session history', async () => {
  const {client, fixture} = await setupClient();
  await Array.fromAsync(client.sendMessage('Remember the codename is ORION.'));
  const beforeCount = client.activeSession()!.messages.length;
  const requestsBefore = fixture.requests.length;

  const notices: string[] = [];
  const host: CommandHost = {
    client,
    busy: () => false,
    open: () => {},
    notice: text => notices.push(text),
    reset: () => {},
    submit: () => true,
    exit: () => {},
  };
  await routeCommand(host, '/btw What was the codename?');

  expect(notices.at(-1)).toBe('Hello fixture');
  expect(client.activeSession()!.messages.length).toBe(beforeCount);
  const btwReq = fixture.requests[requestsBefore]!;
  expect(btwReq.body.tools).toBeUndefined();
  expect(JSON.stringify(btwReq.body.messages)).toContain('Remember the codename is ORION.');
  expect(JSON.stringify(btwReq.body.messages)).toContain('What was the codename?');
});

test('/export supports structured Markdown and sanitized JSON without providerReplay, and /clear <name> renames previous session', async () => {
  const {app, client} = await setupClient();
  await Array.fromAsync(client.sendMessage('hello export test'));
  const session = client.activeSession()!;
  // Persist an assistant message with private providerReplay in storage and resume it to prove export omits private state.
  app.conversations.append(
    session.id,
    {
      role: 'assistant',
      content: 'Visible answer with sk-p0-fixture-secret',
      providerReplay: {
        version: 1,
        providerId: 'openai',
        accountId: session.selection.accountId,
        protocol: 'responses',
        modelId: 'm',
        endpointHash: 'a'.repeat(64),
        parts: [{type: 'reasoning', text: 'hidden', metadata: {reasoningEncryptedContent: 'opaque-secret'}}],
      },
    },
    'committed',
  );
  client.resumeSession(session.id);

  const md = client.exportSession('markdown');
  expect(md).toContain('# ');
  expect(md).toContain('## User');
  expect(md).toContain('hello export test');
  expect(md).toContain('## Assistant');
  expect(md).toContain('Visible answer');
  expect(md).not.toContain('sk-p0-fixture-secret');
  expect(md).not.toContain('opaque-secret');
  expect(md).not.toContain('providerReplay');

  const jsonRaw = client.exportSession('json');
  const parsed = JSON.parse(jsonRaw);
  expect(parsed.version).toBe(1);
  expect(parsed.sessionId).toBe(session.id);
  expect(parsed.messages.length).toBeGreaterThanOrEqual(3);
  expect(jsonRaw).not.toContain('sk-p0-fixture-secret');
  expect(jsonRaw).not.toContain('opaque-secret');
  expect(jsonRaw).not.toContain('providerReplay');

  // /clear <name> renames previous session before starting fresh.
  const notices: string[] = [];
  let resetCount = 0;
  const host: CommandHost = {
    client,
    busy: () => false,
    open: () => {},
    notice: text => notices.push(text),
    reset: () => {
      resetCount++;
    },
    submit: () => true,
    exit: () => {},
  };
  const oldId = session.id;
  await routeCommand(host, '/clear My Archived Session');
  expect(resetCount).toBe(1);
  expect(notices.at(-1)).toContain('Renamed previous session to My Archived Session');
  const listed = client.listSessions().find(item => item.id === oldId);
  expect(listed?.title).toBe('My Archived Session');
});
