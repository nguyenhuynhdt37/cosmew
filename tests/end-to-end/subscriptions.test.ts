import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HannesError, type SubscriptionRuntime } from '@hannes/contracts';
import { FutrynTuiApp } from '@hannes/tui';
import { RuntimeProfile } from '@hannes/persistence';
import { SUBSCRIPTION_RECIPES, subscriptionEnvironment } from '@hannes/security';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { SubscriptionRpc } from '../../apps/cli/src/subscriptions/rpc';
import { memoryVault } from '../fixtures';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const ids = { codex: 'chatgpt', copilot: 'github-copilot', 'gemini-cli': 'google-subscription', 'qwen-code': 'qwen-subscription' };
async function context(scenario = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-subscriptions-'));
  const vault = memoryVault();
  const app = startup(dir, { vault, subscriptions: { openURL: async () => {}, resolveCommand: runtime => ({ command: process.execPath, prefix: [resolve('tests/subscription-fixtures/runtime.ts'), runtime, scenario] }) } });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(async () => { await app.subscriptions.shutdown(); app.db.close(); });
  const client = app.createFutrynClient(dir);
  return { app, client, dir, vault };
}
async function connect(c: Awaited<ReturnType<typeof context>>, runtime: SubscriptionRuntime, alias = runtime) {
  const challenge = await c.client.beginProviderAuth(ids[runtime], 'subscription-device');
  expect(challenge.autoComplete).toBe(true);
  const account = await c.client.connectAccount({ providerId: ids[runtime], alias, credential: { kind: 'keyring', key: crypto.randomUUID() }, authChallengeId: challenge.id });
  expect(account.status).toBe('valid');
  expect(account.credential.kind).toBe('runtime');
  return account;
}
for (const runtime of Object.keys(ids) as SubscriptionRuntime[]) {
  test(`${runtime}: official wire fixture signs in, discovers models, chats, isolates accounts, persists and logs out`, async () => {
    const c = await context();
    const a = await connect(c, runtime);
    expect(c.client.cachedModels().map(m => m.id)).toEqual(['runtime-model', 'runtime-alt']);
    const events = [];
    for await (const event of c.client.sendMessage('Hello subscription')) events.push(event);
    expect(events.some(e => e.type === 'textDelta' && e.text === 'Subscription fixture response')).toBe(true);
    expect(events.at(-1)?.type).toBe('completed');
    const sessionId = c.client.activeSession()!.id;
    c.client.selectModel('runtime-alt');
    expect(c.client.activeSession()).toBeNull();
    for await (const _event of c.client.sendMessage('Other model')) { /* execute real subprocess */ }
    expect(c.client.activeSession()!.id).not.toBe(sessionId);
    const b = await connect(c, runtime, runtime + '-work' as SubscriptionRuntime);
    expect(a.id).not.toBe(b.id); expect(a.credential).not.toEqual(b.credential);
    expect(c.vault.values.size).toBe(2);
    const restarted = startup(c.dir, { vault: c.vault, subscriptions: { openURL: async () => {}, resolveCommand: r => ({ command: process.execPath, prefix: [resolve('tests/subscription-fixtures/runtime.ts'), r, 'normal'] }) } });
    try {
      expect(restarted.createFutrynClient().status().activeAccount?.id).toBe(b.id);
      expect((await restarted.discoverModels(b)).models).toHaveLength(2);
    } finally { await restarted.subscriptions.shutdown(); restarted.db.close(); }
    await c.client.logoutAccount(b.id, true);
    expect(c.vault.values.size).toBe(1);
    expect(c.client.status().selection).toBeNull();
    expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
  });
  test(`${runtime}: rejected authentication leaves no account, vault entry or temporary credentials`, async () => {
    const c = await context('reject');
    await expect(connect(c, runtime)).rejects.toBeInstanceOf(HannesError);
    expect(c.app.accounts.list()).toHaveLength(0); expect(c.vault.values.size).toBe(0);
    expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
  });
  test(`${runtime}: cancellation kills auth process and removes profile without account creation`, async () => {
    const c = await context('slow-auth');
    const challenge = await c.client.beginProviderAuth(ids[runtime]);
    const controller = new AbortController();
    const operation = c.client.connectAccount({ providerId: ids[runtime], alias: 'cancelled', credential: { kind: 'none' }, authChallengeId: challenge.id }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(c.app.accounts.list()).toHaveLength(0); expect(c.vault.values.size).toBe(0);
    expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
  });
  test(`${runtime}: runtime tool attempts are denied and cannot commit a successful response`, async () => {
    const c = await context('tool-attempt');
    await connect(c, runtime);
    await expect((async () => { for await (const _e of c.client.sendMessage('Attempt unauthorized tool')) { /* drain */ } })()).rejects.toMatchObject({ code: 'POLICY' });
    expect(c.app.conversations.list()[0]?.messageCount).toBe(0);
    expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
  });
}

test('TUI subscription flow auto-completes browser/device sign-in and opens a usable model picker', async () => {
  const c = await context();
  const tui = new FutrynTuiApp({ client: c.client, cols: 100, rows: 30 }); await tui.initialize();
  cleanup.push(() => tui.shutdown());
  await tui.executeSlashCommand('/login');
  for (const key of 'chatgpt') await tui.handleKey(key);
  await tui.handleKey('Enter');
  expect(tui.computeFrameSnapshot().plainText).toContain('Sign in with ChatGPT');
  await tui.handleKey('Enter');
  const deadline = Date.now() + 5000;
  while (tui.getActiveOverlay() !== 'models' && Date.now() < deadline) await Bun.sleep(10);
  expect(tui.getActiveOverlay()).toBe('models');
  await tui.handleKey('Enter'); await tui.submitPrompt('Real protocol fixture turn');
  expect(tui.getTranscript().at(-1)?.content).toBe('Subscription fixture response');
  expect(tui.computeFrameSnapshot().plainText).not.toContain('fixture-runtime-secret');
});

for (const runtime of Object.keys(ids) as SubscriptionRuntime[]) {
  test(`${runtime}: successful exit without credential material cannot claim successful login`, async () => {
    const c = await context('missing-creds');
    await expect(connect(c, runtime)).rejects.toMatchObject({ code: 'AUTH' });
    expect(c.vault.values.size).toBe(0); expect(c.app.accounts.list()).toHaveLength(0);
  });
  test(`${runtime}: logout during an active stream fences auth and cannot resurrect credential snapshots`, async () => {
    const c = await context('long-stream'); const account = await connect(c, runtime);
    const iterator = c.client.sendMessage('Slow request')[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('started');
    await c.client.logoutAccount(account.id);
    await expect(iterator.next()).rejects.toBeInstanceOf(HannesError);
    expect(c.vault.values.size).toBe(0);
    expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
  });
}

test('login UX groups subscriptions under the vendor and asks only for the selected credential', async () => {
  const c = await context();
  const groups = c.client.listIntegrations();
  expect(groups.filter(i => i.provider.id === 'openai')).toHaveLength(1);
  expect(groups.some(i => i.provider.id === 'chatgpt')).toBe(false);
  expect(groups.some(i => i.provider.id === 'google-subscription')).toBe(false);
  const openai = groups.find(i => i.provider.id === 'openai')!;
  expect(openai.methods.find(m => m.id === 'subscription-browser')?.providerId).toBe('chatgpt');
  const tui = new FutrynTuiApp({ client: c.client, cols: 80, rows: 24 }); await tui.initialize(); cleanup.push(() => tui.shutdown());
  await tui.executeSlashCommand('/login');
  const providers = tui.computeFrameSnapshot().plainText;
  expect(providers).not.toContain('╭'); expect(providers).not.toContain('Name this account');
  await tui.handleKey('Enter');
  const methods = tui.computeFrameSnapshot().plainText;
  expect(methods).toContain('Sign in with ChatGPT'); expect(methods).toContain('API key'); expect(methods).not.toContain('Environment variable');
  await tui.handleKey('ArrowDown'); await tui.handleKey('Enter');
  expect(tui.computeFrameSnapshot().plainText).toContain('Paste your API key');
  expect(tui.computeFrameSnapshot().plainText).not.toContain('Name this account');
  expect(c.app.accounts.list()).toHaveLength(0);
});

for (const vendor of ['OpenAI', 'GitHub Copilot']) test.skipIf(process.platform === 'win32')(`actual PTY: ${vendor} → subscription → model → chat → logout, without alias or token prompts`, async () => {
  const c = await context(); let output = '';
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, data(_t, bytes) { output += Buffer.from(bytes).toString('utf8'); } });
  const child = Bun.spawn([process.execPath, resolve('tests/subscription-fixtures/tui.ts')], { terminal, env: { ...process.env, FUTRYN_TEST_HOME: c.dir, NO_COLOR: '1' } });
  const wait = async (text: string) => { const deadline = Date.now() + 4000; while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(10); expect(output).toContain(text); };
  try {
    await wait('FUTRYN'); terminal.write('/login\r'); await wait('Choose your provider');
    if (vendor === 'GitHub Copilot') terminal.write('copilot');
    terminal.write('\r'); await wait(`Sign in to ${vendor}`);
    terminal.write('\r'); await wait('runtime-model');
    expect(output).not.toContain('Name this account'); expect(output).not.toContain('Enter API key');
    terminal.write('\rHello from terminal\r'); await wait('Subscription fixture response');
    terminal.write('/logout\r'); await wait('Manage accounts'); terminal.write('\r'); await wait('Account actions');
    terminal.write('\x1b[B\x1b[B\x1b[B\x1b[B\r'); await wait('Confirm account action');
    terminal.write('\x1b[B\r'); await wait('Local credential removed');
    terminal.write('\x1b\x03');
    expect(await Promise.race([child.exited, Bun.sleep(4000).then(() => -1)])).toBe(0);
    expect(output).not.toContain('fixture-runtime-secret');
    expect(output).toContain('\x1b[?1049l');
  } finally { child.kill('SIGKILL'); await child.exited; terminal.close(); }
}, 15000);

