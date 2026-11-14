import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FutrynTuiApp, SLASH_COMMANDS, getMatchingSlashCommands, parseRawTerminalKey } from '@hannes/tui';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { filterIntegrations } from '../../apps/tui/src/screens/connect';
import { fixtureServer } from '../fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function setup(auth: 'api-key' | 'none' = 'api-key', catalog: 'openai' | 'manual' = 'openai') {
  const server = fixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'futryn-connect-'));
  const app = startup(dir);
  const previous = process.env.FUTRYN_CONNECT_TEST_KEY;
  process.env.FUTRYN_CONNECT_TEST_KEY = 'synthetic-connect-sensitive-value';
  cleanups.push(() => { if (previous === undefined) delete process.env.FUTRYN_CONNECT_TEST_KEY; else process.env.FUTRYN_CONNECT_TEST_KEY = previous; rmSync(dir, { recursive: true, force: true }); });
  cleanups.push(() => server.server.stop(true));
  cleanups.push(() => app.db.close());
  app.registry.add(server.provider('chat', { id: 'fixture', auth, catalog, timeoutMs: 500 }));
  const tui = new FutrynTuiApp({ client: app.createFutrynClient(dir), cols: 100, rows: 28 });
  await tui.initialize();
  return { app, tui, server, dir };
}
async function type(tui: FutrynTuiApp, text: string) { for (const key of text) await tui.handleKey(key); }
async function waitFor(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function login(tui: FutrynTuiApp, _alias: string, method: 'env' | 'none' | 'api-key' = 'env') {
  await tui.executeSlashCommand('/login');
  await type(tui, 'fixture');
  expect(tui.computeFrameSnapshot().plainText).toContain('Fixture');
  await tui.handleKey('Enter');
  if (method === 'env') {
    await tui.handleKey('ArrowDown'); await tui.handleKey('Enter'); // More options
    await tui.handleKey('ArrowDown');
  }
  await tui.handleKey('Enter');
  if (method !== 'none') {
    await type(tui, method === 'env' ? 'FUTRYN_CONNECT_TEST_KEY' : 'synthetic-connect-sensitive-value');
    expect(tui.computeFrameSnapshot().plainText).not.toContain('synthetic-connect-sensitive-value');
    await tui.handleKey('Enter');
  }
}
async function action(tui: FutrynTuiApp, alias: string, index: number) {
  await tui.executeSlashCommand('/accounts');
  await type(tui, alias);
  await tui.handleKey('Enter');
  for (let i = 0; i < index; i++) await tui.handleKey('ArrowDown');
  await tui.handleKey('Enter');
}

test('registry-driven /login → env auth → model → HTTP chat → account lifecycle and restart', async () => {
  const { app, tui, server, dir } = await setup();
  expect(filterIntegrations(tui.client.listIntegrations(), 'FIXTURE')).toHaveLength(1);
  expect(filterIntegrations(tui.client.listIntegrations(), 'unknown')).toHaveLength(0);
  await login(tui, 'personal');
  await waitFor(() => tui.getActiveOverlay() === 'models');
  tui.client.renameAccount(tui.client.status().activeAccount!.id, 'personal');
  expect(tui.computeFrameSnapshot().plainText).toContain('fixture-model');
  await tui.handleKey('Enter');
  await tui.submitPrompt('First account message');
  expect(tui.getTranscript().at(-1)?.content).toBe('Hello fixture');
  const oldSession = tui.client.activeSession()!.id;
  await tui.executeSlashCommand('/model second-model');
  expect(tui.getStatusBanner()).toContain('NOT_FOUND');
  tui.client.addManualModel('second-model');
  await tui.executeSlashCommand('/model second-model');
  await tui.submitPrompt('Second model message');
  expect(tui.client.activeSession()!.id).not.toBe(oldSession);
  expect(server.requests.filter(r => r.body).at(-1)?.body.model).toBe('second-model');
  expect(JSON.stringify(server.requests.filter(r => r.body).at(-1)?.body)).not.toContain('First account message');
  await login(tui, 'work');
  await waitFor(() => tui.getActiveOverlay() === 'models');
  tui.client.renameAccount(tui.client.status().activeAccount!.id, 'work');
  await tui.handleKey('Enter');
  expect(app.accounts.list()).toHaveLength(2);
  await action(tui, 'work', 2); // Rename
  await type(tui, 'office'); await tui.handleKey('Enter');
  expect(app.accounts.get('office').providerId).toBe('fixture');
  await action(tui, 'personal', 0); // Switch → model
  expect(tui.getActiveOverlay()).toBe('models');
  expect(tui.client.status().activeAccount?.alias).toBe('personal');
  await tui.handleKey('Tab');
  expect(tui.client.status().activeAccount?.alias).toBe('office');
  await tui.handleKey('Escape');
  await tui.executeSlashCommand('/doctor');
  expect(tui.getStatusBanner()).toContain('Connected: office');
  const restarted = startup(dir);
  try {
    expect(restarted.createFutrynClient(dir).status().activeAccount?.alias).toBe('office');
    expect(restarted.createFutrynClient(dir).status().selection?.modelId).toBe('fixture-model');
  } finally { restarted.db.close(); }
  await action(tui, 'office', 4); // Logout is safe by default
  await tui.handleKey('Enter'); // default Cancel
  expect(app.accounts.get('office').status).toBe('valid');
  await action(tui, 'office', 4);
  await tui.handleKey('ArrowDown'); await tui.handleKey('Enter');
  expect(app.accounts.get('office').status).toBe('logged-out');
  expect(tui.client.cachedModels(app.accounts.get('office').id)).toHaveLength(0);
  expect(tui.client.status().activeAccount).toBeNull();
  await action(tui, 'office', 5); // Remove
  await tui.handleKey('ArrowDown'); await tui.handleKey('Enter');
  expect(app.accounts.list().map(a => a.alias)).toEqual(['personal']);
});

test('no-auth login needs no secret, failures roll back, expiry is actionable, cancellation cannot resurrect an account', async () => {
  const { app, tui, server } = await setup('none');
  await login(tui, 'local', 'none');
  await waitFor(() => tui.getActiveOverlay() === 'models');
  tui.client.renameAccount(tui.client.status().activeAccount!.id, 'local');
  expect(server.requests[0]?.authorization).toBeNull();
  await tui.handleKey('Enter');
  server.set({ status: 401 });
  await tui.executeSlashCommand('/doctor');
  expect(tui.getStatusBanner()).toContain('Credential rejected');
  await login(tui, 'rejected', 'none');
  await waitFor(() => tui.computeFrameSnapshot().plainText.includes('AUTH:'));
  expect(app.accounts.list().map(a => a.alias)).toEqual(['local']);
  server.set({ status: 200, delay: 300 });
  await login(tui, 'cancelled', 'none');
  expect(tui.computeFrameSnapshot().plainText).toContain('validating');
  await tui.handleKey('Escape');
  await waitFor(() => app.accounts.list().length === 1);
  expect(tui.getActiveOverlay()).toBe('connect');
  expect(app.accounts.list()).toHaveLength(1);
});

test('custom endpoint dialog configures protocol, no-auth and manual model with real validation generation', async () => {
  const { app, tui, server } = await setup('none');
  await tui.executeSlashCommand('/login');
  await type(tui, 'not-a-provider'); await tui.handleKey('Enter');
  await type(tui, 'gateway'); await tui.handleKey('Enter');
  await type(tui, server.url + '/v1'); await tui.handleKey('Enter');
  await tui.handleKey('Enter'); // Chat
  await tui.handleKey('ArrowDown'); await tui.handleKey('Enter'); // None
  for (let i = 0; i < 4; i++) await tui.handleKey('ArrowDown');
  await tui.handleKey('Enter'); // Manual
  await type(tui, 'manual-model'); await tui.handleKey('Enter');
  await tui.handleKey('Enter'); // No auth method
  await waitFor(() => tui.getActiveOverlay() === 'models');
  expect(app.registry.get('gateway').protocol).toBe('chat');
  expect(server.requests.some(r => r.body?.model === 'manual-model')).toBe(true);
  await tui.handleKey('Enter'); await tui.submitPrompt('Manual gateway chat');
  expect(tui.getTranscript().at(-1)?.content).toBe('Hello fixture');
  expect(() => tui.client.addProvider(server.provider('chat', { id: 'remote-http', baseURL: 'http://example.com/v1' }))).toThrow();
  expect(() => tui.client.addProvider(server.provider('chat', { id: 'url-secret', baseURL: 'https://user:secret@example.com/v1' }))).toThrow();
});

test('canonical commands, aliases, autocomplete, keyboard draft preservation, unsupported features and small dialogs', async () => {
  const { tui, server } = await setup();
  const commands = ['/login', '/logout', '/model', '/status', '/config', '/permissions', '/mcp', '/plugin', '/theme', '/resume', '/clear', '/compact', '/help', '/doctor', '/exit'];
  for (const command of commands) expect(SLASH_COMMANDS.some(c => c.command === command)).toBe(true);
  for (const [alias, canonical, overlay] of [['/connect', '/login', 'connect'], ['/models', '/model', 'models'], ['/settings', '/config', 'settings'], ['/themes', '/theme', 'themes'], ['/sessions', '/resume', 'sessions']] as const) {
    expect(getMatchingSlashCommands(alias!).some(c => c.command === canonical)).toBe(true);
    await tui.executeSlashCommand(alias!); expect(tui.getActiveOverlay()).toBe(overlay);
    await tui.handleKey('Escape');
  }
  await type(tui, 'preserved draft');
  await tui.executeSlashCommand('/login'); await tui.handleKey('Escape');
  expect(tui.getComposerState().value).toBe('preserved draft');
  await tui.handleKey('Ctrl+C'); expect(tui.isExitRequested()).toBe(false);
  expect(tui.getComposerState().value).toBe('');
  for (const c of ['/mcp', '/plugin', '/compact']) { await tui.executeSlashCommand(c); expect(tui.getStatusBanner()).toContain('Not implemented'); }
  await tui.submitPrompt('! echo must-not-execute');
  expect(tui.getStatusBanner()).toContain('Shell mode: Not implemented');
  expect(server.requests).toHaveLength(0);
  tui.client.addProvider(server.provider('chat', { id: 'openrouter' }));
  expect(tui.client.listIntegrations().find(i => i.provider.id === 'openrouter')!.methods.some(m => m.id === 'openrouter-oauth')).toBe(false);
  await expect(tui.client.beginProviderAuth('openrouter')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await tui.executeSlashCommand('/login');
  for (const [cols, rows] of [[30, 10], [40, 14], [80, 24]]) {
    tui.resize(cols!, rows!);
    const frame = tui.computeFrameSnapshot();
    expect(frame.plainLines).toHaveLength(rows!);
    expect(frame.plainLines.every(line => line.length === cols)).toBe(true);
    expect(frame.plainText).toContain('Connect');
  }
  await tui.handleKey('Escape'); await type(tui, '/logi'); await tui.handleKey('Tab');
  expect(tui.getComposerState().value).toBe('/login');
});

test.skipIf(process.env.HANNES_TEST_KEYRING !== '1')('TUI API key login uses real OS vault, reauthentication preserves identity and logout deletes the secret', async () => {
  const { app, tui } = await setup();
  await login(tui, 'native', 'api-key');
  await waitFor(() => tui.getActiveOverlay() === 'models');
  tui.client.renameAccount(tui.client.status().activeAccount!.id, 'native');
  const account = app.accounts.get('native');
  try {
    expect(await app.vault.get(account.credential)).toBe('synthetic-connect-sensitive-value');
    await action(tui, 'native', 3); // Reconnect
    await tui.handleKey('Enter'); // API key
    await type(tui, 'synthetic-rotated-value'); await tui.handleKey('Enter');
    await waitFor(() => tui.getActiveOverlay() === 'models');
    expect(app.accounts.get('native').id).toBe(account.id);
    expect(await app.vault.get(account.credential)).toBeUndefined();
    const rotated = app.accounts.get('native').credential;
    await action(tui, 'native', 4);
    await tui.handleKey('ArrowDown'); await tui.handleKey('Enter');
    expect(await app.vault.get(rotated)).toBeUndefined();
    expect(tui.computeFrameSnapshot().plainText).not.toContain('synthetic-');
  } finally { await app.accounts.logout(account.id, true); }
});

test.skipIf(process.platform === 'win32')('actual terminal: /login custom endpoint → model → streaming chat → restart → logout', async () => {
  const { dir, server } = await setup('none');
  const launch = () => {
    let output = '';
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({ cols: 110, rows: 32, data(_term, data) { output += decoder.decode(data, { stream: true }); } });
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], { terminal, env: { ...process.env, HANNES_HOME: dir, NO_COLOR: '1' } });
    return { terminal, child, output: () => output };
  };
  const first = launch();
  try {
    await waitFor(() => first.output().includes('FUTRYN'));
    first.terminal.write('/login\r');
    await waitFor(() => first.output().includes('Connect a provider'));
    first.terminal.write('fixture\r');
    await waitFor(() => first.output().includes('Sign in to Fixture'));
    first.terminal.write('\r');
    await waitFor(() => first.output().includes('fixture-model'));
    first.terminal.write('\rHello terminal\r');
    await waitFor(() => first.output().includes('Hello fixture'));
    expect(server.requests.some(r => r.body?.messages?.some((m: any) => m.content === 'Hello terminal'))).toBe(true);
    first.terminal.write('\x03');
    expect(await first.child.exited).toBe(0);
    expect(first.output()).toContain('\x1b[?1049l');
  } finally { first.child.kill(); await first.child.exited; first.terminal.close(); }
  const second = launch();
  try {
    await waitFor(() => second.output().includes('fixture'));
    second.terminal.write('/logout\r');
    await waitFor(() => second.output().includes('Manage accounts'));
    second.terminal.write('\r');
    await waitFor(() => second.output().includes('Account actions'));
    for (let i = 0; i < 4; i++) second.terminal.write('\x1b[B');
    second.terminal.write('\r');
    await waitFor(() => second.output().includes('Confirm account action'));
    second.terminal.write('\x1b[B\r');
    await waitFor(() => second.output().includes('Local credential removed'));
    second.terminal.write('\x1b\x03');
    expect(await second.child.exited).toBe(0);
  } finally { second.child.kill(); await second.child.exited; second.terminal.close(); }
}, 15000);

