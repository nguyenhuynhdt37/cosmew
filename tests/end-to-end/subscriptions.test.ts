import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MAX_INLINE_TOOL_ATTEMPTS, MAX_TOOL_CALLS } from '@hannes/core';
import { HannesError, type SubscriptionRuntime, type ModelEvent } from '@hannes/contracts';
import { FutrynTuiApp, renderContextIndicator, deriveTokensFromTriplet, reportRows } from '@hannes/tui';
import { RuntimeProfile } from '@hannes/persistence';
import { SUBSCRIPTION_RECIPES, subscriptionEnvironment } from '@hannes/security';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { SubscriptionRpc } from '../../apps/cli/src/subscriptions/rpc';
import { providerPresets } from '@hannes/models';
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
    await wait('Trust this folder?'); terminal.write('\x1b[A\r');
    await wait('Sign in to another account'); terminal.write('\r'); await wait('Choose your provider');
    if (vendor === 'GitHub Copilot') terminal.write('copilot');
    terminal.write('\r'); await wait(`Sign in to ${vendor}`);
    terminal.write('\r'); await wait('runtime-model');
    expect(output).not.toContain('Name this account'); expect(output).not.toContain('Enter API key');
    terminal.write('\r'); await wait('Ask anything');
    terminal.write('Hello from terminal\r'); await wait('Subscription fixture response');
    terminal.write('/logout\r'); await wait('You will need to sign in again.'); terminal.write('\x1b[B\r'); await wait('Signed out of');
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

for (const runtime of ['codex', 'copilot'] as const) test(`${runtime}: official usage/context/summary events and advertised effort reach a durable session`, async () => {
  const c = await context('telemetry'); await connect(c, runtime);
  expect(c.client.status().activeModel?.reasoningEfforts).toEqual(['low', 'high']);
  c.client.setReasoningEffort('high');
  const events = []; for await (const event of c.client.sendMessage('Explain briefly')) events.push(event);
  expect(events.some(e => e.type === 'reasoningDelta' && e.text === 'Provider supplied summary')).toBe(true);
  expect(c.client.usage().inputTokens).toBe(100); expect(c.client.usage().outputTokens).toBe(20);
  expect(c.client.usage().last?.usage?.reasoningTokens).toBe(8);
  expect(c.client.usage().last?.usage?.cacheReadTokens).toBe(30);
  expect(c.client.usage().costUSD).toBeNull();
  expect(c.client.usage().last?.usage?.quota?.[0]?.usedPercent).toBe(25);
  expect(c.client.usage().premiumRequests).toBe(runtime === 'copilot' ? 1.5 : null);
  expect(c.client.context().lastMeasured?.usedTokens).toBe(120);
  expect(c.client.context().measuredCurrentHistory).toBe(true);
  expect(c.client.context('new draft').measuredCurrentHistory).toBe(false);
  expect(c.client.status().activeModel?.contextLimit).toBe(32000);
  await c.client.discoverModels();
  expect(c.client.status().activeModel?.contextLimit).toBe(32000);
  expect(c.client.context().estimatedPercent).toBeNull(); // Runtime-added context is not locally measurable.
  const session = c.client.activeSession()!.id;
  const another = c.app.createFutrynClient(c.dir); another.resumeSession(session);
  expect(another.usage().inputTokens).toBe(100);
  expect(another.status().reasoningEffort).toBe('high');
  expect(c.app.conversations.get(session)?.messages.some(m => m.content.includes('Provider supplied summary'))).toBe(false);
  expect(() => another.setReasoningEffort('invented')).toThrow();
  // /usage limits: the plan snapshot belongs to this account and survives starting a new chat.
  const accountId = c.client.status().activeAccount!.id;
  c.client.clearSessionView();
  const limits = c.client.limits().find(entry => entry.accountId === accountId)!;
  expect(limits.source).toBe('last-turn');
  expect(limits.items[0]?.usedPercent).toBe(25);
});

