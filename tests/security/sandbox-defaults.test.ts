import {afterEach, expect, test} from 'bun:test';
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeSettings, parseSettings} from '@cosmew/security';
import {FilePermissionSettings} from '../../apps/cli/src/bootstrap/permission-settings';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const clean: (() => void)[] = [];
afterEach(() =>
  clean
    .splice(0)
    .reverse()
    .forEach(fn => fn()),
);
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sandbox-defaults-'));
  const workspace = join(home, 'project');
  mkdirSync(workspace);
  const app = startup(join(home, '.cosmew'), {vault: memoryVault()});
  clean.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => app.db.close(),
  );
  const options = {home, workspace, stateDirectory: join(home, '.cosmew'), store: app.settings};
  return {home, options, settings: new FilePermissionSettings(options)};
}

test('missing settings disable sandbox and auto-allow, preserving regular permissions', async () => {
  expect(mergeSettings([], '/empty').sandbox).toMatchObject({
    enabled: false,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
  });
  const {options} = fixture();
  const app = startup(options.stateDirectory, {vault: memoryVault()});
  clean.push(() => app.db.close());
  const client = app.createFutrynClient(options.workspace);
  expect(client.permissionMode()).toBe('default');
  expect(client.status().sandbox.enabled).toBe(false);
});

test('notice is recorded once in user settings and preserves unrelated keys', () => {
  const {settings, options} = fixture();
  writeFileSync(settings.pathOf('user'), JSON.stringify({theme: 'dark', permissions: {deny: ['Bash(rm:*)']}}));
  expect(settings.defaultsNotice()).toContain('/sandbox');
  expect(settings.defaultsNotice()).toBeUndefined();
  expect(new FilePermissionSettings(options).defaultsNotice()).toBeUndefined();
  expect(JSON.parse(readFileSync(settings.pathOf('user'), 'utf8'))).toMatchObject({
    theme: 'dark',
    permissions: {deny: ['Bash(rm:*)']},
  });
});

test('explicit user sandbox is preserved without notice; project trust still applies', () => {
  const {settings} = fixture();
  writeFileSync(settings.pathOf('user'), JSON.stringify({sandbox: {enabled: true, autoAllowBashIfSandboxed: true}}));
  expect(settings.defaultsNotice()).toBeUndefined();
  expect(settings.snapshot().sandbox.enabled).toBe(true);
  const layer = {
    scope: 'project' as const,
    baseDir: '/p',
    file: parseSettings('{"sandbox":{"enabled":false,"autoAllowBashIfSandboxed":true}}').settings,
  };
  const user = {
    scope: 'user' as const,
    baseDir: '/h',
    trusted: true,
    file: parseSettings('{"sandbox":{"enabled":true}}').settings,
  };
  expect(mergeSettings([user, {...layer, trusted: false}], '/h').sandbox.enabled).toBe(true);
  expect(mergeSettings([user, {...layer, trusted: true}], '/h').sandbox.enabled).toBe(false);
});

test('sandbox writes preserve appearance, permissions and network; readonly settings fail without replacement', () => {
  const {settings} = fixture();
  const path = settings.pathOf('user');
  const before = {
    theme: 'light',
    permissions: {deny: ['Bash(rm:*)']},
    sandbox: {network: {allowedDomains: ['example.com']}, excludedCommands: ['git']},
  };
  writeFileSync(path, JSON.stringify(before));
  settings.updateSandbox({
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludeCommand: 'npm test',
  });
  settings.updateSandbox({excludeCommand: 'npm test'});
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    ...before,
    sandbox: {
      ...before.sandbox,
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: ['git', 'npm test'],
    },
  });
  chmodSync(path, 0o400);
  const text = readFileSync(path, 'utf8');
  expect(() => settings.updateSandbox({enabled: false})).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(text);
});

test('CLI startup notice channel displays the upgrade exactly once', () => {
  const {options} = fixture();
  const app = startup(options.stateDirectory, {vault: memoryVault()});
  clean.push(() => app.db.close());
  expect(app.takeStartupNotices().join(' ')).toContain('Sandbox is now off');
  expect(app.takeStartupNotices()).toEqual([]);
});
