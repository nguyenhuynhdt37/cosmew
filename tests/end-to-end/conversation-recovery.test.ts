import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';
import {setDefaultTimeout} from 'bun:test';

// Failed provider streams are retried 5 times with Codex's backoff (≈6 s in total, ADR 0036).
setDefaultTimeout(30_000);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const HTML =
  '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Sales</title><style>body{margin:0;font-family:system-ui;background:#101b2e;color:white}main{max-width:64rem;margin:8vh auto;padding:2rem}button{background:#ffd36e;border:0;border-radius:2rem;padding:1rem 2rem}</style></head>\n<body><main><h1>Make your next launch count</h1><p>Beautiful products deserve a powerful sales page.</p><button>Get started</button></main></body>\n</html>\n';
const patch = (target: string) =>
  `*** Begin Patch\n*** Add File: ${target}\n${HTML.trimEnd()
    .split('\n')
    .map(l => '+' + l)
    .join('\n')}\n*** End Patch`;
async function environment(protocol: 'chat' | 'anthropic') {
  const home = mkdtempSync(join(tmpdir(), 'hannes-recovery-home-')),
    root = mkdtempSync(join(tmpdir(), 'hannes-recovery-ws-'));
  const server = fixtureServer();
  writeFileSync(join(root, 'README.md'), 'Use standalone HTML and CSS. No dependency installation.\n');
  let app = startup(home, {vault: memoryVault()}),
    client = app.createFutrynClient(root);
  cleanup.push(async () => {
    await app.shutdownCommands();
    await app.subscriptions.shutdown();
    app.db.close();
    server.server.stop(true);
    rmSync(home, {recursive: true, force: true});
    rmSync(root, {recursive: true, force: true});
  });
  app.registry.add(
    server.provider(protocol, {id: protocol === 'chat' ? 'router-compatible' : 'anthropic-recovery', auth: 'none'}),
  );
  await app.accounts.add(protocol === 'chat' ? 'router-compatible' : 'anthropic-recovery', 'fixture', {kind: 'none'});
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  let phase: 'initial' | 'continue' | 'notes' = 'initial',
    target = 'helo.html';
  server.set({
    script: view => {
      expect(view.orphanResults).toBe(0);
      expect(view.unansweredCalls).toBe(0);
      const last = view.results.at(-1);
      if (phase === 'notes')
        return {text: 'PLAN_MARKER: historical discussion. ' + 'Context evidence and constraints. '.repeat(220)};
      if (phase === 'initial')
        return !last
          ? {calls: [{name: 'read', input: {path: 'README.md'}}]}
          : {text: 'PLAN_MARKER: I inspected the conventions and will create helo.html.'};
      const body = JSON.stringify(server.requests.filter(r => r.body).at(-1)!.body);
      expect(body).toContain('beautiful standalone sales landing page');
      expect(body).toContain('PLAN_MARKER');
      if (last?.name === 'apply_patch') return {calls: [{name: 'read', input: {path: target}}]};
      if (last?.name === 'read' && last.input.path === target)
        return {text: `VERIFIED ${target}: doctype, HTML structure, inline styles, sales CTA.`};
      return {calls: [{name: 'apply_patch', input: {patch: patch(target)}}]};
    },
  });
  const interrupt = async () => {
    const controller = new AbortController();
    let caught: unknown;
    try {
      for await (const event of client.sendMessage('Create helo.html, a beautiful standalone sales landing page.', {
        signal: controller.signal,
      }))
        if (event.type === 'textDelta' && event.text.includes('PLAN_MARKER')) controller.abort();
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({code: 'CANCELLED'});
    expect(existsSync(join(root, 'helo.html'))).toBe(false);
  };
  const restart = async () => {
    const id = client.activeSession()!.id;
    await app.shutdownCommands();
    await app.subscriptions.shutdown();
    app.db.close();
    app = startup(home, {vault: memoryVault()});
    client = app.createFutrynClient(root);
    client.resumeSession(id);
    client.setToolsEnabled(true);
  };
  return {
    home,
    root,
    server,
    contextNotes: () => {
      phase = 'notes';
    },
    get app() {
      return app;
    },
    get client() {
      return client;
    },
    interrupt,
    restart,
    resume: (file = 'helo.html') => {
      phase = 'continue';
      target = file;
    },
  };
}
type Environment = Awaited<ReturnType<typeof environment>>;
async function finish(c: Environment, text: string, target = 'helo.html') {
  let output = '';
  const operation = (async () => {
    for await (const e of c.client.sendMessage(text)) if (e.type === 'textDelta') output += e.text;
  })();
  const deadline = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < deadline) await Bun.sleep(5);
  const prompt = c.client.listPendingPermissions()[0]!;
  expect(prompt).toMatchObject({capability: 'fs.write', target});
  expect(existsSync(join(c.root, target))).toBe(false);
  c.client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'once');
  await operation;
  const content = readFileSync(join(c.root, target), 'utf8');
  expect(content).toBe(HTML);
  expect(content).toMatch(/^<!doctype html>/i);
  expect(content).toContain('</html>');
  expect(content).toContain('<title>Sales</title>');
  expect(content).toContain('<button>');
  expect(content).not.toContain('<script src=');
  expect(output).toContain(`VERIFIED ${target}`);
  const journal = c.app.conversations.get(c.client.activeSession()!.id)!.recovery!;
  expect(journal.task?.state).toBe('verified');
  expect(journal.messages.filter(m => m.toolName === 'apply_patch')).toHaveLength(1);
  expect(journal.task!.verifiedActions.find(a => a.tool === 'apply_patch')!.scopeHash!).toMatch(/^[a-f0-9]{64}$/);
  const scopes = c.app.db
    .query("SELECT scope_hash FROM tool_audit WHERE tool='apply_patch' AND phase='decided' AND decision='once'")
    .all() as {scope_hash: string}[];
  expect(scopes[0]!.scope_hash).toBe(journal.task!.verifiedActions.find(a => a.tool === 'apply_patch')!.scopeHash!);
}
for (const protocol of ['chat', 'anthropic'] as const)
  for (const followup of [
    'tiếp',
    'continue',
    'tiếp tục',
    'làm tiếp',
    'continue creating the HTML',
    'bạn không nhớ yêu cầu trước à?',
  ])
    test(`${protocol}: read → plan → cancel → ${followup} creates and verifies helo.html after approval`, async () => {
      const c = await environment(protocol);
      await c.interrupt();
      c.resume();
      await finish(c, followup);
    });

