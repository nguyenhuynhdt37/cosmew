import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-session-workspace-'));
  const a = join(dir, 'a'),
    b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  symlinkSync(a, join(dir, 'alias-a'));
  const app = startup(join(dir, 'state'), {vault: memoryVault()});
  const server = fixtureServer();
  app.registry.add(server.provider('chat', {id: 'session-workspace', auth: 'none'}));
  await app.accounts.add('session-workspace', 'fixture', {kind: 'none'});
  const clientA = app.createFutrynClient(a);
  await clientA.discoverModels();
  clientA.selectModel('fixture-model');
  const clientB = app.createFutrynClient(b);
  const first = clientA.createSession();
  app.conversations.append(first.id, {role: 'user', content: 'same title'}, 'committed');
  const second = clientB.createSession();
  app.conversations.append(second.id, {role: 'user', content: 'same title'}, 'committed');
  return {
    app,
    a,
    b,
    dir,
    clientA,
    clientB,
    first,
    second,
    cleanup: async () => {
      await app.shutdownCommands();
      app.db.close();
      server.server.stop(true);
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

test('default session list isolates identical titles by canonical workspace before the 200 row limit', async () => {
  const h = await harness();
  try {
    expect(h.clientA.listSessions().map(s => [s.id, s.title])).toEqual([[h.first.id, 'same title']]);
    expect(h.clientB.listSessions().map(s => [s.id, s.title])).toEqual([[h.second.id, 'same title']]);
    for (let i = 0; i < 205; i++) h.clientB.createSession();
    const legacy = h.app.conversations.create(h.first.selection);
    h.app.conversations.append(legacy, {role: 'user', content: 'legacy unknown workspace'}, 'committed');
    expect(h.clientA.listSessions().map(s => s.id)).toEqual([h.first.id]);
    expect(
      h.app
        .createFutrynClient(join(h.dir, 'alias-a'))
        .listSessions()
        .map(s => s.id),
    ).toEqual([h.first.id]);
    expect(h.clientB.listSessions()).toHaveLength(200);
    expect(h.clientB.listSessions().some(s => s.id === legacy || s.id === h.first.id)).toBe(false);
    expect(h.app.conversations.list().some(s => s.id === legacy)).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test('foreign resume and fork reject without changing history, workspace or session authority', async () => {
  const h = await harness();
  try {
    h.clientB.setPermissionMode('acceptEdits');
    expect(() => h.clientB.resumeSession(h.first.id)).toThrow(/original.*(directory|workspace)|workspace.*original/i);
    expect(() => h.clientB.forkSession(h.first.id)).toThrow();
    expect(h.clientB.activeSession()?.id).toBe(h.second.id);
    expect(h.clientB.permissionMode()).toBe('acceptEdits');
    expect(h.clientB.status().workspace).toBe(h.b);
    expect(h.app.conversations.get(h.first.id)?.messages.map(m => m.content)).toEqual(['same title']);
    expect(h.app.db.query('SELECT workspace FROM conversations WHERE id=?').get(h.first.id)).toEqual({
      workspace: realpathSync(h.a),
    });
    expect(h.app.db.query('SELECT count(*) AS n FROM conversations').get()).toEqual({n: 2});
    const alias = h.app.createFutrynClient(join(h.dir, 'alias-a'));
    expect(alias.resumeSession(h.first.id).messages.map(m => m.content)).toEqual(['same title']);
    const reopened = startup(join(h.dir, 'state'), {vault: memoryVault()});
    try {
      const resumed = reopened.createFutrynClient(join(h.dir, 'alias-a'));
      expect(resumed.resumeSession(h.first.id).messages.map(m => m.content)).toEqual(['same title']);
      expect(
        reopened
          .createFutrynClient(h.b)
          .listSessions()
          .map(s => s.id),
      ).toEqual([h.second.id]);
    } finally {
      await reopened.shutdownCommands();
      reopened.db.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('legacy NULL workspace is hidden and rejected rather than silently assigned to the current project', async () => {
  const h = await harness();
  try {
    const legacy = h.app.conversations.create(h.first.selection);
    expect(() => h.clientA.resumeSession(legacy)).toThrow(/workspace.*unknown|unknown.*workspace/i);
    expect(() => h.clientB.resumeSession(legacy)).toThrow();
    expect(h.clientA.listSessions().some(s => s.id === legacy)).toBe(false);
    expect(h.app.db.query('SELECT workspace FROM conversations WHERE id=?').get(legacy)).toEqual({workspace: null});
  } finally {
    await h.cleanup();
  }
});

test('CLI chat conversation records its cwd and rejects foreign or unknown workspace resume', async () => {
  const h = await harness();
  try {
    const conversation = h.app.conversation();
    const stored = h.app.db.query('SELECT workspace FROM conversations WHERE id=?').get(conversation.id);
    expect(stored).toEqual({workspace: realpathSync(process.cwd())});
    expect(h.app.resumeConversation(conversation.id).id).toBe(conversation.id);
    expect(() => h.app.resumeConversation(h.first.id)).toThrow();
    const legacy = h.app.conversations.create(h.first.selection);
    expect(() => h.app.resumeConversation(legacy)).toThrow();
  } finally {
    await h.cleanup();
  }
});

// Exercise the composition root's injected session-ID boundary directly for operations
// whose SDK convenience method normally supplies the current session itself.
function backend(client: import('@cosmew/sdk').FutrynClient): import('@cosmew/sdk').FutrynBackendPorts {
  return (client as unknown as {ports: import('@cosmew/sdk').FutrynBackendPorts}).ports;
}
const foreignOperations = [
  'delete',
  'plan',
  'planProposal',
  'savePlanProposal',
  'subagents',
  'queueSteering',
  'retract',
  'retractEntries',
  'enqueue',
  'inbox',
  'queued',
  'history',
  'checkpoints',
] as const;
test.each(foreignOperations)('host %s refuses a foreign session before reading or mutating it', async operation => {
  const h = await harness();
  try {
    const p = backend(h.clientB),
      id = h.first.id;
    h.app.conversations.enqueueNextTurn(id, 'foreign queued prompt');
    const calls: Record<typeof operation, () => unknown> = {
      delete: () => h.clientB.deleteSession(id),
      plan: () => p.getPlan!(id),
      planProposal: () => p.getPlanProposal!(id),
      savePlanProposal: () =>
        p.savePlanProposal!(id, {
          id: crypto.randomUUID(),
          sessionId: id,
          plan: 'foreign plan',
          status: 'proposed',
          createdAt: new Date().toISOString(),
          revision: 1,
        }),
      subagents: () => h.clientB.subagents(id),
      queueSteering: () => p.queueSteeringForNextTurn!(id),
      retract: () => p.retractQueuedInput!(id),
      retractEntries: () => p.retractQueuedEntries!(id, {includeShell: true}),
      enqueue: () => p.enqueueNextTurn!(id, 'wrong workspace'),
      inbox: () => p.listNextTurn!(id),
      queued: () => p.queuedInput!(id),
      history: () => p.promptHistory!({scope: 'session', sessionId: id, workspace: h.b}),
      checkpoints: () => p.checkpoints!(id),
    };
    expect(calls[operation]).toThrow(/original project directory/);
    expect(h.app.conversations.listNextTurn(id).map(p => p.content)).toEqual(['foreign queued prompt']);
    expect(h.app.conversations.get(id)?.messages.map(m => m.content)).toEqual(['same title']);
  } finally {
    await h.cleanup();
  }
});

test('host shell refuses a foreign session before creating a receipt or executing a command', async () => {
  const h = await harness();
  try {
    await expect(
      backend(h.clientB).runShellCommand!('printf foreign', undefined, undefined, {
        sessionId: h.first.id,
        callId: 'foreign-shell',
      }),
    ).rejects.toMatchObject({code: 'POLICY'});
    expect(h.app.conversations.get(h.first.id)?.turns).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test.each(['inspect', 'stop'] as const)('subagent %s checks durable parent workspace', async operation => {
  const h = await harness();
  try {
    const child = h.app.conversations.create(h.first.selection);
    h.app.conversations.saveSubagentSession({
      id: child,
      parentConversationId: h.first.id,
      parentTurnId: 'parent-turn',
      callId: 'agent-call',
      depth: 1,
      agentType: 'explore',
      description: 'foreign child',
      prompt: 'foreign prompt',
      selection: h.first.selection,
      forkContext: false,
      background: true,
      status: 'completed',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const p = backend(h.clientB);
    expect(() => (operation === 'inspect' ? p.inspectSubagent!(child) : p.stopSubagent!(child))).toThrow(
      /original project directory/,
    );
    expect(h.clientA.inspectSubagent(child)?.description).toBe('foreign child');
    expect(h.clientA.getSession(child)?.id).toBe(child);
    expect(() => h.clientB.getSession(child)).toThrow(/original project directory/);
    expect(() => h.clientA.resumeSession(child)).toThrow();
    expect(p.inspectSubagent!('missing-agent')).toBeUndefined();
    expect(p.stopSubagent!('missing-agent')).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test('checkpoint list and rewind share canonical workspace across symlink aliases', async () => {
  const h = await harness();
  try {
    const {CheckpointStore} = await import('@cosmew/persistence');
    const checkpoints = new CheckpointStore(h.app.db);
    const id = checkpoints.begin(h.first.id, realpathSync(h.a), 'canonical checkpoint', []);
    const alias = h.app.createFutrynClient(join(h.dir, 'alias-a'));
    alias.resumeSession(h.first.id);
    expect(alias.checkpoints().map(c => c.id)).toEqual([id]);
    for await (const _ of alias.sendMessage('create checkpoint through alias')) {
      // Real fixture provider and production sendTurn persist the checkpoint identity.
    }
    expect(h.clientA.checkpoints()).toHaveLength(2);
    expect(
      h.app.db.query('SELECT DISTINCT workspace FROM turn_checkpoints WHERE session_id=?').all(h.first.id),
    ).toEqual([{workspace: realpathSync(h.a)}]);
    expect((await alias.rewind({checkpointId: id, scope: 'conversation'})).restored).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test('same-workspace session ports retain normal reads and mutations; everywhere history remains explicit', async () => {
  const h = await harness();
  try {
    const p = backend(h.clientA),
      id = h.first.id;
    expect(p.getPlan!(id)).toBeNull();
    expect(p.getPlanProposal!(id)).toBeNull();
    const entry = p.enqueueNextTurn!(id, 'local queued prompt');
    expect(p.listNextTurn!(id)).toEqual([entry]);
    expect(p.queuedInput!(id)).toEqual([]);
    expect(p.retractQueuedInput!(id)).toBe('local queued prompt');
    expect(p.listNextTurn!(id)).toEqual([]);
    expect(p.retractQueuedEntries!(id, {includeShell: true})).toEqual([]);
    p.queueSteeringForNextTurn!(id);
    expect(h.clientA.subagents(id)).toEqual([]);
    expect(
      h.clientB
        .promptHistory({scope: 'everywhere'})
        .map(p => p.sessionId)
        .sort(),
    ).toEqual([h.first.id, h.second.id].sort());
    expect(h.clientB.promptHistory({scope: 'session'}).map(p => p.sessionId)).toEqual([h.second.id]);
    expect(h.clientB.getSession('missing-session')).toBeUndefined();
    expect(h.clientB.deleteSession('missing-session')).toBe(false);
    expect(() => h.clientB.resumeSession('missing-session')).toThrow(expect.objectContaining({code: 'NOT_FOUND'}));
    await expect(
      p.runShellCommand!('printf missing', undefined, undefined, {
        sessionId: 'missing-session',
        callId: 'missing-shell',
      }),
    ).rejects.toMatchObject({code: 'NOT_FOUND'});
  } finally {
    await h.cleanup();
  }
});

test('list() orders sessions by most recent message activity and rename() redacts/cleans titles', async () => {
  const h = await harness();
  try {
    const older = h.first.id;
    const newer = h.clientA.createSession().id;
    h.app.conversations.append(newer, {role: 'user', content: 'newer session first msg'}, 'committed');
    expect(h.clientA.listSessions().map(s => s.id)).toEqual([newer, older]);

    // Appending new activity to the older session moves it back to the top of /resume.
    h.app.conversations.append(older, {role: 'user', content: 'resumed follow up'}, 'committed');
    expect(h.clientA.listSessions().map(s => s.id)).toEqual([older, newer]);

    h.app.redactor.register('secret-token-value');
    expect(h.app.conversations.rename(older, '  secret-token-value\tline\nbreak\x07title  ')).toBe(true);
    expect(h.clientA.listSessions()[0]?.title).toBe('[REDACTED] line break title');
    expect(h.app.conversations.get(older)?.title).toBe('[REDACTED] line break title');

    // Whitespace/control-only titles clear to NULL and fall back to the first user prompt.
    expect(h.app.conversations.rename(older, '   \n\t\x07  ')).toBe(true);
    expect(h.app.db.query('SELECT title FROM conversations WHERE id=?').get(older)).toEqual({title: null});
    expect(h.clientA.listSessions()[0]?.title).toBe('same title');
    expect(h.app.conversations.get(older)?.title).toBe('same title');

    // Legacy empty-string titles stored in DB also fall back instead of returning "".
    h.app.db.query("UPDATE conversations SET title='   ' WHERE id=?").run(older);
    expect(h.clientA.listSessions()[0]?.title).toBe('same title');
    expect(h.app.conversations.get(older)?.title).toBe('same title');
  } finally {
    await h.cleanup();
  }
});