test('registered OpenRouter OAuth integrates hidden code → real HTTP exchange → vault → discovery → chat → logout', async () => {
  const { server, dir } = await setup();
  const { memoryVault } = await import('../fixtures');
  const vault = memoryVault();
  let challenge = '';
  const oauthServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as any;
    const actual = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier))).toString('base64url');
    if (actual !== challenge || body.code !== 'fixture-authorization-code') return Response.json({}, { status: 401 });
    return Response.json({ key: 'synthetic-oauth-issued-key' });
  } });
  cleanups.push(() => oauthServer.stop(true));
  const app = startup(dir, { vault, fetch: (async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : url.toString());
    expect(target.origin).toBe('https://openrouter.ai');
    const local = target.pathname === '/api/v1/auth/keys' ? `http://127.0.0.1:${oauthServer.port}` : server.url + target.pathname.replace('/api/v1', '/v1') + target.search;
    return fetch(local, init);
  }) as typeof fetch });
  cleanups.push(() => app.db.close());
  const tui = new FutrynTuiApp({ client: app.createFutrynClient(dir), cols: 120, rows: 32 });
  await tui.initialize();
  await expect(tui.client.beginProviderAuth('fixture')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await tui.executeSlashCommand('/login'); await type(tui, 'openrouter'); await tui.handleKey('Enter');
  expect(tui.computeFrameSnapshot().plainText).toContain('OpenRouter OAuth');
  await tui.handleKey('ArrowDown'); await tui.handleKey('Enter');
  const frame = tui.computeFrameSnapshot().plainText;
  const compact = frame.replace(/\s/g, '');
  challenge = /code_challenge=([^&]+)&/.exec(compact)![1]!;
  expect(frame).toContain('https://openrouter.ai/auth');
  await type(tui, 'fixture-authorization-code');
  expect(tui.computeFrameSnapshot().plainText).not.toContain('fixture-authorization-code');
  await tui.handleKey('Enter');
  await waitFor(() => tui.getActiveOverlay() === 'models');
  expect(vault.values.size).toBe(1);
  tui.client.renameAccount(tui.client.status().activeAccount!.id, 'oauth-account');
  expect(app.accounts.get('oauth-account').status).toBe('valid');
  await tui.handleKey('Enter'); await tui.submitPrompt('OAuth chat');
  expect(tui.getTranscript().at(-1)?.content).toBe('Hello fixture');
  expect(server.requests.filter(r => r.body).at(-1)?.authorization).toBe('Bearer synthetic-oauth-issued-key');
  await action(tui, 'oauth-account', 4); await tui.handleKey('ArrowDown'); await tui.handleKey('Enter');
  expect(vault.values.size).toBe(0);
  expect(tui.computeFrameSnapshot().plainText).not.toContain('synthetic-oauth-issued-key');
  // Custom endpoints cannot inherit the official authentication driver by ID.
  expect(tui.client.listIntegrations().find(i => i.provider.id === 'fixture')?.methods.some(m => m.id === 'openrouter-oauth')).toBe(false);
});