for (const runtime of ['gemini-cli', 'qwen-code'] as const) test(`${runtime}: ACP thought chunks stream separately before the answer`, async () => {
  const c = await context('thought-stream'); await connect(c, runtime);
  let reasoning = ''; let answer = ''; let thoughtBeforeAnswer = false;
  for await (const event of c.client.sendMessage('Show available provider thinking')) {
    if (event.type === 'reasoningDelta') { reasoning += event.text; if (!answer) thoughtBeforeAnswer = true; }
    if (event.type === 'textDelta') answer += event.text;
  }
  expect(thoughtBeforeAnswer).toBe(true);
  expect(reasoning).toBe('Provider thought continued');
  expect(answer).toBe('Subscription fixture response');
  expect(c.client.activeSession()!.messages.some(message => message.content.includes('Provider thought'))).toBe(false);
});

test('Codex catalog selects the runnable model slug and excludes hidden entries on first login', async () => {
  const c = await context('catalog-slug'); await connect(c, 'codex');
  expect(c.client.cachedModels().map(model => model.id)).toEqual(['runtime-model', 'runtime-alt']);
  expect(c.client.status().selection?.modelId).toBe('runtime-model');
  expect(c.client.context().limitTokens).toBeNull(); // Model/list does not advertise a context window.
  for await (const _event of c.client.sendMessage('First login')) { /* real fixture runtime */ }
  expect(c.client.usage().last?.outcome).toBe('completed');
});

for (const runtime of Object.keys(ids) as SubscriptionRuntime[]) for (const key of ['Escape', 'Ctrl+C']) test(`${runtime}: ${key} cancels sign-in recovery started by switch`, async () => {
  const c = await context('slow-auth');
  c.app.registry.add(providerPresets.find(p => p.id === ids[runtime])!);
  const expired = await c.app.accounts.add(ids[runtime], 'expired', {kind: 'runtime', runtime, key: crypto.randomUUID()});
  await c.app.accounts.logout(expired.id);
  const tui = new FutrynTuiApp({client: c.client, cols: 100, rows: 30}); await tui.initialize(); cleanup.push(() => tui.shutdown());
  await tui.executeSlashCommand('/switch expired'); await tui.handleKey('ArrowDown'); await tui.handleKey('Enter');
  expect(tui.computeFrameSnapshot().plainText).toContain('Sign in to expired');
  await tui.handleKey('Enter');
  await Bun.sleep(30); // Authentication is deliberately unfinished in the real fixture process.
  await tui.handleKey(key);
  expect(tui.getActiveOverlay()).toBe('none');
  await tui.shutdown();
  expect(c.app.accounts.get(expired.id).status).toBe('logged-out');
  expect(c.vault.values.size).toBe(0);
  expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
  expect(c.client.status().selection).toBeNull();
});

test.skipIf(process.platform === 'win32')('actual PTY: Esc cancels redirected subscription sign-in and returns to the account chooser', async () => {
  const c = await context('slow-auth'); let output = '';
  const terminal = new Bun.Terminal({cols: 100, rows: 30, data(_t, bytes) { output += Buffer.from(bytes).toString('utf8'); }});
  const child = Bun.spawn([process.execPath, resolve('tests/subscription-fixtures/tui.ts')], {terminal, env: {...process.env, FUTRYN_TEST_HOME: c.dir, FUTRYN_TEST_SCENARIO: 'slow-auth', NO_COLOR: '1'}});
  const wait = async (text: string, offset = 0) => { const deadline = Date.now() + 4000; while (!output.slice(offset).includes(text) && Date.now() < deadline) await Bun.sleep(10); expect(output.slice(offset)).toContain(text); };
  try {
    await wait('Trust this folder?'); terminal.write('\x1b[A\r');
    await wait('Sign in to another account'); terminal.write('\r'); await wait('Choose your provider');
    terminal.write('\r'); await wait('Sign in to OpenAI'); terminal.write('\r');
    await wait('ABCD-1234');
    const mark = output.length; terminal.write('\x1b');
    await wait('Sign in to another account', mark);
    terminal.write('\x03');
    expect(await Promise.race([child.exited, Bun.sleep(4000).then(() => -1)])).toBe(0);
    expect(c.app.accounts.list()).toHaveLength(0);
    expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
  } finally { child.kill('SIGKILL'); await child.exited; terminal.close(); }
}, 15000);

