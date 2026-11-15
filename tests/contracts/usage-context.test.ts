import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HannesError, type ModelPort } from '@hannes/contracts';
import { providerPresets } from '@hannes/models';
import { Conversation } from '@hannes/core';
import { openPrivateDatabase, SqliteConversations } from '@hannes/persistence';
import { acceptSlashSelection, parseSlashCommand, SLASH_COMMANDS } from '@hannes/sdk';
import { Redactor, redactModel } from '@hannes/security';
import { deriveTokensFromTriplet, FutrynTuiApp, createInitialComposerState, getMatchingSlashCommands, renderPromptComposerLines, reportRows, renderReportOverlay, renderHelpOverlay, filterPaletteCommands } from '@hannes/tui';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { fixtureServer, memoryVault } from '../fixtures';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'futryn-usage-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
async function setup() {
  const dir = directory(); const server = fixtureServer(); cleanup.push(() => server.server.stop(true));
  const vault = memoryVault(); const app = startup(dir, { vault }); cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', { id: 'usage', auth: 'none', streamUsage: true }));
  const account = await app.accounts.add('usage', 'first', { kind: 'none' });
  const client = app.createFutrynClient(dir); await client.discoverModels(); client.selectModel('fixture-model');
  const tui = new FutrynTuiApp({ client, cols: 80, rows: 24 }); await tui.initialize(); cleanup.push(() => tui.shutdown());
  return { app, client, tui, dir, account, server, vault };
}
async function send(client: ReturnType<typeof startup>['createFutrynClient'] extends (...args: any[]) => infer R ? R : never, text: string) {
  for await (const _event of client.sendMessage(text)) { /* real HTTP adapter */ }
}

test('every command alias resolves before arguments; selected slash rows beyond the first page match execution', () => {
  for (const definition of SLASH_COMMANDS) for (const alias of definition.aliases) {
    const parsed = parseSlashCommand(alias + (definition.arguments === 'required' ? ' value' : ''));
    expect(parsed.error).toBeUndefined(); expect(parsed.definition?.command).toBe(definition.command);
  }
  expect(SLASH_COMMANDS.some(c => ['/theme edit', '/theme set', '/accounts', '/new'].includes(c.command))).toBe(false);
  // /switch is public again (ADR 0013 amendment): discoverable in autocomplete, help and the palette.
  expect(SLASH_COMMANDS.find(c => c.command === '/switch')?.aliases).toEqual(['/account']);
  expect(getMatchingSlashCommands('/sw').map(c => c.command)).toContain('/switch');
  expect(getMatchingSlashCommands('/').map(c => c.command)).not.toContain('/theme edit');
  expect(parseSlashCommand('/theme edit').definition?.unavailable).toContain('unavailable');
  expect(parseSlashCommand('/theme set dark').definition?.unavailable).toContain('Use /theme');
  expect(parseSlashCommand('/stats').definition?.command).toBe('/usage');
  expect(parseSlashCommand('/new').definition?.command).toBe('/clear');
  expect(parseSlashCommand('/reset').definition?.command).toBe('/clear');
  expect(acceptSlashSelection('/model explicit argument', SLASH_COMMANDS.find(c => c.command === '/usage'))).toBe('/model explicit argument');
  expect(parseSlashCommand('/models Mixed-Case').input).toBe('/model Mixed-Case');
  expect(parseSlashCommand('/usage surprise').error).toContain('Usage:');
  expect(parseSlashCommand('/usege').error).toContain('/usage');
  const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
  const themeMatches = getMatchingSlashCommands('/theme').map(command => command.command);
  expect(themeMatches).toEqual(['/theme']);
  expect(filterPaletteCommands('theme').map(command => command.command)).toEqual(['/theme']);
  const help = renderHelpOverlay({width:120, height:80, tokens, borderStyle:'rounded'}).flatMap(row => row.spans.map(span => span.text)).join('\n');
  expect(help).toContain('/theme');
  for (const hidden of ['/theme set', '/theme edit', '/accounts']) expect(help).not.toContain(hidden);
  expect(help).toContain('/switch');
  const state = { ...createInitialComposerState(), value: '/', slashMenuOpen: true };
  expect(getMatchingSlashCommands('/themes')[0]?.command).toBe('/theme');
  expect(getMatchingSlashCommands('/model')[0]?.command).toBe('/model');
  const matches = getMatchingSlashCommands('/');
  for (let selected = 0; selected < matches.length; selected++) {
    state.slashSelectedIndex = selected;
    const rows = renderPromptComposerLines({ width: 70, maxHeight: 12, state, mode: 'chat', activeModelLabel: 'model', activeAccountLabel: 'account', isStreaming: false, focused: true, tokens, borderStyle: 'rounded' });
    const highlight = rows.flatMap(row => row.spans).find(span => span.text.includes('▸ '));
    expect(highlight?.text).toContain(matches[selected]!.command);
  }
});