test('permission approvals bind the full target, expire, reject forged scopes and never enable tools', async () => {
  const { tui } = await setup();
  const prefix = '/workspace/' + 'a'.repeat(150);
  const first = tui.client.enqueuePermissionRequest({ capability: 'fs.write', action: 'Write', target: prefix + '/first', reason: 'Fixture' });
  tui.client.resolvePermission(first.approvalId, first.scopeHash, 'session');
  const second = tui.client.enqueuePermissionRequest({ capability: 'fs.write', action: 'Write', target: prefix + '/second', reason: 'Fixture' });
  expect(second.scopeHash).not.toBe(first.scopeHash);
  expect(second.status).toBe('pending');
  expect(() => tui.client.resolvePermission(second.approvalId, first.scopeHash, 'once')).toThrow();
  const expired = tui.client.enqueuePermissionRequest({ capability: 'network.connect', action: 'Connect', target: 'https://example.com', reason: 'Fixture', ttlMs: -1 });
  expect(() => tui.client.resolvePermission(expired.approvalId, expired.scopeHash, 'once')).toThrow();
  await tui.executeSlashCommand('/permissions');
  await tui.handleKey('n');
  expect(tui.client.listPermissions()).toHaveLength(3); // No production demo requests.
  expect(tui.client.capabilities().generalToolsExecution).toBe('not-implemented');
  tui.client.clearSessionView();
  const nextSession = tui.client.enqueuePermissionRequest({ capability: 'fs.write', action: 'Write', target: prefix + '/first', reason: 'New session' });
  expect(nextSession.status).toBe('pending');
});