test.skipIf(process.env.HANNES_TEST_COPILOT !== '1')('installed Copilot: native managed state survives capture and a fresh runtime restore (no login or model request)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-native-copilot-'));
  const recipe = SUBSCRIPTION_RECIPES.copilot;
  const command = Bun.which(recipe.command); expect(command).not.toBeNull();
  const profile = new RuntimeProfile(dir, recipe.credentialFiles, recipe.settingsFiles);
  let restored: RuntimeProfile | undefined;
  let rpc: SubscriptionRpc | undefined;
  try {
    rpc = new SubscriptionRpc(command!, recipe.args, subscriptionEnvironment(recipe, profile.directory), profile.workspace, recipe.framing);
    await rpc.request('ping', {}, 10000);
    await rpc.request('globalState.writeKey', { key: 'appTipShown', value: true }, 5000);
    await rpc.close();
    const snapshot = profile.snapshot();
    restored = new RuntimeProfile(dir, recipe.credentialFiles, recipe.settingsFiles, snapshot);
    profile.close();
    rpc = new SubscriptionRpc(command!, recipe.args, subscriptionEnvironment(recipe, restored.directory), restored.workspace, recipe.framing);
    await rpc.request('ping', {}, 10000);
    expect((await rpc.request('globalState.load', {}, 5000)).appTipShown).toBe(true);
  } finally { await rpc?.close(); restored?.close(); profile.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);