async function readContext(scenario: string, enabled = true) {
  const c = await context(scenario); await connect(c, 'codex');
  const ws = mkdtempSync(join(tmpdir(), 'futryn-codex-read-')); cleanup.push(() => rmSync(ws, {recursive: true, force: true}));
  writeFileSync(join(ws, 'README.md'), 'Project NFY fixture: a banana inventory service.\n');
  writeFileSync(join(ws, '.env'), 'PRIVATE_KEY=never-send-this-value\n');
  const client = c.app.createFutrynClient(ws); client.setToolsEnabled(enabled);
  const tui = new FutrynTuiApp({client, cols: 100, rows: 30}); await tui.initialize(); cleanup.push(() => tui.shutdown());
  return {...c, client, tui, ws};
}
async function waitForRead(check: () => boolean) { const end = Date.now() + 4000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); }

test('Codex subscription reads the actual workspace through Hannes and persists the result', async () => {
  const c = await readContext('read-file');
  await c.tui.submitPrompt('Read README.md and describe this project');
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.content).toContain('banana inventory service');
  expect(answer.toolResults?.[0]).toMatchObject({name: 'read', status: 'ok', target: 'README.md'});
  const id = c.client.activeSession()!.id;
  const saved = c.app.conversations.get(id)!;
  expect(saved.messages.some(m => m.role === 'tool' && m.content.includes('banana inventory service'))).toBe(true);
  expect((c.app.db.query('SELECT phase FROM tool_audit ORDER BY rowid').all() as {phase: string}[]).map(r => r.phase)).toEqual(['requested','decided','completed']);
  const estimate = c.client.context().estimateTokens;
  const another = c.app.createFutrynClient(c.ws); another.setToolsEnabled(true); another.resumeSession(id);
  expect(another.context().estimateTokens).toBe(estimate);
  expect(another.activeSession()!.messages.some(m => m.role === 'tool')).toBe(true);
});

test('Codex read bridge offers no tools before workspace consent', async () => {
  const c = await readContext('read-file', false);
  await c.tui.submitPrompt('Read README.md');
  expect(c.tui.getTranscript().at(-1)!.toolResults ?? []).toHaveLength(0);
  expect(c.app.db.query('SELECT * FROM tool_audit').all()).toHaveLength(0);
});

test('Codex secret read asks; Esc denies without sending the file content', async () => {
  const c = await readContext('read-secret');
  const turn = c.tui.submitPrompt('Read .env');
  await waitForRead(() => c.client.listPendingPermissions().length === 1);
  c.tui.advanceStartupGate(); expect(c.tui.getActiveOverlay()).toBe('permissions');
  await c.tui.handleKey('Escape'); await turn;
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.toolResults?.[0]).toMatchObject({status: 'denied'});
  expect(answer.content).not.toContain('never-send-this-value');
  expect(c.app.conversations.get(c.client.activeSession()!.id)!.messages.find(m => m.role === 'tool')?.content).toContain('[denied:');
  expect(c.client.listPendingPermissions()).toHaveLength(0);
});

test('Codex read outside the workspace is denied by the same dispatcher', async () => {
  const c = await readContext('read-outside'); await c.tui.submitPrompt('Read outside');
  expect(c.tui.getTranscript().at(-1)!.toolResults?.[0]).toMatchObject({status: 'denied', code: 'DENIED'});
});

for (const scenario of ['read-unknown', 'read-wrong-turn', 'read-wrong-thread', 'read-namespace', 'read-duplicate', 'read-runaway']) test(`Codex dynamic request fails closed: ${scenario}`, async () => {
  const c = await readContext(scenario);
  const events: ModelEvent[] = [];
  await expect((async () => { for await (const event of c.client.sendMessage('Inspect project')) events.push(event); })()).rejects.toBeInstanceOf(HannesError);
  expect(events.some(e => e.type === 'completed')).toBe(false);
  const results = events.flatMap(e => e.type === 'toolResult' ? [e.result] : []);
  expect(results.length).toBeLessThanOrEqual(MAX_INLINE_TOOL_ATTEMPTS);
  if (scenario === 'read-runaway') {
    // ADR 0020: 32 calls run, a few more are refused unexecuted, then the turn fails closed.
    expect(results).toHaveLength(MAX_INLINE_TOOL_ATTEMPTS);
    expect(results.slice(MAX_TOOL_CALLS).every(r => r.code === 'TOOL_BUDGET')).toBe(true);
    expect((c.app.db.query("SELECT count(*) AS n FROM tool_audit WHERE phase='completed'").get() as {n: number}).n).toBe(MAX_TOOL_CALLS);
  }
  expect(c.client.listPendingPermissions()).toHaveLength(0);
});