test('usage receipts survive resume and restart, retain price provenance, and never leak another session totals', async () => {
  const c = await setup();
  c.app.settings.update(state => {
    const model = state.catalogs[0]!.models[0]!;
    model.contextLimit = 32000; model.outputLimit = 4096;
    model.pricing = { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' };
    model.metadataSource = 'fixture:pricing'; model.metadataFetchedAt = new Date().toISOString();
  });
  await send(c.client, 'One'); await send(c.client, 'Two');
  const id = c.client.activeSession()!.id;
  expect(c.client.usage().inputTokens).toBe(8); expect(c.client.usage().outputTokens).toBe(4);
  expect(c.client.usage().reportedTurns).toBe(2); expect(c.client.usage().costUSD).toBeCloseTo(0.000016);
  expect(c.client.usage().last?.usage?.costEstimated).toBe(true);
  expect(c.client.usage().last?.usage?.pricingSource).toBe('fixture:pricing');
  expect(c.client.context('next').estimatedPercent).not.toBeNull();
  c.client.createSession(); expect(c.client.status().lastUsage).toBeNull();
  c.client.resumeSession(id); expect(c.client.usage().inputTokens).toBe(8);
  const restarted = startup(c.dir, { vault: c.vault });
  try { const next = restarted.createFutrynClient(); next.resumeSession(id); expect(next.usage().inputTokens).toBe(8); }
  finally { restarted.db.close(); }
  for (const command of ['/usage', '/cost', '/context', '/status']) {
    await c.tui.executeSlashCommand(command);
    expect(c.tui.getActiveOverlay()).toBe(command === '/cost' ? 'usage' : command.slice(1) as 'usage' | 'context' | 'status');
    c.tui.resize(30, 10);
    const initial = c.tui.computeFrameSnapshot();
    await c.tui.handleKey('PageDown');
    expect(c.tui.computeFrameSnapshot().plainText).not.toBe(initial.plainText);
    await c.tui.handleKey('Escape'); c.tui.resize(80, 24);
  }
  expect(reportRows(c.client, 'usage', '', true).join(' ')).toContain('subset of output');
  const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
  const report = renderReportOverlay({ title: 'report', rows: reportRows(c.client, 'status'), width: 20, height: 8, offset: 99999, tokens });
  expect(report.lines.length).toBeLessThanOrEqual(8); expect(report.offset).toBeLessThan(99999);
});

test('unknown usage stays unknown; old history is not backfilled with zero consumption', async () => {
  const c = await setup(); c.server.set({ includeUsage: false });
  await c.tui.submitPrompt('Usage unavailable');
  expect(c.client.usage().inputTokens).toBeNull(); expect(c.client.usage().costUSD).toBeNull();
  expect(c.tui.getStatusBanner()).toContain('not reported');
  const old = c.app.conversations.create({ accountId: c.account.id, modelId: 'fixture-model' });
  c.app.conversations.append(old, { role: 'user', content: 'Historical' }, 'committed');
  c.app.conversations.append(old, { role: 'assistant', content: 'Historical response' }, 'committed');
  c.client.resumeSession(old);
  expect(c.client.status().lastUsage).toBeNull(); expect(c.client.usage().historicalTurns).toBe(1);
  expect(c.client.usage().inputTokens).toBeNull();
});

test('Ctrl+N and /new use the canonical /clear behavior and preserve the previous session', async () => {
  const c = await setup(); await c.tui.submitPrompt('Previous session');
  const original = c.client.activeSession()!.id;
  await c.tui.handleKey('Ctrl+N'); expect(c.tui.getTranscript()).toHaveLength(0);
  expect(c.client.activeSession()).toBeNull(); expect(c.app.conversations.get(original)).toBeDefined();
  await c.tui.submitPrompt('Next session');
  expect(c.client.activeSession()!.id).not.toBe(original);
  await c.tui.executeSlashCommand('/new'); expect(c.client.activeSession()).toBeNull();
});

test('/login account management switches with explicit context-transfer confirmation', async () => {
  const c = await setup(); await c.tui.submitPrompt('Context to transfer');
  const original = c.client.activeSession()!.id;
  const second = await c.app.accounts.add('usage', 'second', {kind:'none'});
  await c.tui.executeSlashCommand('/login'); await c.tui.handleKey('Ctrl+A');
  await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter'); // second account
  await c.tui.handleKey('Enter'); // Switch account
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Your chat history');
  await c.tui.handleKey('Enter'); // Cancel is default.
  expect(c.client.activeSession()!.id).toBe(original);
  await c.tui.executeSlashCommand('/login'); await c.tui.handleKey('Ctrl+A');
  await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter'); await c.tui.handleKey('Enter');
  await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter');
  expect(c.client.activeSession()!.selection.accountId).toBe(second.id);
  expect(c.client.activeSession()!.messages[0]?.content).toBe('Context to transfer');
  expect(c.app.conversations.get(original)?.selection.accountId).toBe(c.account.id);
});

test('/switch confirms context transfer, creates a separate bound session, preserves source and revokes no accounts', async () => {
  const c = await setup(); await c.tui.submitPrompt('Preserve this context');
  const old = c.client.activeSession()!.id;
  const second = await c.app.accounts.add('usage', 'second', { kind: 'none' });
  await c.tui.executeSlashCommand('/switch 2');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Your chat history');
  await c.tui.handleKey('Enter'); // Cancel by default.
  expect(c.client.activeSession()!.id).toBe(old);
  await c.tui.executeSlashCommand('/switch second'); await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter');
  const fork = c.client.activeSession()!;
  expect(fork.id).not.toBe(old); expect(fork.selection.accountId).toBe(second.id);
  expect(fork.messages).toHaveLength(2); expect(c.client.usage().inputTokens).toBeNull();
  expect(c.app.conversations.get(old)?.selection.accountId).toBe(c.account.id);
  await c.tui.submitPrompt('Continue under second');
  expect(c.server.requests.filter(r => r.body).at(-1)!.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({content: 'Preserve this context'})]));
  expect(c.client.usage().reportedTurns).toBe(1);
  expect(c.app.accounts.get(c.account.id).status).not.toBe('logged-out');
  c.server.set({ status: 401 });
  await expect(c.client.switchAccount('first', true)).rejects.toBeInstanceOf(HannesError);
  expect(c.client.activeSession()!.id).toBe(fork.id);
});

