import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FutrynError } from '@futryn/contracts';
import { RuntimeProfile } from '@futryn/persistence';
import { SecureVault, Redactor, SUBSCRIPTION_RECIPES, authorizeSubscription, subscriptionEnvironment, denyRuntimeRequest } from '@futryn/security';
import { providerPresets } from '@futryn/models';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function directory() { const root = mkdtempSync(join(tmpdir(), 'futryn-sub-security-')); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root; }

test('runtime transport environment drops inherited API keys, tokens, hooks and auto-approval', () => {
  const env = subscriptionEnvironment(SUBSCRIPTION_RECIPES.codex, '/private/futryn-profile', { PATH: '/bin', OPENAI_API_KEY: 'private', GITHUB_TOKEN: 'private', NODE_OPTIONS: '--require /evil.js', COPILOT_ALLOW_ALL: 'true', CODEX_HOME: '/user/auth' });
  expect(env.CODEX_HOME).toBe('/private/futryn-profile');
  expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.COPILOT_ALLOW_ALL).toBe('false');
  expect(env.GH_CONFIG_DIR).toBe('/private/futryn-profile/gh');
  expect(env.XDG_CONFIG_HOME).toBe('/private/futryn-profile/xdg-config');
  expect(() => authorizeSubscription({ ...providerPresets.find(p => p.id === 'chatgpt')!, baseURL: 'https://evil.example' })).toThrow();
  expect(denyRuntimeRequest('session/request_permission')).toEqual({ outcome: { outcome: 'cancelled' } });
  expect(denyRuntimeRequest('item/fileChange/requestApproval')).toEqual({ decision: 'decline' });
  expect(() => denyRuntimeRequest('fs/read_text_file')).toThrow();
});

test('runtime snapshots reject traversal, symlinks, oversized files and unexpected credential paths', () => {
  const root = directory();
  expect(() => new RuntimeProfile(root, ['auth.json'], {}, JSON.stringify({ version: 1, files: { '../escape.json': '{}' } }))).toThrow();
  const profile = new RuntimeProfile(root, ['auth.json'], {});
  cleanups.push(() => profile.close());
  const outside = join(root, 'outside.json'); writeFileSync(outside, '{}');
  symlinkSync(outside, join(profile.directory, 'auth.json'));
  expect(() => profile.snapshot()).toThrow();
  rmSync(join(profile.directory, 'auth.json'));
  writeFileSync(join(profile.directory, 'auth.json'), 'x'.repeat(65537)); expect(() => profile.snapshot()).toThrow();
  rmSync(join(profile.directory, 'auth.json'));
  writeFileSync(join(profile.directory, 'auth.json'), '{"access_token":"fixture-private"}', { mode: 0o600 });
  writeFileSync(join(profile.directory, 'prompt-log.txt'), 'Never persist this prompt');
  expect(profile.snapshot()).not.toContain('Never persist this prompt');
  const restored = new RuntimeProfile(root, ['auth.json'], {}, profile.snapshot()); cleanups.push(() => restored.close());
  expect(readFileSync(join(restored.directory, 'auth.json'), 'utf8')).toContain('fixture-private');
  const unsafeRoot = directory(); mkdirSync(join(unsafeRoot, 'unsafe')); symlinkSync(join(unsafeRoot, 'unsafe'), join(unsafeRoot, 'runtime-tmp'));
  expect(() => new RuntimeProfile(unsafeRoot, ['auth.json'], {})).toThrow();
});

test('Copilot managed credential headers normalize to strict JSON without altering secret strings', () => {
  const root = directory();
  const profile = new RuntimeProfile(root, ['config.json'], {}); cleanups.push(() => profile.close());
  const tokens = { authTokens: { fixture: 'fixture-secret//not-a-comment' }, url: 'https://github.com' };
  const header = '// User settings belong in settings.json.\r\n// This file is managed automatically.\r\n';
  writeFileSync(join(profile.directory, 'config.json'), header + JSON.stringify(tokens));
  const snapshot = profile.snapshot();
  expect(JSON.parse(JSON.parse(snapshot).files['config.json'])).toEqual(tokens);
  const restored = new RuntimeProfile(root, ['config.json'], {}, snapshot); cleanups.push(() => restored.close());
  expect(JSON.parse(readFileSync(join(restored.directory, 'config.json'), 'utf8'))).toEqual(tokens);
  // Native runtimes rewrite the header after refresh; subsequent captures work.
  writeFileSync(join(restored.directory, 'config.json'), header + JSON.stringify(tokens));
  expect(restored.snapshot()).toBe(snapshot);
  for (const invalid of [header + '{"token":"private",}', '// unknown format\n{}', header + '{"token":"private"} trailing']) {
    writeFileSync(join(profile.directory, 'config.json'), invalid);
    expect(() => profile.snapshot()).toThrow(FutrynError);
  }
});

test.skipIf(process.env.HANNES_TEST_KEYRING !== '1')('native vault protects structured runtime credentials, redacts nested tokens and deletes logout material', async () => {
  const redactor = new Redactor(); const vault = new SecureVault(redactor);
  const ref = { kind: 'runtime' as const, key: crypto.randomUUID(), runtime: 'copilot' as const };
  const profile = new RuntimeProfile(directory(), ['config.json'], {}); cleanups.push(() => profile.close());
  writeFileSync(join(profile.directory, 'config.json'), '// User settings belong in settings.json.\n// This file is managed automatically.\n{"authTokens":{"fixture":"fixture-native-runtime-token"},"refresh_token":"fixture-native-refresh"}');
  const record = profile.snapshot();
  cleanups.push(() => vault.delete(ref));
  await vault.setRuntime(ref.key, record);
  expect(await vault.getRuntime(ref)).toBe(record);
  expect(await vault.get(ref)).toBeUndefined(); // Cannot accidentally become an API-key bearer.
  expect(redactor.text('fixture-native-runtime-token fixture-native-refresh')).toBe('[REDACTED] [REDACTED]');
  await vault.delete(ref); expect(await vault.getRuntime(ref)).toBeUndefined();
});

test('runtime credential files redact their tokens but not short labels like "chatgpt" or "User"', async () => {
  const redactor = new Redactor();
  const vault = new SecureVault(redactor) as unknown as { registerRuntimeSecrets(value: unknown): void };
  vault.registerRuntimeSecrets({ version: 1, files: {
    'auth.json': JSON.stringify({ auth_mode: 'chatgpt', role: 'User', tokens: { access_token: 'eyJfixture-access-token-0123456789' } }),
    'config.json': '// User settings belong in settings.json.\n{"authTokens":{"x":"fixture-copilot-token-abcdef"}}',
  } });
  expect(redactor.text('/Users/huynh mode-chatgpt.txt')).toBe('/Users/huynh mode-chatgpt.txt');
  expect(redactor.text('eyJfixture-access-token-0123456789 fixture-copilot-token-abcdef')).toBe('[REDACTED] [REDACTED]');
});