test('restart followed by continuation preserves the read and partial plan, with no restored approval', async () => {
  const c = await environment('chat');
  await c.interrupt();
  await c.restart();
  c.resume();
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  await finish(c, 'tiếp');
});

test('an explicit changed goal replaces the auxiliary objective instead of creating the old artifact', async () => {
  const c = await environment('anthropic');
  await c.interrupt();
  c.resume('replacement.html');
  await finish(c, 'Instead create replacement.html, replacing the previous goal.', 'replacement.html');
  expect(existsSync(join(c.root, 'helo.html'))).toBe(false);
  expect(c.app.conversations.get(c.client.activeSession()!.id)!.recovery!.task!.objective).toContain(
    'replacement.html',
  );
});

test('confirmed patch → transport failure → continue reads the existing artifact without replaying the write', async () => {
  const c = await environment('chat');
  await c.interrupt();
  c.resume();
  let caught: unknown;
  const pending = (async () => {
    try {
      for await (const e of c.client.sendMessage('continue'))
        if (e.type === 'toolResult' && e.result.name === 'apply_patch') c.server.set({status: 500});
    } catch (error) {
      caught = error;
    }
  })();
  const deadline = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < deadline) await Bun.sleep(5);
  const permission = c.client.listPendingPermissions()[0]!;
  c.client.resolvePermission(permission.approvalId, permission.scopeHash, 'once');
  await pending;
  expect(caught).toMatchObject({code: 'TRANSPORT'});
  expect(readFileSync(join(c.root, 'helo.html'), 'utf8')).toBe(HTML);
  await c.restart();
  c.server.set({status: 200});
  let answer = '';
  for await (const e of c.client.sendMessage('tiếp')) if (e.type === 'textDelta') answer += e.text;
  expect(answer).toContain('VERIFIED helo.html');
  const audit = c.app.db
    .query("SELECT count(*) AS n FROM tool_audit WHERE tool='apply_patch' AND phase='completed'")
    .get() as {n: number};
  expect(audit.n).toBe(1);
  expect(c.client.listPendingPermissions()).toHaveLength(0);
});