test('SQLite v1 migration preserves conversations; cancelled/failed usage persists atomically; future schemas fail closed', async () => {
  const dir = directory(); const legacy = new Database(join(dir, 'provider-auth.sqlite'));
  legacy.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY, selection TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0); CREATE TABLE messages(conversation TEXT NOT NULL, revision INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(conversation,revision)); PRAGMA user_version=1');
  const legacyId = crypto.randomUUID(); const legacySelection = { accountId: crypto.randomUUID(), modelId: 'legacy-model' };
  legacy.query('INSERT INTO conversations VALUES(?,?,2)').run(legacyId, JSON.stringify(legacySelection));
  legacy.query('INSERT INTO messages VALUES(?,?,?,?,?)').run(legacyId, 1, 'user', 'Old question', 'committed');
  legacy.query('INSERT INTO messages VALUES(?,?,?,?,?)').run(legacyId, 2, 'assistant', 'Old answer', 'committed');
  legacy.close();
  const db = openPrivateDatabase(dir); cleanup.push(() => db.close());
  expect((db.query('PRAGMA user_version').get() as any).user_version).toBe(3);
  expect((db.query('PRAGMA table_info(messages)').all() as { name: string }[]).some(column => column.name === 'parts')).toBe(true); // v3 tool parts
  const store = new SqliteConversations(db);
  expect(store.get(legacyId)?.messages.map(message => message.content)).toEqual(['Old question', 'Old answer']);
  expect(store.get(legacyId)?.turns).toEqual([]);
  const selection = { accountId: crypto.randomUUID(), modelId: 'fixture-model' };
  for (const code of ['CANCELLED', 'TRANSPORT'] as const) {
    const model: ModelPort = { generate: async () => { throw new Error(); }, async *stream() {
      yield { type: 'started', requestId: crypto.randomUUID() };
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: null, costUSD: null } };
      throw new HannesError(code);
    } };
    const conv = new Conversation(selection, model, store);
    await expect((async () => { for await (const event of conv.send('Private prompt')) { if (event.type === 'usage') { expect(store.get(conv.id)?.turns?.[0]?.usage?.inputTokens).toBe(9); expect(store.get(conv.id)?.turns?.[0]?.outcome).toBe('pending'); } } })()).rejects.toMatchObject({code});
    const record = store.get(conv.id)!;
    expect(record.turns![0]!.outcome).toBe(code === 'CANCELLED' ? 'cancelled' : 'failed');
    expect(record.turns![0]!.usage?.inputTokens).toBe(9);
    expect(JSON.stringify(record.turns)).not.toContain('Private prompt');
    expect(record.messages[0]!.state).toBe('interrupted');
  }
  const future = directory(); const invalid = new Database(join(future, 'provider-auth.sqlite')); invalid.exec('PRAGMA user_version=4'); invalid.close();
  expect(() => openPrivateDatabase(future)).toThrow();
});

test('reasoning summaries use streaming redaction independently of answer text', async () => {
  const redactor = new Redactor(); redactor.register('fixture-private-secret');
  const model: ModelPort = { generate: async () => { throw new Error(); }, async *stream() {
    yield {type: 'reasoningDelta', text: 'Summary fixture-pri'};
    yield {type: 'textDelta', text: 'Answer'};
    yield {type: 'reasoningDelta', text: 'vate-secret'};
    yield {type: 'completed', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, costUSD: 0 }};
  } };
  const output = [];
  for await (const event of redactModel(model, redactor).stream({ requestId: crypto.randomUUID(), modelId: 'model', messages: [{role: 'user', content: 'Hi'}], maxOutputTokens: 100, tools: [] })) output.push(event);
  expect(JSON.stringify(output)).not.toContain('fixture-private-secret');
  expect(output.filter(e => e.type === 'reasoningDelta').map(e => e.text).join('')).toBe('Summary [REDACTED]');
});