test('terminal keyboard decoding and multiline composer preserve navigation and cancellation conventions', async () => {
  expect(parseRawTerminalKey('\x1b[A\x1b[B\x1b[Z\x03\x1b\r\n')).toEqual(['ArrowUp', 'ArrowDown', 'Shift+Tab', 'Ctrl+C', 'Alt+Enter', 'Ctrl+J']);
  expect(parseRawTerminalKey('\x1b[200~text\x1b[201~')).toEqual(['t', 'e', 'x', 't']);
  expect(parseRawTerminalKey('\x1b[<64;20;10M\x1b[<65;20;10M\x1b[<0;20;10M\x1b[<35;20;10m')).toEqual(['PageUp', 'PageDown']);
  const { tui } = await setup();
  await type(tui, 'First'); await tui.handleKey('Alt+Enter'); await type(tui, 'Second');
  expect(tui.getComposerState().value).toBe('First\nSecond');
  await tui.handleKey('Ctrl+C'); expect(tui.getComposerState().value).toBe('');
  expect(tui.isExitRequested()).toBe(false);
});

test.skipIf(process.platform === 'win32')('terminal SIGTERM during login drains credential rollback and restores terminal before exit', async () => {
  const { app, dir, server } = await setup('none');
  server.set({ delay: 500 });
  let output = '';
  const terminal = new Bun.Terminal({ cols: 100, rows: 28, data(_term, bytes) { output += Buffer.from(bytes).toString(); } });
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], { terminal, env: { ...process.env, HANNES_HOME: dir, NO_COLOR: '1' } });
  try {
    await waitFor(() => output.includes('FUTRYN'));
    terminal.write('/login\rfixture\r\r');
    await waitFor(() => server.requests.length > 0);
    child.kill('SIGTERM');
    expect(await Promise.race([child.exited, Bun.sleep(3000).then(() => -1)])).toBe(130);
    expect(output).toContain('\x1b[?25h');
    expect(output).toContain('\x1b[?1049l');
    expect(app.accounts.list()).toHaveLength(0);
  } finally { child.kill('SIGKILL'); await child.exited; terminal.close(); }
});