test('Codex tool budget: a model that stops after the refusal still completes; rereads return the unchanged notice', async () => {
  const c = await readContext('read-repeat'); // 34 identical README reads, then it answers with the last result
  const events: ModelEvent[] = [];
  for await (const event of c.client.sendMessage('Inspect project')) events.push(event);
  const results = events.flatMap(e => e.type === 'toolResult' ? [e.result] : []);
  expect(results).toHaveLength(34);
  expect(results[0]!.content).toContain('banana inventory service');
  expect(results.slice(1, MAX_TOOL_CALLS).every(r => r.status === 'ok' && r.content.startsWith('[unchanged]'))).toBe(true);
  expect(results.slice(MAX_TOOL_CALLS).map(r => r.code)).toEqual(['TOOL_BUDGET', 'TOOL_BUDGET']);
  expect((c.app.db.query("SELECT count(*) AS n FROM tool_audit WHERE phase='completed'").get() as {n: number}).n).toBe(MAX_TOOL_CALLS);
  expect(events.at(-1)!.type).toBe('completed');
});

async function exploreContext(files: Record<string, string>) {
  const c = await readContext('explore');
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(c.ws, path)), {recursive: true}); writeFileSync(join(c.ws, path), text); }
  const targets = () => (c.app.db.query("SELECT tool, target FROM tool_audit WHERE phase='completed' ORDER BY rowid").all() as {tool: string; target: string}[]).map(r => `${r.tool} ${r.target}`);
  return {...c, targets};
}
const exploreRepository = {
  'src/routes.ts': "import { verifyToken } from './service';\nexport const login = (token: string) => verifyToken(token);\n",
  'src/service.ts': "export function verifyToken(token: string) { return token === 'SERVICE_MARKER'; }\n",
  'src/billing.ts': "export const invoice = 'UNRELATED_MARKER';\n",
};

test('Codex progressive exploration: each dynamic call is derived from the previous Hannes result', async () => {
  const c = await exploreContext(exploreRepository);
  await c.tui.submitPrompt('How does the login route check tokens?');
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.errorText).toBeUndefined();
  expect(answer.content).toContain('verifyToken is defined in src/service.ts');
  expect(answer.content).toContain('SERVICE_MARKER');
  expect(c.targets()).toEqual(['glob .', 'read src/routes.ts', 'read src/service.ts']);
  expect(answer.toolResults?.map(r => r.callId)).toEqual(answer.toolCalls?.map(call => call.id));
  const saved = c.app.conversations.get(c.client.activeSession()!.id)!.messages;
  expect(saved.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  expect(JSON.stringify(saved)).not.toContain('UNRELATED_MARKER');
});

test('Codex negative: a routes.ts that references another file is followed there instead', async () => {
  const c = await exploreContext({...exploreRepository,
    'src/routes.ts': "import { verifyToken } from './token-check';\nexport const login = (token: string) => verifyToken(token);\n",
    'src/token-check.ts': "export function verifyToken(token: string) { return 'TOKEN_CHECK_MARKER' + token; }\n"});
  await c.tui.submitPrompt('How does the login route check tokens?');
  expect(c.tui.getTranscript().at(-1)!.content).toContain('verifyToken is defined in src/token-check.ts');
  expect(c.targets()).toEqual(['glob .', 'read src/routes.ts', 'read src/token-check.ts']);
});

test('cancelling Codex while it awaits a read approval drains the pending tool', async () => {
  const c = await readContext('read-secret'); const abort = new AbortController();
  const operation = (async () => { for await (const _event of c.client.sendMessage('Read .env', {signal: abort.signal})) {} })().then(() => null, error => error);
  await waitForRead(() => c.client.listPendingPermissions().length === 1);
  abort.abort(); expect(await operation).toMatchObject({code: 'CANCELLED'});
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  expect(readdirSync(join(c.dir, 'runtime-tmp'))).toEqual([]);
});

test('Codex builtin shell stays denied even when dynamic workspace reads are enabled', async () => {
  const c = await readContext('tool-attempt');
  await expect((async () => { for await (const _event of c.client.sendMessage('Attempt shell')) {} })()).rejects.toMatchObject({code: 'POLICY'});
  expect(c.app.db.query('SELECT * FROM tool_audit').all()).toHaveLength(0);
});