test('cancel while waiting for file approval records denial/cancellation and never writes', async () => {
  const c = await environment('chat');
  await c.interrupt();
  c.resume();
  const controller = new AbortController();
  const pending = (async () => {
    try {
      for await (const _ of c.client.sendMessage('continue', {signal: controller.signal})) {
      }
    } catch (e) {
      return e;
    }
  })();
  const deadline = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < deadline) await Bun.sleep(5);
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  controller.abort();
  await pending;
  expect(existsSync(join(c.root, 'helo.html'))).toBe(false);
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  expect(c.app.conversations.get(c.client.activeSession()!.id)!.recovery!.task!.state).toBe('unfinished');
});

test('compaction survives restart and keeps the HTML objective and every explicit constraint', async () => {
  const c = await environment('chat');
  await c.interrupt();
  c.app.settings.update(s => {
    const model = s.catalogs[0]!.models[0]!;
    model.contextLimit = 24000;
    model.outputLimit = 4096;
  });
  c.client.setToolsEnabled(false);
  c.contextNotes();
  for (let i = 0; i < 8; i++)
    for await (const _ of c.client.sendMessage(
      `continue; constraint-${i}: use standalone inline CSS and preserve the sales CTA.`,
    )) {
    }
  const before = c.app.conversations.get(c.client.activeSession()!.id)!;
  expect(before.recovery?.compaction).toBeDefined();
  const sourceCount = before.recovery!.messages.length;
  await c.restart();
  c.resume();
  await finish(c, 'tiếp');
  const finalRequest = JSON.stringify(c.server.requests.filter(r => r.body).at(-1)!.body);
  for (let i = 0; i < 8; i++) expect(finalRequest).toContain(`constraint-${i}`);
  expect(finalRequest).toContain('context checkpoint');
  expect(c.app.conversations.get(c.client.activeSession()!.id)!.recovery!.messages.length).toBeGreaterThan(sourceCount);
});

test('repeated planning without artifact progress gets one corrective continuation, then ends with the task unfinished', async () => {
  // ADR 0033: Codex lets the model end its turn; the artifact check blocks once (like a Stop hook) and
  // never converts the answer into a failure. The unverified artifact stays durable unfinished work.
  const c = await environment('chat');
  let answer = '';
  for await (const e of c.client.sendMessage('Create helo.html, a beautiful standalone sales landing page.'))
    if (e.type === 'textDelta') answer += e.text;
  expect(existsSync(join(c.root, 'helo.html'))).toBe(false);
  expect(answer).not.toContain('VERIFIED');
  const bodies = c.server.requests.filter(r => r.body);
  expect(bodies).toHaveLength(3);
  expect(JSON.stringify(bodies.at(-1)!.body)).toContain('Artifact progress correction');
  const record = c.app.conversations.get(c.client.activeSession()!.id)!;
  expect(record.recovery!.task!.state).toBe('unfinished');
  expect(record.turns!.at(-1)!).toMatchObject({outcome: 'completed', stopReason: 'completed'});
});