test.skipIf(process.platform === 'win32')('actual PTY: usage/context/status paging, switch-and-continue, then explicit logout confirmation', async () => {
  const c = await setup(); await c.app.accounts.add('usage', 'second', {kind: 'none'});
  c.app.settings.update(settings => { const model = settings.catalogs[0]!.models[0]!; model.contextLimit = 128000; model.reasoningEfforts = ['low', 'high']; });
  let output = '';
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, data(_terminal, bytes) { output += Buffer.from(bytes).toString('utf8'); } });
  const child = Bun.spawn([process.execPath, 'apps/cli/src/index.ts', 'tui'], { terminal, env: { ...process.env, HANNES_HOME: c.dir, NO_COLOR: '1' } });
  const wait = async (text: string, from = 0) => { const until = Date.now() + 4000; while (!output.slice(from).includes(text) && Date.now() < until) await Bun.sleep(10); expect(output.slice(from)).toContain(text); };
  try {
    await wait('Trust this folder?'); terminal.write('\x1b[A\r');
    await wait('FUTRYN'); await wait('/ 128k tokens');
    let effortMark = output.length; terminal.write('/effort\r'); await wait('Reasoning effort', effortMark);
    effortMark = output.length; terminal.write('\x1b[C\x1b[C'); await wait('[ high ]', effortMark);
    terminal.write('\x1b'); await Bun.sleep(50);
    expect(c.app.settings.read().reasoningPreferences?.[c.account.id + ':fixture-model']).toBeUndefined();
    terminal.write('Hello terminal usage\r'); await wait('Hello fixture');
    await wait('Completed turn');
    const painted = [...output.matchAll(/\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)].map(match => ({row:Number(match[1]), text:match[2]!.replace(/\x1b\[[0-9;]*m/g,'')})).filter(line => line.text.includes('Hello fixture')).at(-1)!;
    const start = painted.text.indexOf('Hello fixture') + 1; const end = start + 12;
    let selectionMark = output.length;
    terminal.write(`\x1b[<0;${start};`); await Bun.sleep(5); terminal.write(`${painted.row}M`);
    terminal.write(`\x1b[<32;${end};${painted.row}M\x1b[<0;${end};${painted.row}m`);
    await wait('Ctrl+C Copy', selectionMark); expect(output.slice(selectionMark)).toContain('\x1b[7m');
    selectionMark = output.length; terminal.write('\x19'); await wait('\x1b]52;c;', selectionMark); await wait('\x07', selectionMark);
    const payload = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(output.slice(selectionMark))![1]!;
    expect(Buffer.from(payload,'base64').toString()).toBe('Hello fixture');
    expect(child.exitCode).toBeNull(); terminal.write('\x1b'); await Bun.sleep(50);
    for (const command of ['usage', 'context', 'status']) {
      const mark = output.length; terminal.write(`/${command}\r`); await wait(({usage:'Session usage', context:'Context window', status:'Session status'} as Record<string,string>)[command]!, mark);
      terminal.write('\x1b[6~'); await Bun.sleep(30); terminal.write('\x1b'); await Bun.sleep(30);
    }
    let mark = output.length; terminal.write('/switch 2\r'); await wait('Continue with second?', mark);
    terminal.write('\x1b[B\r'); await wait('Using second.', mark);
    mark = output.length; terminal.write('Continue terminal\r'); await wait('Hello fixture', mark);
    const requests = c.server.requests.filter(request => request.body);
    expect(JSON.stringify(requests.at(-1)!.body)).toContain('Hello terminal usage');
    mark = output.length; terminal.write('/logout second\r'); await wait('Sign out of second?', mark);
    expect(c.app.accounts.get('second').status).not.toBe('logged-out');
    terminal.write('\x1b[B\r'); await wait('Signed out of', mark);
    expect(() => c.app.accounts.get('second')).toThrow();
    expect(c.app.accounts.get('first').status).not.toBe('logged-out');
    terminal.write('\x03'); expect(await child.exited).toBe(0);
  } finally { child.kill('SIGKILL'); await child.exited; terminal.close(); }
}, 15000);