test('Codex read content is redacted before runtime output and durable tool messages', async () => {
  const c = await readContext('read-file');
  const secret = 'fixture-private-registered-value'; c.app.redactor.register(secret);
  writeFileSync(join(c.ws, 'README.md'), 'Public text with registered token ' + secret);
  await c.tui.submitPrompt('Read README.md');
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.content).toContain('[REDACTED]');
  expect(answer.content).not.toContain(secret);
  expect(JSON.stringify(c.app.conversations.get(c.client.activeSession()!.id))).not.toContain(secret);
});

for (const name of ['glob', 'grep'] as const) test(`Codex ${name} searches actual workspace data through the shared dispatcher`, async () => {
  const c = await readContext('read-' + name); await c.tui.submitPrompt('Inspect project');
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.toolResults?.[0]).toMatchObject({name, status: 'ok'});
  expect(answer.content).toContain('README.md');
  if (name === 'grep') expect(answer.content).toContain('banana inventory service');
});

test.skipIf(process.platform === 'win32')('actual PTY: approve project, login ChatGPT, read README and show a successful read card', async () => {
  const c = await context('read-file');
  const ws = mkdtempSync(join(tmpdir(), 'futryn-pty-read-')); cleanup.push(() => rmSync(ws, {recursive: true, force: true}));
  writeFileSync(join(ws, 'README.md'), 'PTY project is a banana inventory service.\n');
  let output = '';
  const terminal = new Bun.Terminal({cols: 100, rows: 30, data(_t, bytes) { output += Buffer.from(bytes).toString('utf8'); }});
  const child = Bun.spawn([process.execPath, resolve('tests/subscription-fixtures/tui.ts')], {terminal, env: {...process.env, FUTRYN_TEST_HOME: c.dir, FUTRYN_TEST_WORKSPACE: ws, FUTRYN_TEST_SCENARIO: 'read-file', NO_COLOR: '1'}});
  const plain = () => output.replace(/\x1b\[[0-9;]*m/g, '');
  const wait = async (text: string) => {const end = Date.now() + 5000; while (!plain().includes(text) && Date.now() < end) await Bun.sleep(10); expect(plain()).toContain(text);};
  try {
    await wait('Trust this folder?'); terminal.write('\x1b[A\r');
    await wait('Sign in to another account'); terminal.write('\r'); await wait('Choose your provider'); terminal.write('\r');
    await wait('Sign in to OpenAI'); terminal.write('\r'); await wait('runtime-model'); terminal.write('\r'); await wait('Ask anything');
    terminal.write('Read README.md and summarize the project\r');
    await wait('banana inventory service'); await wait('└ Read README.md'); await wait('Completed turn');
    terminal.write('\x03');
    expect(await Promise.race([child.exited, Bun.sleep(4000).then(() => -1)])).toBe(0);
    expect(output).not.toContain('fixture-runtime-secret');
  } finally {child.kill('SIGKILL'); await child.exited; terminal.close();}
}, 15000);

test('Codex receives actual project context and source metadata on new and resumed conversations', async () => {
  const c = await readContext('read-context');
  await c.tui.submitPrompt('Inspect this project');
  const id = c.client.activeSession()!.id;
  const another = c.app.createFutrynClient(c.ws); another.setToolsEnabled(true); another.resumeSession(id);
  const results = [];
  for await (const event of another.sendMessage('Recheck the README')) if (event.type === 'toolResult') results.push(event.result);
  expect(results[0]).toMatchObject({status:'ok', target:'README.md'});
  expect(c.tui.getTranscript().at(-1)!.content).not.toContain('runtime-tmp/');
});

for (const runtime of ['codex','copilot'] as const) test(`${runtime}: typing keeps local context separate from the last runtime measurement`, async () => {
  const c = await context('telemetry'); await connect(c, runtime); c.client.setReasoningEffort('high');
  for await (const _event of c.client.sendMessage('Short reply')) {}
  const tokens = deriveTokensFromTriplet('#101520','#edf2ff','#f69e6f');
  const line = (draft: string) => renderContextIndicator(c.client.context(draft), 100, tokens).spans.map(span => span.text).join('');
  const baseline = c.client.context().estimateTokens;
  expect(c.client.context().lastMeasured?.usedTokens).toBe(120);
  for (const draft of ['', 'a', 'ab', 'abc', '']) {
    expect(line(draft)).toContain('Context  ~');
    expect(line(draft)).toContain('local estimate');
    expect(line(draft)).toContain('last runtime 120');
    expect(c.client.context(draft).estimateTokens).toBeGreaterThanOrEqual(baseline);
  }
  expect(c.client.context('/context').estimateTokens).toBe(baseline);
  expect(c.client.context('/permissions').estimateTokens).toBe(baseline);
  expect(c.client.context().lastMeasured?.usedTokens).toBe(120);
  const abort = new AbortController();
  const next = c.client.sendMessage('Next turn', {signal: abort.signal})[Symbol.asyncIterator]();
  expect((await next.next()).value?.type).toBe('started');
  expect(c.client.context().lastMeasured?.usedTokens).toBe(120);
  expect(c.client.context().measuredCurrentHistory).toBe(false);
  abort.abort(); await expect(next.next()).rejects.toMatchObject({code: 'CANCELLED'});
  expect(c.client.context().lastMeasured?.usedTokens).toBe(120);
});

test.skipIf(process.platform === 'win32')('actual PTY: pending read permission denies on Esc and returns to a compact empty manager', async () => {
  const c = await context('read-secret');
  const ws = mkdtempSync(join(tmpdir(),'futryn-permission-pty-')); cleanup.push(() => rmSync(ws,{recursive:true,force:true}));
  writeFileSync(join(ws,'.env'),'PRIVATE_TOKEN=fixture-do-not-disclose\n');
  let output = '';
  const terminal = new Bun.Terminal({cols:100,rows:30,data(_t,bytes){output+=Buffer.from(bytes).toString('utf8');}});
  const child = Bun.spawn([process.execPath,resolve('tests/subscription-fixtures/tui.ts')],{terminal,env:{...process.env,FUTRYN_TEST_HOME:c.dir,FUTRYN_TEST_WORKSPACE:ws,FUTRYN_TEST_SCENARIO:'read-secret',NO_COLOR:'1'}});
  const plain = () => output.replace(/\x1b\[[0-9;]*m/g,'');
  const wait = async(text:string, from=0)=>{const end=Date.now()+5000;while(!plain().slice(from).includes(text)&&Date.now()<end)await Bun.sleep(10);expect(plain().slice(from)).toContain(text);};
  try {
    await wait('Trust this folder?');terminal.write('\x1b[A\r');
    await wait('Sign in to another account');terminal.write('\r');await wait('Choose your provider');terminal.write('\r');
    await wait('Sign in to OpenAI');terminal.write('\r');await wait('runtime-model');terminal.write('\r');await wait('Ask anything');
    terminal.write('Read .env\r');await wait('Permission request');await wait('Target: ".env"');
    terminal.write('\x1b');await wait('Completed turn');
    expect(output).not.toContain('fixture-do-not-disclose');
    const mark=plain().length;terminal.write('/permissions\r');await wait('No requests waiting',mark);
    expect(plain().slice(mark)).not.toContain('Allow once');
    terminal.write('\x1b');await Bun.sleep(60);terminal.write('\x03');
    expect(await Promise.race([child.exited,Bun.sleep(4000).then(()=>-1)])).toBe(0);
  } finally {child.kill('SIGKILL');await child.exited;terminal.close();}
},15000);

test('Task 01 context reaches Codex as one current user message, never developer instructions',async()=>{
 const c=await readContext('read-project-instructions');writeFileSync(join(c.ws,'AGENTS.md'),'RULE_TASK01_NATIVE_V1');
 await c.tui.submitPrompt('Explain the project');expect(c.tui.getTranscript().at(-1)!.toolResults?.[0]?.status).toBe('ok');
 const hash=c.client.projectContext()!.sources[0]!.hash;
 writeFileSync(join(c.ws,'AGENTS.md'),'RULE_TASK01_NATIVE_V2');
 await c.tui.submitPrompt('Explain the updated project');expect(c.tui.getTranscript().at(-1)!.toolResults?.[0]?.status).toBe('ok');
 expect(c.client.projectContext()!.sources[0]!.hash).not.toBe(hash);
});

test('Codex usage: three inline calls select cumulative totals once across receipts, SDK and TUI', async () => {
  const c = await readContext('usage-three');
  const events: ModelEvent[] = [];
  for await (const event of c.client.sendMessage('Read README twice, then answer')) events.push(event);
  expect(events.filter(e => e.type === 'toolResult')).toHaveLength(2);
  const usage = {inputTokens:600,outputTokens:90,costUSD:null,cacheReadTokens:260,cacheWriteTokens:60,reasoningTokens:35};
  expect(events.at(-1)).toMatchObject({type:'completed',usage});
  expect(events.filter(e => e.type === 'usage').map(e => e.type === 'usage' ? [e.usage.inputTokens,e.usage.outputTokens] : [])).toEqual([[100,20],[300,50],[600,90],[600,90]]);
  expect(c.client.usage()).toMatchObject({inputTokens:600,outputTokens:90,reportedTurns:1,unknownTurns:0,last:{outcome:'completed',usage}});
  expect(c.client.usage().last?.usage?.quota?.[0]?.usedPercent).toBe(40);
  expect(c.client.context().lastMeasured).toMatchObject({usedTokens:340,limitTokens:32000});
  const id = c.client.activeSession()!.id;
  expect(c.app.conversations.get(id)?.turns?.at(-1)?.usage).toMatchObject(usage);
  expect(reportRows(c.client,'usage','',true).join('\n')).toContain('Input subtotal: 600 · Output subtotal: 90');
  expect(reportRows(c.client,'usage','',true).join('\n')).toContain('Cache read: 260 · Cache write: 60');
  const resumed = c.app.createFutrynClient(c.ws); resumed.setToolsEnabled(true); resumed.resumeSession(id);
  expect(resumed.usage()).toMatchObject({inputTokens:600,outputTokens:90,last:{usage}});
  // A new ephemeral thread starts at zero; its lifetime totals are counted only once too.
  for await (const _event of resumed.sendMessage('Another turn')) { /* drain */ }
  expect(resumed.usage()).toMatchObject({inputTokens:1200,outputTokens:180,reportedTurns:2});
});

test('Codex usage: notifications before turn/start response are fenced and ordered', async () => {
  const c = await context('usage-early'); await connect(c,'codex');
  for await (const _event of c.client.sendMessage('hello')) { /* drain */ }
  expect(c.client.usage()).toMatchObject({inputTokens:600,outputTokens:90});
  expect(c.client.context().lastMeasured).toMatchObject({usedTokens:340,limitTokens:32000});
});

for (const scenario of ['usage-none','usage-quota-only','usage-last-only','usage-unordered','usage-partial']) test(`Codex usage: ${scenario} never fabricates missing totals`, async () => {
  const c = await context(scenario); await connect(c,'codex');
  for await (const _event of c.client.sendMessage('hello')) { /* drain */ }
  const partial = scenario === 'usage-partial';
  expect(c.client.usage()).toMatchObject({inputTokens:partial ? 600 : null,outputTokens:null,reportedTurns:0,unknownTurns:1});
  const usage = c.client.usage().last?.usage;
  expect(usage?.costUSD).toBeNull();
  expect(usage?.quota?.[0]?.usedPercent).toBe(25);
  if (partial) {
    expect(usage).toMatchObject({cacheReadTokens:null,cacheWriteTokens:null,reasoningTokens:null});
    expect(c.client.context().lastMeasured).toMatchObject({usedTokens:null,limitTokens:null});
  }
});

for (const scenario of ['usage-cancel','usage-fail']) test(`Codex usage: ${scenario} retains only measured partial usage without completion`, async () => {
  const c = await context(scenario); await connect(c,'codex');
  const controller = new AbortController(); const events: ModelEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of c.client.sendMessage('hello',{signal:controller.signal})) {
      events.push(event);
      if (scenario === 'usage-cancel' && event.type === 'usage') controller.abort();
    }
  } catch (error) {caught=error;}
  expect(caught).toBeInstanceOf(HannesError);
  expect(events.some(e => e.type === 'completed')).toBe(false);
  expect(c.client.usage().last).toMatchObject({outcome:scenario === 'usage-cancel' ? 'cancelled' : 'failed',usage:{inputTokens:100,outputTokens:20}});
});
