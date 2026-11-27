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
  expect(btwReq.body.stream).toBe(true);
  expect(JSON.stringify(btwReq.body.messages)).toContain('Remember the codename is ORION.');
  expect(JSON.stringify(btwReq.body.messages)).toContain('What was the codename?');
});

test('/btw works on SSE-only gateways after tool calls and includes tool output without empty assistant chains', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cosmew-btw-sse-state-'));
  const workspace = mkdtempSync(join(tmpdir(), 'cosmew-btw-sse-ws-'));
  const seenBodies: Record<string, unknown>[] = [];
  const sseOnlyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === 'GET') return Response.json({data: [{id: 'sse-model', supports_tools: true}]});
    const body = (await req.json()) as Record<string, unknown>;
    seenBodies.push(body);
    // Simulate a strict SSE-only gateway (like 9Router) that ALWAYS responds with text/event-stream.
    const sse = [
      `data: ${JSON.stringify({id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {content: 'Use bun run typecheck'}, finish_reason: null}]})}`,
      `data: ${JSON.stringify({id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 20, completion_tokens: 8, total_tokens: 28}})}`,
      'data: [DONE]',
      '',
    ].join('\n\n');
    return new Response(sse, {status: 200, headers: {'content-type': 'text/event-stream'}});
  }) as typeof fetch;

  const app = startup(stateDir, {
    vault: memoryVault(),
    offline: true,
    fetch: sseOnlyFetch,
    skillsHome: stateDir,
    memoriesHome: stateDir,
  });
  cleanups.push(() => {
    app.db.close();
    rmSync(stateDir, {recursive: true, force: true});
    rmSync(workspace, {recursive: true, force: true});
  });
  app.registry.add({
    id: 'sse-gw',
    name: 'SSE Gateway',
    baseURL: 'https://sse-gw.example/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
  });
  const account = await app.accounts.add('sse-gw', 'sse', {kind: 'none'});
  const client = app.createFutrynClient(workspace);
  client.useAccount(account.id);
  await client.discoverModels();
  client.selectModel('sse-model');
  client.setToolsEnabled(true);

  await Array.fromAsync(client.sendMessage('Read package.json'));
  const sessionId = client.activeSession()!.id;
  // Append realistic tool-call & tool-result messages (empty assistant tool-call turns + package.json output).
  app.conversations.append(
    sessionId,
    {role: 'assistant', content: '', toolCalls: [{id: 't1', name: 'read', input: {path: 'package.json'}}]},
    'committed',
  );
  app.conversations.append(
    sessionId,
    {role: 'tool', toolCallId: 't1', toolName: 'read', content: '{"scripts":{"typecheck":"tsc --noEmit"}}'},
    'committed',
  );
  app.conversations.append(
    sessionId,
    {role: 'assistant', content: '', toolCalls: [{id: 't2', name: 'memory', input: {action: 'write'}}]},
    'committed',
  );
  app.conversations.append(
    sessionId,
    {role: 'tool', toolCallId: 't2', toolName: 'memory', content: 'Memory edit denied by policy.'},
    'committed',
  );
  app.conversations.append(sessionId, {role: 'assistant', content: 'Bun version is 1.4.4.'}, 'committed');
  client.resumeSession(sessionId);

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
  await routeCommand(host, '/btw lệnh chạy typecheck trong dự án này là gì?');
  expect(notices.at(-1)).toBe('Use bun run typecheck');
  const btwBody = seenBodies.at(-1)!;
  expect(btwBody.stream).toBe(true);
  const btwMessages = btwBody.messages as Array<{role: string; content: string}>;
  // Context is compacted into a single user reference message containing the read tool result, with no empty assistant placeholders.
  expect(btwMessages.filter(m => m.role === 'assistant')).toHaveLength(0);
  expect(JSON.stringify(btwMessages)).toContain('tsc --noEmit');
  expect(JSON.stringify(btwMessages)).not.toContain('(empty)');
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
