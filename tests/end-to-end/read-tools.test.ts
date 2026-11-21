import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openInk} from '../../apps/tui/src/ink/testing/ink-session';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function make(toolCall: {name: string; args: string}, consent = true) {
  const home = mkdtempSync(join(tmpdir(), 'futryn-tools-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'futryn-tools-ws-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(ws, {recursive: true, force: true}),
  );
  writeFileSync(join(ws, 'notes.txt'), 'the launch code is banana\n');
  writeFileSync(join(ws, '.env'), 'API_TOKEN=very-secret-value\n');
  const server = fixtureServer();
  server.set({toolCall});
  cleanup.push(() => server.server.stop(true));
  const app = startup(home, {vault: memoryVault(), skillsHome: home, memoriesHome: home});
  cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', {id: 'tooly', auth: 'none'}));
  await app.accounts.add('tooly', 'main', {kind: 'none'});
  const client = app.createFutrynClient(ws);
  await client.discoverModels();
  client.selectModel('fixture-model');
  const tui = await openInk(client, {width: 100, consent});
  cleanup.push(() => tui.shutdown());
  return {app, client, tui, server, ws};
}
const toolRequests = (s: ReturnType<typeof fixtureServer>) =>
  s.requests.filter(r => Array.isArray(r.body?.tools) && r.body.tools.length);

test('no tools are offered before folder consent', async () => {
  const c = await make({name: 'read', args: '{"path":"notes.txt"}'}, false);
  // The startup gate owns the screen: nothing is sent and no tool is offered until consent + verification.
  expect(c.tui.frame()).toContain('Accessing workspace:');
  expect(c.client.toolsEnabled()).toBe(false);
  expect(toolRequests(c.server)).toHaveLength(0);
  const before = c.server.requests.length;
  await c.tui.press('\x1b');
  expect(c.server.requests).toHaveLength(before);
  expect(toolRequests(c.server)).toHaveLength(0);
});

test('model reads a workspace file through the tool loop; result returns to the model and is stored', async () => {
  const c = await make({name: 'read', args: '{"path":"notes.txt"}'});
  expect(c.client.toolsEnabled()).toBe(true); // set by the folder-consent dialog
  expect(c.client.skills().skills.every(s => s.source === 'system')).toBe(true);
  await c.tui.submitPrompt('what is in notes?');
  expect(JSON.stringify(toolRequests(c.server).map(r => r.body))).not.toContain('Available skills (untrusted metadata');
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.content).toContain('banana'); // the model saw the tool result
  expect(answer.toolCalls?.[0]?.name).toBe('read');
  expect(answer.toolResults?.[0]?.status).toBe('ok');
  expect(c.tui.frame()).toContain('Read 1 file');
  expect(
    toolRequests(c.server)
      .map(r => r.body.tools.map((t: any) => t.function.name))
      .at(0),
  ).toEqual([
    'read',
    'glob',
    'grep',
    'memory',
    'tool_output',
    'apply_patch',
    'edit',
    'write',
    'update_plan',
    'request_user_input',
    'web_search',
    'web_fetch',
    'agent',
  ]);
  // Resume: the stored turn keeps the tool call and result, and the transcript folds them into one card.
  const resumed = c.app.createFutrynClient(c.ws);
  resumed.resumeSession(c.client.activeSession()!.id);
  const tui = await openInk(resumed, {width: 100});
  cleanup.push(() => tui.shutdown());
  expect(tui.getTranscript().map(item => item.role)).toEqual(['user', 'assistant']);
  expect(tui.getTranscript()[1]!.toolResults?.[0]?.callId).toBe(answer.toolCalls![0]!.id);
  const rows = c.app.db.query('SELECT phase FROM tool_audit ORDER BY rowid').all() as {phase: string}[];
  expect(rows.map(r => r.phase)).toEqual(['requested', 'decided', 'completed']);
});

test('reading .env opens the permission dialog; Esc denies and the secret never reaches the model', async () => {
  const c = await make({name: 'read', args: '{"path":".env"}'});
  await c.tui.submitPrompt('show env');
  await c.tui.nextPermission();
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  for (const label of ['1. Yes', '2. Yes, and', '3. Yes, and save this rule in project settings'])
    expect(c.tui.frame()).toContain(label);
  expect(c.tui.frame()).toContain('Read file');
  expect(c.tui.frame()).not.toContain('Type to filter');
  expect(c.tui.frame()).not.toContain('4/4');
  expect(c.tui.frame()).toContain('4. No');
  expect(c.tui.frame()).toContain('Esc to cancel · Tab to amend');
  expect(c.tui.frame()).toContain('.env');
  await c.tui.handleKey('Escape');
  await c.tui.idle();
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.toolResults?.[0]).toMatchObject({status: 'denied', code: 'DENIED'});
  expect(JSON.stringify(c.server.requests)).not.toContain('very-secret-value');
  expect(c.tui.frame()).not.toContain('Esc to cancel · Tab to amend');
});

test('"Allow for session" reads the secret once approved and is remembered until revoked', async () => {
  const c = await make({name: 'read', args: '{"path":".env"}'});
  await c.tui.submitPrompt('show env');
  await c.tui.nextPermission();
  await c.tui.handleKey('2');
  await c.tui.idle();
  expect(c.tui.getTranscript().at(-1)!.content).toContain('very-secret-value');
  expect(c.client.listToolGrants()).toEqual(['.env']);
  await c.tui.submitPrompt('again'); // no second prompt
  expect(c.client.listPermissions().filter(p => p.status === 'pending')).toHaveLength(0);
  await c.tui.executeSlashCommand('/permissions');
  for (let tab = 0; tab < 3; tab++) await c.tui.handleKey('ArrowRight'); // Allow -> Ask -> Deny -> Mode
  expect(c.tui.frame()).toContain('session grants 1');
  await c.tui.handleKey('Ctrl+X');
  expect(c.client.listToolGrants()).toEqual([]);
  expect(c.tui.frame()).toContain('session grants 0');
  await c.tui.handleKey('Escape');
});

test('paths outside the workspace are denied without a prompt or any outside path in the reply', async () => {
  const c = await make({name: 'read', args: '{"path":"../../etc/passwd"}'});
  await c.tui.submitPrompt('read passwd');
  const result = c.tui.getTranscript().at(-1)!.toolResults?.[0];
  expect(result).toMatchObject({status: 'denied', code: 'DENIED'});
  expect(c.client.listPermissions()).toHaveLength(0);
  expect(JSON.stringify(c.server.requests)).not.toContain('root:');
});

test('a provider that rejects tools marks the model unsupported and the next turn chats without tools', async () => {
  const c = await make({name: 'read', args: '{"path":"notes.txt"}'});
  c.server.set({status: 400});
  await c.tui.submitPrompt('hello');
  expect(c.tui.frame()).toContain('does not accept workspace tools');
  expect(c.client.status().activeModel?.capabilities.tools).toBe('unsupported');
  c.server.set({status: 200, toolCall: null});
  const before = c.server.requests.length;
  await c.tui.submitPrompt('hello again');
  expect(c.server.requests.slice(before).every(r => !r.body?.tools?.length)).toBe(true);
  expect(c.tui.getTranscript().at(-1)!.content).toContain('Hello fixture');
});
