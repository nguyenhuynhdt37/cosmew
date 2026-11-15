import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FutrynTuiApp } from '@hannes/tui';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { fixtureServer, memoryVault } from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function make(toolCall: { name: string; args: string }) {
  const home = mkdtempSync(join(tmpdir(), 'futryn-tools-home-')); const ws = mkdtempSync(join(tmpdir(), 'futryn-tools-ws-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(join(ws, 'notes.txt'), 'the launch code is banana\n');
  writeFileSync(join(ws, '.env'), 'API_TOKEN=very-secret-value\n');
  const server = fixtureServer(); server.set({ toolCall }); cleanup.push(() => server.server.stop(true));
  const app = startup(home, { vault: memoryVault() }); cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', { id: 'tooly', auth: 'none' }));
  await app.accounts.add('tooly', 'main', { kind: 'none' });
  const client = app.createFutrynClient(ws); await client.discoverModels(); client.selectModel('fixture-model');
  const tui = new FutrynTuiApp({ client, cols: 100, rows: 30 }); await tui.initialize(); cleanup.push(() => tui.shutdown());
  return { app, client, tui, server, ws };
}
const toolRequests = (s: ReturnType<typeof fixtureServer>) => s.requests.filter(r => Array.isArray(r.body?.tools) && r.body.tools.length);
async function until(fn: () => boolean) { const end = Date.now() + 4000; while (!fn() && Date.now() < end) await Bun.sleep(10); expect(fn()).toBe(true); }

test('no tools are offered before folder consent', async () => {
  const c = await make({ name: 'read', args: '{"path":"notes.txt"}' });
  await c.tui.submitPrompt('what is in notes?');
  expect(toolRequests(c.server)).toHaveLength(0);
});

test('model reads a workspace file through the tool loop; result returns to the model and is stored', async () => {
  const c = await make({ name: 'read', args: '{"path":"notes.txt"}' });
  c.client.setToolsEnabled(true); // what folder consent does in the TUI
  await c.tui.submitPrompt('what is in notes?');
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.content).toContain('banana');                       // the model saw the tool result
  expect(answer.toolCalls?.[0]?.name).toBe('read');
  expect(answer.toolResults?.[0]?.status).toBe('ok');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('• Explored');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('└ Read notes.txt');
  expect(toolRequests(c.server).map(r => r.body.tools.map((t: any) => t.function.name)).at(0)).toEqual(['read', 'glob', 'grep']);
  // Resume: the stored turn keeps the tool call and result, and the transcript folds them into one card.
  const resumed = c.app.createFutrynClient(c.ws); resumed.resumeSession(c.client.activeSession()!.id);
  const tui = new FutrynTuiApp({ client: resumed, cols: 100, rows: 30 }); await tui.initialize(); cleanup.push(() => tui.shutdown());
  expect(tui.getTranscript().map(item => item.role)).toEqual(['user', 'assistant']);
  expect(tui.getTranscript()[1]!.toolResults?.[0]?.callId).toBe(answer.toolCalls![0]!.id);
  const rows = c.app.db.query("SELECT phase FROM tool_audit ORDER BY rowid").all() as { phase: string }[];
  expect(rows.map(r => r.phase)).toEqual(['requested', 'decided', 'completed']);
});

test('reading .env opens the permission dialog; Esc denies and the secret never reaches the model', async () => {
  const c = await make({ name: 'read', args: '{"path":".env"}' });
  c.client.setToolsEnabled(true);
  const turn = c.tui.submitPrompt('show env');
  await until(() => c.client.listPendingPermissions().length === 1);
  c.tui.advanceStartupGate(); // the per-frame hook that surfaces pending approvals
  expect(c.tui.getActiveOverlay()).toBe('permissions');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('.env');
  await c.tui.handleKey('Escape');
  await turn;
  const answer = c.tui.getTranscript().at(-1)!;
  expect(answer.toolResults?.[0]).toMatchObject({ status: 'denied', code: 'DENIED' });
  expect(JSON.stringify(c.server.requests)).not.toContain('very-secret-value');
  expect(c.tui.getActiveOverlay()).toBe('none');
});

test('"Allow for session" reads the secret once approved and is remembered until revoked', async () => {
  const c = await make({ name: 'read', args: '{"path":".env"}' });
  c.client.setToolsEnabled(true);
  const first = c.tui.submitPrompt('show env');
  await until(() => c.client.listPendingPermissions().length === 1);
  c.tui.advanceStartupGate(); await c.tui.handleKey('2');
  await first;
  expect(c.tui.getTranscript().at(-1)!.content).toContain('very-secret-value');
  expect(c.client.listToolGrants()).toEqual(['.env']);
  await c.tui.submitPrompt('again'); // no second prompt
  expect(c.client.listPermissions().filter(p => p.status === 'pending')).toHaveLength(0);
  await c.tui.executeSlashCommand('/permissions');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Allowed this session (1');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('.env');
  await c.tui.handleKey('Ctrl+X');
  expect(c.client.listToolGrants()).toEqual([]);
  expect(c.tui.computeFrameSnapshot().plainText).toContain('No file or command access remembered');
  await c.tui.handleKey('Escape');
});

test('paths outside the workspace are denied without a prompt or any outside path in the reply', async () => {
  const c = await make({ name: 'read', args: '{"path":"../../etc/passwd"}' });
  c.client.setToolsEnabled(true);
  await c.tui.submitPrompt('read passwd');
  const result = c.tui.getTranscript().at(-1)!.toolResults?.[0];
  expect(result).toMatchObject({ status: 'denied', code: 'DENIED' });
  expect(c.client.listPermissions()).toHaveLength(0);
  expect(JSON.stringify(c.server.requests)).not.toContain('root:');
});

test('a provider that rejects tools marks the model unsupported and the next turn chats without tools', async () => {
  const c = await make({ name: 'read', args: '{"path":"notes.txt"}' });
  c.client.setToolsEnabled(true);
  c.server.set({ status: 400 });
  await c.tui.submitPrompt('hello');
  expect(c.tui.getTranscript().at(-1)!.errorText).toContain('does not accept workspace tools');
  expect(c.client.status().activeModel?.capabilities.tools).toBe('unsupported');
  c.server.set({ status: 200, toolCall: null });
  const before = c.server.requests.length;
  await c.tui.submitPrompt('hello again');
  expect(c.server.requests.slice(before).every(r => !r.body?.tools?.length)).toBe(true);
  expect(c.tui.getTranscript().at(-1)!.content).toContain('Hello fixture');
});
