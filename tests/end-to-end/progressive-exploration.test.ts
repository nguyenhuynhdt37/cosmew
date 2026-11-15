import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_TOOL_CALLS, MAX_TOOL_ROUNDS } from '@hannes/core';
import type { ModelEvent } from '@hannes/contracts';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { fixtureServer, memoryVault, scriptedView, type ScriptedReply, type ScriptedView } from '../fixtures';

/**
 * Task 02 (ADR 0020). The "model" here is a deterministic policy: each reply is computed only from
 * the request that reached the fixture server, i.e. from the tool results Hannes really sent back.
 * It contains no file path of the fixture repository except the discovery pattern, so a correct
 * sequence proves the results arrived, were paired with their calls, and could drive the next step.
 */
const denied = (content: string) => /^\[(denied|error)/.test(content);
function explorer(view: ScriptedView): ScriptedReply {
  const results = view.results; const last = results.at(-1);
  if (!last) return { calls: [{ name: 'glob', input: { pattern: '**/routes.*' } }] };
  if (denied(last.content)) return { text: `MISSING: ${last.input.path ?? last.name} could not be read: ${last.content}` };
  if (!view.tools.length) return { text: 'MISSING: tools were withdrawn before the definition was found' };
  if (last.name === 'glob') {
    const path = last.content.split('\n').map(line => line.trim()).find(line => /(^|\/)routes\.\w+$/.test(line));
    return path ? { calls: [{ name: 'read', input: { path } }] } : { text: 'MISSING: no routes file found' };
  }
  const reads = results.filter(r => r.name === 'read');
  const imported = /import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/([\w.-]+)'/.exec(reads[0]!.content);
  if (!imported) return { text: `MISSING: ${reads[0]!.input.path} imports nothing to follow` };
  if (reads.length === 1) return { calls: [{ name: 'read', input: { path: join(dirname(last.input.path), imported[2] + (/\.\w+$/.test(imported[2]!) ? '' : '.ts')) } }] };
  const definition = last.content.split('\n').find(line => line.includes(`function ${imported[1]}`));
  return { text: definition ? `${imported[1]} is defined in ${last.input.path}: ${definition.replace(/^\s*\d+\t/, '').trim()}` : `MISSING: ${imported[1]} is not defined in ${last.input.path}` };
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function make(script: (view: ScriptedView) => ScriptedReply, files: Record<string, string>, protocol: 'chat' | 'anthropic' = 'chat') {
  const home = mkdtempSync(join(tmpdir(), 'futryn-explore-home-')); const ws = mkdtempSync(join(tmpdir(), 'futryn-explore-ws-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(ws, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(ws, path)), { recursive: true }); writeFileSync(join(ws, path), text); }
  const server = fixtureServer(); server.set({ script }); cleanup.push(() => server.server.stop(true));
  const app = startup(home, { vault: memoryVault() }); cleanup.push(() => app.db.close());
  app.registry.add(server.provider(protocol, { id: 'tooly', auth: 'none' }));
  await app.accounts.add('tooly', 'main', { kind: 'none' });
  const client = app.createFutrynClient(ws); await client.discoverModels(); client.selectModel('fixture-model');
  client.setToolsEnabled(true); // what folder consent does in the TUI
  /** Model requests only (catalog GETs excluded), as the scripted model saw them. */
  const views = () => server.requests.filter(r => r.body?.messages).map(r => scriptedView(protocol, r.body));
  const audit = () => (app.db.query("SELECT tool, target, phase, outcome FROM tool_audit ORDER BY rowid").all() as { tool: string; target: string | null; phase: string; outcome: string | null }[]);
  const targets = () => audit().filter(r => r.phase === 'completed').map(r => `${r.tool} ${r.target}`);
  return { app, client, server, ws, views, audit, targets };
}
async function ask(client: Awaited<ReturnType<typeof make>>['client'], text: string, signal?: AbortSignal) {
  const events: ModelEvent[] = []; let answer = '';
  for await (const event of client.sendMessage(text, { signal })) { events.push(event); if (event.type === 'textDelta') answer += event.text; }
  return { events, answer };
}

const repository = {
  'src/routes.ts': "import { verifyToken } from './service';\n\nexport function login(request: { token: string }) {\n  return verifyToken(request.token);\n}\n",
  'src/service.ts': "export function verifyToken(token: string) { return token === 'SERVICE_MARKER'; }\n",
  'src/billing.ts': "export const invoice = 'UNRELATED_MARKER';\n",
};

for (const protocol of ['chat', 'anthropic'] as const) test(`${protocol}: discovery, then each read is chosen from the previous result; unrelated files stay unread`, async () => {
  const c = await make(explorer, repository, protocol);
  const { answer, events } = await ask(c.client, 'How does the login route check tokens?');
  expect(answer).toBe("verifyToken is defined in src/service.ts: export function verifyToken(token: string) { return token === 'SERVICE_MARKER'; }");
  // The dispatcher ran exactly these, in this order; billing.ts was never touched.
  expect(c.targets()).toEqual(['glob .', 'read src/routes.ts', 'read src/service.ts']);
  expect(JSON.stringify(c.server.requests)).not.toContain('UNRELATED_MARKER');
  // Each later request carried every earlier result, joined to its own call.
  const views = c.views();
  expect(views.map(v => v.results.length)).toEqual([0, 1, 2, 3]);
  for (const view of views) { expect(view.orphanResults).toBe(0); expect(view.unansweredCalls).toBe(0); expect(view.tools).toEqual(['read', 'glob', 'grep']); }
  const final = views.at(-1)!;
  expect(final.results.map(r => [r.name, r.input.path ?? r.input.pattern])).toEqual([['glob', '**/routes.*'], ['read', 'src/routes.ts'], ['read', 'src/service.ts']]);
  expect(final.results[1]!.content).toContain("from './service'");
  expect(final.results[2]!.content).toContain('SERVICE_MARKER');
  // Host guidance sits in the system channel of every round and holds no repository text.
  for (const view of views) { expect(view.system).toContain('Investigate progressively'); expect(view.system).toContain(`at most ${MAX_TOOL_CALLS} tool calls`); expect(view.system).not.toContain('verifyToken'); }
  // UI events pair up the same way.
  const calls = events.flatMap(e => e.type === 'toolCallComplete' ? [e.call.id] : []);
  expect(events.flatMap(e => e.type === 'toolResult' ? [e.result.callId] : [])).toEqual(calls);
  // Durable history keeps call → result order, so a resumed session sends the same pairs.
  const saved = c.app.conversations.get(c.client.activeSession()!.id)!.messages;
  expect(saved.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  for (let i = 1; i < 7; i += 2) expect(saved[i + 1]!.toolCallId).toBe(saved[i]!.toolCalls![0]!.id);
  expect(JSON.stringify(saved)).not.toContain('Investigate progressively');
});

test('negative: when routes.ts points elsewhere the model follows the new evidence, not service.ts', async () => {
  const c = await make(explorer, { ...repository,
    'src/routes.ts': "import { verifyToken } from './token-check';\n\nexport const login = (token: string) => verifyToken(token);\n",
    'src/token-check.ts': "export function verifyToken(token: string) { return token.length > 0 && 'TOKEN_CHECK_MARKER'; }\n",
  });
  const { answer } = await ask(c.client, 'How does the login route check tokens?');
  expect(answer).toContain('verifyToken is defined in src/token-check.ts');
  expect(answer).toContain('TOKEN_CHECK_MARKER');
  expect(c.targets()).toEqual(['glob .', 'read src/routes.ts', 'read src/token-check.ts']);
  expect(JSON.stringify(c.server.requests)).not.toContain('SERVICE_MARKER');
});

test('missing evidence is reported: the followed file does not exist', async () => {
  const c = await make(explorer, { 'src/routes.ts': "import { verifyToken } from './gone';\nexport const login = verifyToken;\n" });
  const { answer } = await ask(c.client, 'How does the login route check tokens?');
  expect(answer).toStartWith('MISSING: src/gone.ts could not be read');
  expect(c.views()).toHaveLength(4); // no retry loop after the failed read
});

test('independent reads are batched in one model round and each result keeps its own call', async () => {
  const batch = (view: ScriptedView): ScriptedReply => view.results.length
    ? { text: view.results.map(r => `${r.input.path}=${r.content.replace(/^\s*\d+\t/, '')}`).join(';') }
    : { calls: [{ name: 'read', input: { path: 'a.txt' } }, { name: 'read', input: { path: 'b.txt' } }, { name: 'grep', input: { pattern: 'gamma' } }] };
  const c = await make(batch, { 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'c.txt': 'gamma\n' });
  const { answer } = await ask(c.client, 'compare');
  expect(c.views()).toHaveLength(2); // three calls, one round trip
  expect(answer).toStartWith('a.txt=alpha;b.txt=beta;');
  const final = c.views()[1]!;
  expect(final.results.map(r => r.name)).toEqual(['read', 'read', 'grep']);
  expect(final.results[2]!.content).toContain('c.txt:1');
  expect(final.orphanResults + final.unansweredCalls).toBe(0);
  const saved = c.app.conversations.get(c.client.activeSession()!.id)!.messages;
  expect(saved.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'assistant']);
  expect(saved.slice(2, 5).map(m => m.toolCallId)).toEqual(saved[1]!.toolCalls!.map(call => call.id));
});

test('permission denial ends that path: the secret never leaves and the model reports it', async () => {
  const c = await make(explorer, { 'src/routes.ts': "import { verifyToken } from './signing.key';\nexport const login = verifyToken;\n", 'src/signing.key': 'KEY_MATERIAL_MARKER\n' });
  const turn = ask(c.client, 'How does the login route check tokens?');
  const end = Date.now() + 4000; while (!c.client.listPendingPermissions().length && Date.now() < end) await Bun.sleep(10);
  const pending = c.client.listPendingPermissions(); expect(pending).toHaveLength(1);
  expect(pending[0]!.target).toBe('src/signing.key');
  c.client.resolvePermission(pending[0]!.approvalId, pending[0]!.scopeHash, 'deny');
  const { answer } = await turn;
  expect(answer).toStartWith('MISSING: src/signing.key could not be read: [denied: DENIED]');
  expect(JSON.stringify(c.server.requests)).not.toContain('KEY_MATERIAL_MARKER');
  expect(c.views()).toHaveLength(4); // glob, read routes, denied read, answer: no retry
  expect(c.client.listToolGrants()).toEqual([]);
});

test('cancellation between rounds stops the loop and commits no partial tool history', async () => {
  const abort = new AbortController();
  const c = await make(view => { if (view.results.length === 2) abort.abort(); return explorer(view); }, repository);
  await expect(ask(c.client, 'How does the login route check tokens?', abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(c.targets()).toEqual(['glob .', 'read src/routes.ts']); // service.ts was requested by the model but never read
  const saved = c.app.conversations.get(c.client.activeSession()!.id)!.messages;
  expect(saved.some(m => m.role === 'tool' || m.toolCalls)).toBe(false);
  // The conversation is usable afterwards.
  c.server.set({ script: () => ({ text: 'still here' }) });
  expect((await ask(c.client, 'hello')).answer).toBe('still here');
});

/** A dependency chain longer than any budget: every file names the next one. */
const chain = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`chain/f${i + 1}.txt`, `next: chain/f${i + 2}.txt\n`]));
const follow = (view: ScriptedView): ScriptedReply => {
  const read = view.results.filter(r => !denied(r.content));
  if (!view.tools.length) return { text: `STOPPED after ${read.length} files; ${/next: (\S+)/.exec(read.at(-1)!.content)![1]} and later were not inspected` };
  return { calls: [{ name: 'read', input: { path: read.length ? /next: (\S+)/.exec(read.at(-1)!.content)![1] : 'chain/f1.txt' } }] };
};

test(`round budget: after ${MAX_TOOL_ROUNDS} tool rounds the tools are withdrawn, the model is told, and it reports the gap`, async () => {
  const c = await make(follow, chain);
  const { answer } = await ask(c.client, 'follow the chain');
  const views = c.views();
  expect(views).toHaveLength(MAX_TOOL_ROUNDS + 1);
  expect(views.slice(0, -1).every(v => v.tools.length === 3)).toBe(true);
  expect(views.at(-1)!.tools).toEqual([]);
  expect(views.at(-1)!.system).toContain('tool budget for this turn is used up');
  expect(views.slice(0, -1).some(v => v.system.includes('used up'))).toBe(false);
  expect(c.targets()).toEqual(Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => `read chain/f${i + 1}.txt`));
  expect(answer).toBe(`STOPPED after ${MAX_TOOL_ROUNDS} files; chain/f${MAX_TOOL_ROUNDS + 1}.txt and later were not inspected`);
  expect(views.at(-1)!.unansweredCalls).toBe(0);
});

test(`call budget: only ${MAX_TOOL_CALLS} calls run in a turn; the rest get a paired refusal and are never executed`, async () => {
  const wide = (view: ScriptedView): ScriptedReply => view.tools.length
    ? { calls: Array.from({ length: 5 }, (_, i) => ({ name: 'read', input: { path: `chain/f${view.results.length + i + 1}.txt` } })) }
    : { text: `STOPPED: ${view.results.filter(r => denied(r.content)).length} calls refused` };
  const c = await make(wide, chain);
  const { answer, events } = await ask(c.client, 'read widely');
  expect(c.targets()).toHaveLength(MAX_TOOL_CALLS);
  expect(c.targets().at(-1)).toBe(`read chain/f${MAX_TOOL_CALLS}.txt`);
  const results = events.flatMap(e => e.type === 'toolResult' ? [e.result] : []);
  expect(results).toHaveLength(35);
  expect(results.slice(MAX_TOOL_CALLS).every(r => r.status === 'error' && r.code === 'TOOL_BUDGET')).toBe(true);
  expect(answer).toBe('STOPPED: 3 calls refused');
  const final = c.views().at(-1)!;
  expect(final.tools).toEqual([]); expect(final.unansweredCalls).toBe(0); expect(final.orphanResults).toBe(0);
  expect(JSON.stringify(c.server.requests)).not.toContain('chain/f34.txt\\n'); // f33's content names f34; f33 was never read
});

test('rereading an unchanged file returns a short notice; a changed file returns its new content', async () => {
  let ws = '';
  const reread = (view: ScriptedView): ScriptedReply => {
    if (view.results.length === 2) writeFileSync(join(ws, 'notes.txt'), 'second version\n');
    return view.results.length < 3 ? { calls: [{ name: 'read', input: { path: 'notes.txt' } }] } : { text: 'done' };
  };
  const c = await make(reread, { 'notes.txt': 'first version\n' }); ws = c.ws;
  await ask(c.client, 'watch notes');
  const contents = c.views().at(-1)!.results.map(r => r.content);
  expect(contents[0]).toContain('first version');
  expect(contents[1]).toStartWith('[unchanged]');
  expect(contents[1]).not.toContain('first version');
  expect(contents[2]).toContain('second version');
  // Every reread still went through the dispatcher (permission check + audit).
  expect(c.targets()).toEqual(['read notes.txt', 'read notes.txt', 'read notes.txt']);
});

test('no tools, no guidance: a chat without folder consent is sent unchanged', async () => {
  const c = await make(() => ({ text: 'plain' }), repository);
  c.client.setToolsEnabled(false);
  expect((await ask(c.client, 'hello')).answer).toBe('plain');
  expect(c.views()[0]).toMatchObject({ system: '', tools: [] });
});
