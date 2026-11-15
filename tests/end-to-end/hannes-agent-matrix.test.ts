/**
 * ADR 0029 acceptance: changing the model provider does not change who owns the coding-agent tools.
 * Two independent wire formats (OpenAI Chat Completions and Anthropic Messages) drive the same Hannes
 * Conversation loop; every project tool runs through the shared ToolDispatcher/ToolOrchestrator.
 * Deterministic fixtures only: this is not live provider evidence.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { messagesToTranscript } from '@hannes/tui';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { fixtureServer, memoryVault, type ScriptedReply, type ScriptedView } from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const PATCH = '*** Begin Patch\n*** Update File: notes.txt\n@@\n-old\n+PATCHED\n*** End Patch';

async function make(protocol: 'chat' | 'anthropic', script: (view: ScriptedView) => ScriptedReply) {
  const home = mkdtempSync(join(tmpdir(), 'hannes-matrix-home-')), root = mkdtempSync(join(tmpdir(), 'hannes-matrix-ws-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'notes.txt'), 'old\n');
  writeFileSync(join(root, 'service.ts'), 'export function verifyToken() { return true; }\n');
  const server = fixtureServer(); cleanup.push(() => server.server.stop(true));
  server.set({ script });
  const app = startup(home, { vault: memoryVault() });
  cleanup.push(async () => { await app.shutdownCommands(); await app.subscriptions.shutdown(); app.db.close(); });
  app.registry.add(server.provider(protocol, { id: 'matrix', auth: 'none' })); await app.accounts.add('matrix', 'fixture', { kind: 'none' });
  const client = app.createFutrynClient(root); await client.discoverModels(); client.selectModel('fixture-model'); client.setToolsEnabled(true);
  return { app, client, root, server };
}
type Ctx = Awaited<ReturnType<typeof make>>;
async function turn(c: Ctx, text: string, signal?: AbortSignal) {
  let answer = ''; const results: { name: string; status: string; code?: string }[] = [];
  for await (const e of c.client.sendMessage(text, { signal })) {
    if (e.type === 'textDelta') answer += e.text;
    if (e.type === 'toolResult') results.push({ name: e.result.name, status: e.result.status, code: e.result.code });
  }
  return { answer, results };
}
const audit = (c: Ctx) => (c.app.db.query('select tool, phase, decision, outcome from tool_audit order by rowid').all() as { tool: string; phase: string; decision: string | null; outcome: string | null }[]);
async function waitPrompt(c: Ctx) { const end = Date.now() + 4000; while (!c.client.listPendingPermissions().length && Date.now() < end) await Bun.sleep(5); return c.client.listPendingPermissions()[0]!; }

for (const protocol of ['chat', 'anthropic'] as const) {
  test(`${protocol}: read → model continuation runs through the Hannes dispatcher`, async () => {
    const c = await make(protocol, v => v.results.length ? { text: `SAW ${v.results[0]!.content.trim()}` } : { calls: [{ name: 'read', input: { path: 'notes.txt' } }] });
    const r = await turn(c, 'read notes');
    expect(r.results).toEqual([{ name: 'read', status: 'ok', code: undefined }]);
    expect(r.answer).toContain('old');
    // The dispatcher audited the call; the provider adapter never touched the file system itself.
    expect(audit(c).filter(a => a.tool === 'read').map(a => a.phase)).toEqual(['requested', 'decided', 'completed']);
  });

  test(`${protocol}: search → read → continuation, each step chosen from the previous result`, async () => {
    const c = await make(protocol, v => {
      if (!v.results.length) return { calls: [{ name: 'grep', input: { pattern: 'verifyToken' } }] };
      if (v.results.length === 1) { const file = /([\w.-]+\.ts)/.exec(v.results[0]!.content)?.[1] ?? 'missing'; return { calls: [{ name: 'read', input: { path: file } }] }; }
      return { text: `FOUND ${v.results[1]!.content.includes('verifyToken') ? 'definition' : 'nothing'}` };
    });
    const r = await turn(c, 'where is verifyToken?');
    expect(r.results.map(x => `${x.name}:${x.status}`)).toEqual(['grep:ok', 'read:ok']);
    expect(r.answer).toBe('FOUND definition');
  });

  test(`${protocol}: read → apply_patch → read → continuation writes only after approval`, async () => {
    const c = await make(protocol, v => {
      const last = v.results.at(-1);
      if (!last) return { calls: [{ name: 'read', input: { path: 'notes.txt' } }] };
      if (last.name === 'read' && v.results.length === 1) return { calls: [{ name: 'apply_patch', input: { patch: PATCH } }] };
      if (last.name === 'apply_patch') return { calls: [{ name: 'read', input: { path: 'notes.txt' } }] };
      return { text: `NOW ${last.content.includes('PATCHED') ? 'patched' : 'unchanged'}` };
    });
    const pending = turn(c, 'patch notes');
    const prompt = await waitPrompt(c);
    expect(prompt.capability).toBe('fs.write');
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('old\n'); // nothing written before approval
    c.client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'once');
    const r = await pending;
    expect(r.results.map(x => `${x.name}:${x.status}`)).toEqual(['read:ok', 'apply_patch:ok', 'read:ok']);
    expect(r.answer).toBe('NOW patched');
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('PATCHED\n');
  });

  test(`${protocol}: a denied write leaves files unchanged and the model receives the denial`, async () => {
    const c = await make(protocol, v => v.results.length ? { text: `MODEL GOT ${v.results[0]!.content.slice(0, 40)}` } : { calls: [{ name: 'apply_patch', input: { patch: PATCH } }] });
    const pending = turn(c, 'patch notes');
    const prompt = await waitPrompt(c);
    c.client.dismissPermissionDialog(prompt.approvalId);
    const r = await pending;
    expect(r.results).toEqual([{ name: 'apply_patch', status: 'denied', code: expect.any(String) }]);
    expect(r.answer).toStartWith('MODEL GOT');
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('old\n');
  });

  test(`${protocol}: tool budget exhaustion withdraws tools and the model must answer`, async () => {
    let calls = 0;
    const c = await make(protocol, v => v.tools.length ? (calls++, { calls: [{ name: 'read', input: { path: 'notes.txt', offset: calls } }] }) : { text: `STOPPED after ${v.results.length}` });
    const r = await turn(c, 'loop forever');
    expect(r.results.length).toBeLessThanOrEqual(32);
    expect(r.answer).toStartWith('STOPPED');
  });

  test(`${protocol}: malformed tool arguments come back to the model as an error result`, async () => {
    const c = await make(protocol, v => v.results.length ? { text: `ERR ${v.results[0]!.content}` } : { calls: [{ name: 'read', input: { path: 42, extra: true } }] });
    const r = await turn(c, 'bad args');
    expect(r.results).toEqual([{ name: 'read', status: 'error', code: 'INVALID_INPUT' }]);
    expect(r.answer).toContain('Invalid arguments');
  });

  test(`${protocol}: provider errors fail the turn after bounded retries without touching files`, async () => {
    const c = await make(protocol, () => ({ calls: [{ name: 'apply_patch', input: { patch: PATCH } }] }));
    c.server.set({ status: 500 });
    await expect(turn(c, 'patch')).rejects.toMatchObject({ code: 'TRANSPORT' });
    expect(c.server.requests.length).toBeLessThanOrEqual(3);
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('old\n');
  });

  test(`${protocol}: cancelling while a write waits for approval runs nothing and records the cancel`, async () => {
    const c = await make(protocol, () => ({ calls: [{ name: 'apply_patch', input: { patch: PATCH } }] }));
    const abort = new AbortController();
    const pending = turn(c, 'patch', abort.signal);
    await waitPrompt(c);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('old\n');
    expect(c.client.listPendingPermissions()).toHaveLength(0);
  });

  test(`${protocol}: resume keeps the paired write receipt and never replays it`, async () => {
    let phase = 'first';
    const c = await make(protocol, v => phase === 'first'
      ? (v.results.length ? { text: 'done' } : { calls: [{ name: 'apply_patch', input: { patch: PATCH } }] })
      : { text: `RESUMED with ${v.results.length} earlier results` });
    const pending = turn(c, 'patch');
    const prompt = await waitPrompt(c); c.client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'once');
    await pending;
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('PATCHED\n');
    writeFileSync(join(c.root, 'notes.txt'), 'user edited\n'); // the user changes the file afterwards
    const id = c.client.activeSession()!.id;
    const resumed = c.app.createFutrynClient(c.root); resumed.resumeSession(id); resumed.setToolsEnabled(true);
    const item = messagesToTranscript(resumed.activeSession()!.messages, { idPrefix: 'r' }).at(-1)!;
    expect(item.toolCalls?.[0]?.id).toBe(item.toolResults?.[0]?.callId); // call/result pairing survives
    phase = 'second';
    let answer = ''; for await (const e of resumed.sendMessage('continue')) if (e.type === 'textDelta') answer += e.text;
    expect(answer).toBe('RESUMED with 1 earlier results'); // the model sees the old receipt as history…
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('user edited\n'); // …and nothing is re-applied
    expect(audit(c).filter(a => a.tool === 'apply_patch' && a.phase === 'completed')).toHaveLength(1);
  });
}