test('Responses HTTP transport forwards an advertised effort and streams the provider summary separately', async () => {
  const c = await setup();
  c.app.registry.add(c.server.provider('responses', { id: 'responses', auth: 'none' }));
  const account = await c.app.accounts.add('responses', 'reasoning', {kind: 'none'});
  await c.client.discoverModels({accountId: account.id});
  c.app.settings.update(settings => {
    const model = settings.catalogs.find(cache => cache.accountId === account.id)!.models[0]!;
    model.reasoningEfforts = ['low', 'high']; model.defaultReasoningEffort = 'low';
    model.pricing = { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' };
  });
  c.client.selectModel('fixture-model', {accountId: account.id}); c.client.setReasoningEffort('high');
  c.server.set({ reasoning: true, cacheTokens: 2 });
  const phases: string[] = []; const off = c.client.onReactiveEvent(event => phases.push(event.kind));
  try {
    await c.tui.submitPrompt('Show a supported summary');
    const request = c.server.requests.filter(request => request.body).at(-1)!;
    expect(request.body.reasoning.effort).toBe('high');
    expect(request.body.reasoning.summary).toBe('auto');
    expect(c.client.usage().last?.usage?.cacheReadTokens).toBe(2);
    expect(c.client.usage().costUSD).toBeNull(); // No cache price, no invented exact dollar cost.
    expect(c.tui.getTranscript().at(-1)!.reasoning).toBe('Provider HTTP summary');
    expect(c.tui.getTranscript().at(-1)!.content).toBe('Hello fixture');
    expect(phases).toEqual(expect.arrayContaining(['thinking', 'waiting', 'reasoning', 'streaming', 'done']));
    expect(c.tui.computeFrameSnapshot().plainText).toContain('Provider HTTP summary');
    await c.tui.handleKey('Ctrl+R'); expect(c.tui.computeFrameSnapshot().plainText).not.toContain('Provider HTTP summary');
    await c.tui.handleKey('Ctrl+R'); expect(c.tui.computeFrameSnapshot().plainText).toContain('Provider HTTP summary');
  } finally { off(); }
});

test('switching to an account with a different catalog asks for a model before changing the source session', async () => {
  const c = await setup(); await c.tui.submitPrompt('Keep the source');
  const source = c.client.activeSession()!.id;
  await c.app.accounts.add('usage', 'other', {kind: 'none'});
  c.server.set({modelName: 'other-model'});
  await c.tui.executeSlashCommand('/switch other'); await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter');
  expect(c.tui.getActiveOverlay()).toBe('models');
  expect(c.client.activeSession()!.id).toBe(source);
  expect(c.tui.computeFrameSnapshot().plainText).toContain('other-model');
  await c.tui.handleKey('Escape'); expect(c.client.activeSession()!.id).toBe(source);
  await c.tui.executeSlashCommand('/switch other'); await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter'); await c.tui.handleKey('Enter');
  expect(c.client.activeSession()!.selection.modelId).toBe('other-model');
  expect(c.client.activeSession()!.messages[0]!.content).toBe('Keep the source');
});

test('documented provider catalog metadata preserves limits and converts OpenRouter per-token prices once', async () => {
  const dir = directory(); const vault = memoryVault();
  const app = startup(dir, {vault, fetch: Object.assign(async () => Response.json({ data: [{id: 'provider/model', name: 'Model', context_length: 128000, top_provider: {max_completion_tokens: 4096}, pricing: {prompt: '0.000003', completion: '0.000007'}}] }), { preconnect: fetch.preconnect })});
  cleanup.push(() => app.db.close());
  app.registry.add({id:'openrouter', name:'OpenRouter', protocol:'chat', baseURL:'https://openrouter.ai/api/v1', catalog:'openai', auth:'none', metadataVersion:1, timeoutMs:1000});
  const account = await app.accounts.add('openrouter','catalog',{kind:'none'});
  const result = await app.discoverModels(account);
  expect(result.models[0]!.contextLimit).toBe(128000);
  expect(result.models[0]!.outputLimit).toBe(4096);
  expect(result.models[0]!.pricing).toEqual({inputPerMillion:3,outputPerMillion:7,currency:'USD'});
  expect(result.models[0]!.reasoningEfforts).toBeUndefined();
});

test('known output reserve over context capacity fails before a provider request; lower explicit reserve works', async () => {
  const c = await setup();
  c.app.settings.update(settings => {
    const model = settings.catalogs[0]!.models[0]!; model.contextLimit = 100; model.outputLimit = 100;
  });
  const before = c.server.requests.filter(request => request.body).length;
  await expect(send(c.client, 'Over limit')).rejects.toMatchObject({code:'CONTEXT_LIMIT'});
  expect(c.server.requests.filter(request => request.body)).toHaveLength(before);
  for await (const _event of c.client.sendMessage('Explicit reserve', {maxOutputTokens: 30})) { /* real request */ }
  expect(c.client.usage().last?.outcome).toBe('completed');
});

test('Esc and Ctrl+C abort an in-flight account discovery without transferring history or changing account', async () => {
  const c = await setup(); await c.tui.submitPrompt('Stay on source');
  const source = c.client.activeSession()!.id;
  await c.app.accounts.add('usage', 'slow-account', {kind:'none'}); c.server.set({delay:100});
  for (const cancel of ['Escape', 'Ctrl+C']) {
    await c.tui.executeSlashCommand('/switch slow-account'); await c.tui.handleKey('ArrowDown');
    const operation = c.tui.handleKey('Enter');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('Switching account');
    await c.tui.handleKey(cancel); await operation;
    expect(c.tui.getActiveOverlay()).toBe('none');
    expect(c.client.activeSession()!.id).toBe(source);
    expect(c.client.status().activeAccount?.id).toBe(c.account.id);
    expect(c.app.conversations.list()).toHaveLength(1);
  }
});

test('reports start as short summaries and D reveals technical detail without changing session data', async () => {
  const c = await setup(); await c.tui.submitPrompt('Readable report');
  const session = c.client.activeSession()!.id;
  for (const command of ['usage', 'context', 'status'] as const) {
    const summary = reportRows(c.client, command);
    expect(summary.length).toBeLessThanOrEqual(12);
    expect(summary.join(' ')).not.toContain('BACKEND CAPABILITIES');
    expect(summary.join(' ')).not.toContain('UTF-8');
    c.tui.resize(100, 36);
    await c.tui.executeSlashCommand('/' + command);
    const initial = c.tui.computeFrameSnapshot().plainText;
    expect(initial).toContain('D Details');
    expect(initial).not.toContain('Completed turn'); // No stale banner behind the modal.
    await c.tui.handleKey('d');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('D Summary');
    expect(c.tui.computeFrameSnapshot().plainText).not.toBe(initial);
    await c.tui.handleKey('D');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('D Details');
    expect(c.client.activeSession()!.id).toBe(session);
    await c.tui.handleKey('Escape');
  }
});

test('dragging chat text highlights and copies rendered content without exiting or changing the draft', async () => {
  const c = await setup(); await c.tui.submitPrompt('Select the reply');
  const frame = c.tui.computeFrameSnapshot(); const row = frame.plainLines.findIndex(line => line.includes('Hello fixture')); const col = frame.plainLines[row]!.indexOf('Hello fixture');
  for (const key of parseMouse(row,col,row,col + 12)) await c.tui.handleKey(key);
  expect(c.tui.selectedText()).toBe('Hello fixture');
  expect(c.tui.computeFrameSnapshot().cells[row]![col]!.selected).toBe(true);
  await c.tui.handleKey('Ctrl+C');
  const clipboard = c.tui.takeClipboardSequence();
  expect(Buffer.from(clipboard.slice(7,-1),'base64').toString()).toBe('Hello fixture');
  expect(c.tui.takeClipboardSequence()).toBe(''); expect(c.tui.isExitRequested()).toBe(false);
  await c.tui.handleKey('Escape'); expect(c.tui.selectedText()).toBe('');
  expect(c.tui.getComposerState().value).toBe('');
  for (const key of parseMouse(row,col,row,col + 12)) await c.tui.handleKey(key);
  c.tui.resize(50,18); expect(c.tui.selectedText()).toBe('');
});
function parseMouse(row: number, col: number, endRow: number, endCol: number) {
  return [`MouseDown:${row}:${col}`, `MouseDrag:${endRow}:${endCol}`, `MouseUp:${endRow}:${endCol}`];
}

test('selection is stable while the provider streams, then Esc restores the updated live view', async () => {
  const c = await setup(); await c.tui.submitPrompt('First reply');
  c.server.set({streamDelay:100}); const turn = c.tui.submitPrompt('Streaming reply');
  const frame = c.tui.computeFrameSnapshot(); const row = frame.plainLines.findIndex(line => line.includes('Hello fixture')); const col = frame.plainLines[row]!.indexOf('Hello fixture');
  for (const key of parseMouse(row,col,row,col + 12)) await c.tui.handleKey(key);
  const frozen = c.tui.computeFrameSnapshot().plainText;
  c.tui.stepAnimation(0.8); await turn;
  expect(c.tui.computeFrameSnapshot().plainText).toBe(frozen);
  expect(c.tui.getTranscript().at(-1)!.content).toBe('Hello fixture');
  await c.tui.handleKey('Escape');
  expect(c.tui.computeFrameSnapshot().plainText).not.toBe(frozen);
});

test('choosing the active account is a no-op and switching A→B→A still works', async () => {
  const c = await setup(); await c.tui.submitPrompt('Original context'); const original = c.client.activeSession()!.id;
  const requests = c.server.requests.length;
  c.client.useAccount(c.account.id); await c.client.switchAccount(c.account.id, true);
  await c.tui.executeSlashCommand('/switch first');
  expect(c.tui.getActiveOverlay()).toBe('none'); expect(c.tui.getStatusBanner()).toContain('Already using');
  expect(c.client.activeSession()!.id).toBe(original); expect(c.server.requests).toHaveLength(requests);
  const second = await c.app.accounts.add('usage','second',{kind:'none'});
  await c.client.switchAccount('second',true); await send(c.client,'Second account');
  await c.client.switchAccount('first',true); expect(c.client.status().activeAccount?.id).toBe(c.account.id);
  await send(c.client,'Back to first'); await c.client.switchAccount('second',true);
  expect(c.client.status().activeAccount?.id).toBe(second.id);
  expect(c.client.activeSession()!.messages.some(message => message.content === 'Back to first')).toBe(true);
  const selected = c.client.activeSession()!.id;
  await c.tui.executeSlashCommand('/switch');
  // The active row is visible but cannot be reactivated; another account is selected.
  await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  expect(c.client.activeSession()!.id).toBe(selected); // Confirmation precedes an actual switch.
  await c.tui.handleKey('Escape');
});

test('context window is visible before the first message and after model selection, without abbreviated ctx', async () => {
  const c = await setup();
  c.app.settings.update(settings => { settings.catalogs[0]!.models[0]!.contextLimit = 128000; });
  const welcome = c.tui.computeFrameSnapshot().plainText;
  expect(welcome).toContain('Context  ~0 / 128k tokens');
  expect(welcome).not.toContain('ctx ');
  await c.tui.executeSlashCommand('/model');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Max context 128,000');
  await c.tui.handleKey('Enter');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('/ 128k tokens');
  await c.tui.submitPrompt('Context visibility');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('/ 128k tokens');
  for (const width of [30, 54, 80, 120]) {
    c.tui.resize(width, 24);
    const snapshot = c.tui.computeFrameSnapshot();
    expect(snapshot.plainText).toContain('Context');
    expect(snapshot.plainText).toContain('128k');
    expect(snapshot.plainLines.every(line => line.length <= width)).toBe(true);
  }
  c.app.settings.update(settings => { settings.catalogs[0]!.models[0]!.contextLimit = null; });
  c.tui.resize(80, 24);
  expect(c.tui.computeFrameSnapshot().plainText).toContain('not reported');
});

test('/effort follows Claude command naming with staged keyboard selection, auto and compatibility alias', async () => {
  const c = await setup();
  expect(parseSlashCommand('/model effort high').definition?.command).toBe('/effort');
  expect(getMatchingSlashCommands('/eff')[0]?.command).toBe('/effort');
  await c.tui.executeSlashCommand('/effort');
  expect(c.tui.getStatusBanner()).toContain('not advertised');
  c.app.settings.update(settings => {
    const model = settings.catalogs[0]!.models[0]!;
    model.reasoningEfforts = ['low', 'high']; model.defaultReasoningEffort = 'low';
  });
  await c.tui.executeSlashCommand('/effort');
  expect(c.tui.getActiveOverlay()).toBe('effort');
  await c.tui.handleKey('ArrowRight');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('[ high ]');
  expect(c.client.status().reasoningEffort).toBe('low');
  await c.tui.handleKey('Escape');
  expect(c.client.status().reasoningEffort).toBe('low');
  await c.tui.executeSlashCommand('/effort'); await c.tui.handleKey('ArrowRight'); await c.tui.handleKey('Enter');
  expect(c.client.status().reasoningEffort).toBe('high');
  await c.tui.executeSlashCommand('/effort auto');
  expect(c.client.status().reasoningEffort).toBe('low');
  await c.tui.executeSlashCommand('/model'); await c.tui.handleKey('ArrowRight');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Effort: high');
  await c.tui.handleKey('Escape'); expect(c.client.status().reasoningEffort).toBe('low');
  await c.tui.executeSlashCommand('/model'); await c.tui.handleKey('ArrowRight'); await c.tui.handleKey('Enter');
  expect(c.client.status().reasoningEffort).toBe('high');
  await c.tui.executeSlashCommand('/effort status'); expect(c.tui.getStatusBanner()).toContain('high');
  await c.tui.executeSlashCommand('/effort ultracode'); expect(c.client.status().reasoningEffort).toBe('high');
  expect(c.tui.getStatusBanner()).toContain('not supported');
});

test('context estimates include streamed answer text and state changes invalidate model/session telemetry', async () => {
  const c = await setup(); c.server.set({streamDelay: 80});
  c.app.settings.update(settings => { const model = settings.catalogs[0]!.models[0]!; model.contextLimit = 32000; });
  const observations: {phase: string; estimate: number; model: string | undefined; input: number | null}[] = [];
  const off = c.client.onReactiveEvent(event => observations.push({phase: event.kind, estimate: c.client.context().estimateTokens, model: c.client.status().selection?.modelId, input: c.client.status().lastUsage?.inputTokens ?? null}));
  try {
    const turn = c.tui.submitPrompt('Keep context current');
    const deadline = Date.now() + 2000;
    while (!c.tui.getTranscript().at(-1)?.content && Date.now() < deadline) await Bun.sleep(5);
    expect(c.tui.getTranscript().at(-1)?.streaming).toBe(true);
    expect(observations.find(item => item.phase === 'streaming')!.estimate).toBeGreaterThan(observations.find(item => item.phase === 'waiting')!.estimate);
    expect(() => c.client.selectModel('fixture-model')).toThrow();
    expect(() => c.client.setReasoningEffort('high')).toThrow();
    await turn;
    expect(c.client.status().lastUsage?.inputTokens).toBe(4);
    c.client.addManualModel('new-model');
    c.app.settings.update(settings => { settings.catalogs[0]!.models.find(model => model.id === 'new-model')!.contextLimit = 128000; });
    c.client.selectModel('new-model');
    expect(observations.at(-1)?.model).toBe('new-model'); expect(observations.at(-1)?.input).toBeNull();
    expect(c.client.status().phase).toBe('idle'); expect(c.client.context().limitTokens).toBe(128000);
    expect(c.client.context().estimateTokens).toBe(0);
    await c.tui.executeSlashCommand('/model new-model');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('128k tokens');
    c.client.createSession(); c.client.clearSessionView();
    expect(observations.at(-1)?.estimate).toBe(0);
  } finally { off(); }
});

test('thinking arrives incrementally before the answer and an explicit collapse survives subsequent deltas', async () => {
  const c = await setup();
  c.app.registry.add(c.server.provider('responses', {id:'thinking-stream', auth:'none'}));
  const account = await c.app.accounts.add('thinking-stream', 'thinking-stream', {kind:'none'});
  await c.client.discoverModels({accountId:account.id}); c.client.selectModel('fixture-model', {accountId:account.id});
  c.server.set({reasoning:true, streamDelay: 60});
  const task = c.tui.submitPrompt('Stream thinking');
  const deadline = Date.now() + 2500;
  while (!c.tui.getTranscript().at(-1)?.reasoning && Date.now() < deadline) await Bun.sleep(5);
  expect(c.tui.getTranscript().at(-1)?.reasoning).toBe('Provider HTTP ');
  expect(c.tui.getTranscript().at(-1)?.content).toBe('');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Provider HTTP');
  await c.tui.handleKey('Ctrl+R');
  await task;
  expect(c.tui.getTranscript().at(-1)?.reasoning).toBe('Provider HTTP summary');
  expect(c.tui.getTranscript().at(-1)?.reasoningExpanded).toBe(false);
  expect(c.tui.getTranscript().at(-1)?.content).toBe('Hello fixture');
  await c.tui.handleKey('Ctrl+R');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Provider HTTP summary');
});

test.skipIf(process.platform === 'win32')('actual PTY streams thinking before the answer and refreshes context on a model change', async () => {
  const c = await setup();
  c.app.registry.add(c.server.provider('responses', {id:'terminal-thinking', auth:'none', timeoutMs:5000}));
  const account = await c.app.accounts.add('terminal-thinking', 'terminal-thinking', {kind:'none'});
  await c.client.discoverModels({accountId:account.id}); c.client.selectModel('fixture-model', {accountId:account.id});
  c.client.addManualModel('alternate-model');
  c.app.settings.update(settings => { const catalog = settings.catalogs.find(cache => cache.accountId === account.id)!; catalog.models[0]!.contextLimit = 128000; catalog.models.find(model => model.id === 'alternate-model')!.contextLimit = 64000; });
  c.server.set({reasoning:true, streamDelay: 80});
  let output = '';
  const terminal = new Bun.Terminal({cols:100, rows:30, data(_terminal, bytes) { output += Buffer.from(bytes).toString('utf8'); }});
  const child = Bun.spawn([process.execPath, 'apps/cli/src/index.ts', 'tui'], {terminal, env:{...process.env, HANNES_HOME:c.dir, NO_COLOR:'1'}});
  const wait = async (text: string, from = 0) => { const deadline = Date.now() + 4000; while (!output.slice(from).includes(text) && Date.now() < deadline) await Bun.sleep(5); expect(output.slice(from)).toContain(text); };
  try {
    await wait('Trust this folder?'); terminal.write('\x1b[A\r');
    await wait('/ 128k tokens'); terminal.write('Stream reasoning and answer\r');
    await wait('Provider HTTP'); expect(output).not.toContain('Hello fixture');
    await wait('Hello fixture'); await wait('Completed turn');
    const mark = output.length; terminal.write('/model alternate-model\r');
    await wait('/ 64k tokens', mark); await wait('Context  ~0', mark);
    terminal.write('\x03'); expect(await child.exited).toBe(0);
  } finally { child.kill('SIGKILL'); await child.exited; terminal.close(); }
}, 15000);

test('signed-out switch target offers sign-in for the same profile and preserves source history', async () => {
  const c = await setup(); await send(c.client, 'Keep this history');
  const second = await c.app.accounts.add('usage', 'expired', {kind: 'none'});
  await c.app.accounts.logout(second.id);
  const session = c.client.activeSession()!.id;
  await c.tui.executeSlashCommand('/switch expired');
  await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter');
  expect(c.tui.computeFrameSnapshot().plainLines.join('\n')).toContain('Sign in to expired');
  expect(c.client.activeSession()!.id).toBe(session);
  expect(c.client.status().activeAccount?.id).toBe(c.account.id);
  const restored = await c.client.connectAccount({providerId: 'usage', alias: 'expired', credential: {kind: 'none'}, reauthenticateAccountId: second.id});
  expect(restored.id).toBe(second.id);
  expect(c.client.activeSession()!.id).toBe(session);
  await c.client.switchAccount(second.id, true);
  expect(c.client.activeSession()!.selection.accountId).toBe(second.id);
  expect(c.client.activeSession()!.messages.length).toBe(2);
});

test('ChatGPT profiles reject the same account identity even with refreshed tokens', async () => {
  const c = await setup();
  c.app.registry.add(providerPresets.find(p => p.id === 'chatgpt')!);
  const records = new Map<string, string>();
  c.vault.getRuntime = async ref => records.get(ref.key);
  const ref = () => ({kind: 'runtime' as const, runtime: 'codex' as const, key: crypto.randomUUID()});
  const first = ref(), duplicate = ref(), other = ref();
  for (const [credential, id, token] of [[first, 'same', 'old'], [duplicate, 'same', 'new'], [other, 'different', 'other']] as const) {
    records.set(credential.key, JSON.stringify({version: 1, files: {'auth.json': JSON.stringify({tokens: {account_id: id, access_token: token}})}}));
  }
  const account = await c.app.accounts.add('chatgpt', 'chat-one', first);
  await expect(c.app.accounts.add('chatgpt', 'chat-duplicate', duplicate)).rejects.toThrow(HannesError);
  const distinct = await c.app.accounts.add('chatgpt', 'chat-two', other);
  await expect(c.app.accounts.reauthenticate(distinct.id, duplicate)).rejects.toThrow(HannesError);
  expect(c.app.accounts.get(distinct.id).status).toBe('unvalidated');
  await c.app.accounts.reauthenticate(account.id, duplicate);
  expect(c.app.accounts.get(account.id).credential).toEqual(duplicate);
});

test('late account discovery cannot overwrite a newer explicit selection', async () => {
  const c = await setup(); await send(c.client, 'Source history');
  const second = await c.app.accounts.add('usage', 'target', {kind: 'none'});
  const third = await c.app.accounts.add('usage', 'newer', {kind: 'none'});
  c.server.set({delay: 100});
  const switching = c.client.switchAccount(second.id, true);
  const outcome = switching.then(() => null, error => error);
  c.client.useAccount(third.id);
  expect(await outcome).toMatchObject({code: 'POLICY'});
  expect(c.client.status().activeAccount?.id).toBe(third.id);
  expect(c.app.conversations.list()).toHaveLength(1);
});

test('closing discovery and reopening the model picker ignores the old result', async () => {
  const c = await setup(); c.server.set({delay: 100});
  await c.tui.executeSlashCommand('/model');
  const refresh = c.tui.handleKey('Ctrl+R');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Discovering models');
  await c.tui.handleKey('Escape');
  await c.tui.executeSlashCommand('/model');
  await refresh;
  const text = c.tui.computeFrameSnapshot().plainText;
  expect(text).not.toContain('Discovered 1 models');
  expect(text).not.toContain('Model discovery failed');
  expect(text).not.toContain('undefined');
  expect(c.client.status().activeAccount?.id).toBe(c.account.id);
});

for (const fallback of ['available', 'retired-model', 'rejected', 'cancelled'] as const) test(`logout active account: ${fallback} fallback is coherent and never transfers chat history`, async () => {
  const c = await setup(); await send(c.client, 'Private source history');
  const source = c.client.activeSession()!.id;
  const second = await c.app.accounts.add('usage', 'fallback', {kind: 'none'});
  if (fallback === 'retired-model') c.app.settings.update(s => { s.accounts.find(a => a.id === second.id)!.defaultModel = 'retired'; });
  if (fallback === 'rejected') c.server.set({status: 401});
  if (fallback === 'cancelled') c.server.set({delay: 200});
  await c.tui.executeSlashCommand('/logout first');
  await c.tui.handleKey('ArrowDown');
  const logout = c.tui.handleKey('Enter');
  if (fallback === 'cancelled') { await Bun.sleep(20); await c.tui.handleKey('Escape'); }
  await logout;
  expect(c.app.conversations.get(source)?.messages).toHaveLength(2);
  expect(c.client.activeSession()).toBeNull();
  if (fallback === 'available' || fallback === 'retired-model') {
    expect(c.client.status().selection).toEqual({accountId: second.id, modelId: 'fixture-model'});
    await send(c.client, 'New account hello');
    expect(JSON.stringify(c.server.requests.filter(r => r.body).at(-1)!.body)).not.toContain('Private source history');
  } else {
    expect(c.client.status().activeAccount).toBeNull();
    expect(c.client.status().selection).toBeNull();
  }
});

test('logout of an inactive account preserves the current model and conversation', async () => {
  const c = await setup(); await send(c.client, 'Keep current chat');
  await c.app.accounts.add('usage', 'inactive', {kind: 'none'});
  const session = c.client.activeSession()!.id;
  await c.tui.executeSlashCommand('/logout inactive');
  await c.tui.handleKey('ArrowDown'); await c.tui.handleKey('Enter');
  expect(c.client.activeSession()!.id).toBe(session);
  expect(c.client.status().activeAccount?.id).toBe(c.account.id);
});

test('cancelled reconnect of the current account clears the unusable selection but retains durable history', async () => {
  const c = await setup(); await send(c.client, 'Retain on disk');
  const session = c.client.activeSession()!.id;
  c.server.set({delay: 150}); const abort = new AbortController();
  const reconnect = c.client.connectAccount({providerId: 'usage', alias: 'first', credential: {kind: 'none'}, reauthenticateAccountId: c.account.id}, abort.signal).then(() => null, error => error);
  await Bun.sleep(20); abort.abort();
  expect(await reconnect).toMatchObject({code: 'CANCELLED'});
  expect(c.client.status().activeAccount).toBeNull();
  expect(c.client.status().selection).toBeNull();
  expect(c.client.activeSession()).toBeNull();
  expect(c.app.conversations.get(session)?.messages).toHaveLength(2);
});