test('two clients cannot race rotating credentials for the same account', async () => {
  const c = await context('long-stream'); const account = await connect(c, 'codex');
  const iterator = c.client.sendMessage('Hold account lease')[Symbol.asyncIterator]();
  await iterator.next();
  const other = startup(c.dir, { vault: c.vault, subscriptions: { openURL: async () => {}, resolveCommand: r => ({ command: process.execPath, prefix: [resolve('tests/subscription-fixtures/runtime.ts'), r, 'normal'] }) } });
  try { await expect(other.discoverModels(account)).rejects.toMatchObject({ code: 'POLICY' }); }
  finally { await other.subscriptions.shutdown(); other.db.close(); await c.client.logoutAccount(account.id); await expect(iterator.return!()).rejects.toMatchObject({ code: 'POLICY' }); }
  expect(c.vault.values.size).toBe(0);
});

test('GitHub subscription errors stay in the sign-in context and never ask for an API key', async () => {
  const c = await context('reject');
  const tui = new FutrynTuiApp({ client: c.client, cols: 80, rows: 24 }); await tui.initialize(); cleanup.push(() => tui.shutdown());
  await tui.executeSlashCommand('/login');
  for (const key of 'copilot') await tui.handleKey(key);
  await tui.handleKey('Enter'); await tui.handleKey('Enter');
  const deadline = Date.now() + 4000;
  while (!tui.computeFrameSnapshot().plainText.includes('AUTH:') && Date.now() < deadline) await Bun.sleep(10);
  const text = tui.computeFrameSnapshot().plainLines.map(line => line.trim()).join(' ');
  expect(text).toContain('GitHub sign-in could not be verified.');
  expect(text).toContain('Try signing in again.');
  expect(text).not.toContain('API key'); expect(text).not.toContain('environment variable');
  expect(c.app.accounts.list()).toHaveLength(0);
});