test('identical reads receive corrective guidance and bounded termination without an arbitrary write deadline', async () => {
  const c = await environment('chat');
  c.server.set({script: () => ({calls: [{name: 'read', input: {path: 'README.md'}}]})});
  await expect(
    (async () => {
      for await (const _ of c.client.sendMessage('Explain this project')) {
      }
    })(),
  ).rejects.toMatchObject({code: 'STALLED'});
  expect(c.server.requests.filter(r => r.body)).toHaveLength(7);
  expect(JSON.stringify(c.server.requests.at(-1)!.body)).toContain('Progress correction');
  expect(existsSync(join(c.root, 'helo.html'))).toBe(false);
});

test('a denied mutation is not automatically invoked or prompted again in the same turn', async () => {
  const c = await environment('chat');
  c.server.set({script: () => ({calls: [{name: 'apply_patch', input: {patch: patch('helo.html')}}]})});
  const operation = (async () => {
    try {
      for await (const _ of c.client.sendMessage('Create helo.html')) {
      }
    } catch (e) {
      return e;
    }
  })();
  const deadline = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < deadline) await Bun.sleep(5);
  const permission = c.client.listPendingPermissions()[0]!;
  c.client.resolvePermission(permission.approvalId, permission.scopeHash, 'deny');
  await operation;
  expect(existsSync(join(c.root, 'helo.html'))).toBe(false);
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  expect(
    (
      c.app.db.query("SELECT count(*) AS n FROM tool_audit WHERE tool='apply_patch' AND phase='requested'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

test('another client cannot run or delete a thread while a write is awaiting approval', async () => {
  const c = await environment('chat');
  await c.interrupt();
  c.resume();
  const operation = (async () => {
    for await (const _ of c.client.sendMessage('continue')) {
    }
  })();
  const deadline = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < deadline) await Bun.sleep(5);
  const id = c.client.activeSession()!.id,
    other = c.app.createFutrynClient(c.root);
  other.resumeSession(id);
  other.setToolsEnabled(true);
  await expect(
    (async () => {
      for await (const _ of other.sendMessage('continue')) {
      }
    })(),
  ).rejects.toMatchObject({code: 'POLICY'});
  expect(() => c.app.conversations.delete(id)).toThrow();
  const permission = c.client.listPendingPermissions()[0]!;
  c.client.resolvePermission(permission.approvalId, permission.scopeHash, 'once');
  await operation;
  expect(readFileSync(join(c.root, 'helo.html'), 'utf8')).toBe(HTML);
});

test('forking copies execution evidence and pending work but never replays writes or restores grants', async () => {
  const c = await environment('chat');
  await c.interrupt();
  c.resume();
  await finish(c, 'continue');
  const id = c.client.activeSession()!.id,
    original = c.app.conversations.get(id)!;
  const before = (c.app.db.query('SELECT count(*) AS n FROM tool_audit').get() as {n: number}).n;
  const fork = c.app.conversations.fork(id, original.selection);
  expect(fork.id).not.toBe(id);
  expect(fork.recovery!.messages.some(m => m.toolName === 'apply_patch')).toBe(true);
  expect((c.app.db.query('SELECT count(*) AS n FROM tool_audit').get() as {n: number}).n).toBe(before);
  expect(fork.recovery!.task!.state).toBe('unfinished');
  expect(fork.recovery!.task!.verifiedActions.some(a => a.status.startsWith('verified:'))).toBe(false);
  expect(readFileSync(join(c.root, 'helo.html'), 'utf8')).toBe(HTML);
});

test('a continuation phrase with a different explicit filename changes the active target', async () => {
  const c = await environment('chat');
  await c.interrupt();
  c.resume('replacement.html');
  await finish(c, 'continue creating replacement.html instead of helo.html', 'replacement.html');
  expect(existsSync(join(c.root, 'helo.html'))).toBe(false);
  expect(c.app.conversations.get(c.client.activeSession()!.id)!.recovery!.task!.artifactTargets).toContain(
    'replacement.html',
  );
});
