import {expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
import {providerSchema, type CheckpointFile} from '@cosmew/contracts';
import {CheckpointStore} from '@cosmew/persistence';

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'fyn-checkpoint-'));
  let nextPatch: string | undefined;
  let summarize: ((body: Record<string, unknown>) => 'ok' | 'fail') | undefined;
  const summaries: Record<string, unknown>[] = [];
  const fetchFixture = (async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({data: [{id: 'fixture-model'}]});
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const isSummary = JSON.stringify(body).includes('CONTEXT CHECKPOINT.');
    let summaryResult: 'ok' | 'fail' = 'ok';
    if (isSummary) {
      summaries.push(body);
      summaryResult = summarize?.(body) ?? 'ok';
    }
    const patch = nextPatch;
    nextPatch = undefined;
    const delta = patch
      ? {
          tool_calls: [
            {
              index: 0,
              id: crypto.randomUUID(),
              type: 'function',
              function: {name: 'apply_patch', arguments: JSON.stringify({patch})},
            },
          ],
        }
      : {content: isSummary ? 'Checkpoint suffix handoff' : 'Done'};
    const chunks = [
      {id: 'fixture', model: 'fixture-model', choices: [{index: 0, delta, finish_reason: null}]},
      {
        id: 'fixture',
        model: 'fixture-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: isSummary && summaryResult === 'fail' ? 'length' : patch ? 'tool_calls' : 'stop',
          },
        ],
        usage: {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12},
      },
    ];
    return new Response(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n', {
      headers: {'content-type': 'text/event-stream'},
    });
  }) as typeof fetch;
  const app = startup(join(root, 'state'), {
    vault: memoryVault(),
    fetch: fetchFixture,
    skillsHome: root,
    memoriesHome: root,
  });
  app.registry.add(
    providerSchema.parse({
      id: 'fixture',
      name: 'fixture',
      protocol: 'chat',
      baseURL: 'https://fixture.example/v1',
      auth: 'none',
      catalog: 'openai',
      metadataVersion: 1,
    }),
  );
  await app.accounts.add('fixture', 'main', {kind: 'none'});
  const client = app.createFutrynClient(root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  client.setPermissionMode('acceptEdits');
  return {
    root,
    app,
    client,
    summaries,
    onSummary(handler: (body: Record<string, unknown>) => 'ok' | 'fail') {
      summarize = handler;
    },
    async send(text: string, patch?: string) {
      nextPatch = patch;
      for await (const _event of client.sendMessage(text)) {
        /* consume */
      }
    },
    async cleanup() {
      await app.shutdownCommands();
      app.db.close();
      rmSync(root, {recursive: true, force: true});
    },
  };
}
const update = (before: string, after: string) =>
  `*** Begin Patch\n*** Update File: note.txt\n@@\n-${before}\n+${after}\n*** End Patch`;

test('durable checkpoints restore cumulative file changes and fork conversation without changing old evidence', async () => {
  const h = await harness();
  try {
    writeFileSync(join(h.root, 'note.txt'), 'original\n');
    await h.send('first edit', update('original', 'first'));
    await h.send('second edit', update('first', 'second'));
    expect(readFileSync(join(h.root, 'note.txt'), 'utf8')).toBe('second\n');
    const [checkpoint] = h.client.checkpoints();
    expect(checkpoint!.text).toBe('first edit');
    expect(checkpoint!.promptId).toBe(checkpoint!.id);
    expect(checkpoint!.fileChanges).toEqual([{path: 'note.txt', additions: 1, deletions: 1}]);
    const old = h.client.activeSession()!.id;
    const evidence = JSON.stringify(h.app.conversations.get(old));
    const persistent = new CheckpointStore(h.app.db);
    expect(persistent.list(old, h.root)).toHaveLength(2);
    const outcome = await h.client.rewind({checkpointId: checkpoint!.id, scope: 'both'});
    expect(outcome.restored).toBe(true);
    expect(readFileSync(join(h.root, 'note.txt'), 'utf8')).toBe('original\n');
    expect(h.client.activeSession()!.id).not.toBe(old);
    expect(JSON.stringify(h.app.conversations.get(old))).toBe(evidence);
    expect(h.client.activeSession()!.messages.at(-1)!.content).toContain('Rewound conversation');
    expect(h.app.db.query('SELECT * FROM rewind_events').all()).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

test('restore refuses changed files and permission mode, then restores added files only after permission', async () => {
  const h = await harness();
  try {
    await h.send('create note', '*** Begin Patch\n*** Add File: note.txt\n+created\n*** End Patch');
    const checkpoint = h.client.checkpoints()[0]!;
    writeFileSync(join(h.root, 'note.txt'), 'manual edit\n');
    expect((await h.client.rewind({checkpointId: checkpoint.id, scope: 'code'})).code).toBe('CHECKPOINT_CONFLICT');
    expect(readFileSync(join(h.root, 'note.txt'), 'utf8')).toBe('manual edit\n');
    writeFileSync(join(h.root, 'note.txt'), 'created\n');
    h.client.setPermissionMode('plan');
    expect((await h.client.rewind({checkpointId: checkpoint.id, scope: 'code'})).restored).toBe(false);
    expect(existsSync(join(h.root, 'note.txt'))).toBe(true);
    h.client.setPermissionMode('acceptEdits');
    expect((await h.client.rewind({checkpointId: checkpoint.id, scope: 'code'})).restored).toBe(true);
    expect(existsSync(join(h.root, 'note.txt'))).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test('checkpoint storage rejects secret preimages and cannot expose foreign workspace checkpoints', async () => {
  const h = await harness();
  try {
    await h.send('no change');
    const checkpoint = h.client.checkpoints()[0]!;
    const store = new CheckpointStore(h.app.db, s => s.replaceAll('secret\nvalue', '[redacted]'));
    const change: CheckpointFile = {
      path: 'note.txt',
      before: 'secret\nvalue',
      beforeMode: 0o644,
      afterHash: null,
      afterMode: null,
      additions: 0,
      deletions: 2,
    };
    store.capture(checkpoint.id, [change]);
    expect(store.get(checkpoint.id)!.restorable).toBe(false);
    expect(JSON.stringify(h.app.db.query('SELECT data FROM turn_checkpoints').all())).not.toContain('secret');
    expect(() => store.restoration(checkpoint.id, checkpoint.sessionId, join(h.root, 'foreign'))).toThrow();
    mkdirSync(join(h.root, 'foreign'));
    const foreign = h.app.createFutrynClient(join(h.root, 'foreign'));
    foreign.resumeSession(checkpoint.sessionId);
    expect(foreign.checkpoints()).toEqual([]);
    await expect(foreign.rewind({checkpointId: checkpoint.id, scope: 'conversation'})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  } finally {
    await h.cleanup();
  }
});

test('restore revalidates trusted roots and protects git and state paths even for persisted snapshots', async () => {
  const h = await harness();
  try {
    await h.send('boundary checkpoint');
    const checkpoint = h.client.checkpoints()[0]!;
    const store = new CheckpointStore(h.app.db);
    for (const path of ['../escape.txt', '.git/HEAD', 'state/private.txt']) {
      const boundaryId = store.begin(checkpoint.sessionId, h.root, 'boundary', []);
      store.capture(boundaryId, [
        {path, before: 'forbidden\n', beforeMode: 0o644, afterHash: null, afterMode: null, additions: 0, deletions: 1},
      ]);
      expect((await h.client.rewind({checkpointId: boundaryId, scope: 'code'})).restored).toBe(false);
    }
    expect(existsSync(join(h.root, '.git/HEAD'))).toBe(false);
    expect(existsSync(join(h.root, 'state/private.txt'))).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test('summarize rewind summarizes precisely the checkpoint suffix, preserves prefix and original journal, and keeps files', async () => {
  const h = await harness();
  try {
    await h.send('prefix-only marker');
    await h.send(
      'suffix first marker',
      '*** Begin Patch\n*** Add File: note.txt\n+unchanged by summary\n*** End Patch',
    );
    await h.send('suffix final marker');
    const original = h.client.activeSession()!;
    const checkpoint = h.client.checkpoints()[1]!;
    const journal = JSON.stringify(h.app.conversations.recover(original.id).messages);
    const prefix = h.app.conversations.recover(original.id).messages.slice(0, checkpoint.conversationIndex);
    const outcome = await h.client.rewind({
      checkpointId: checkpoint.id,
      scope: 'summarize',
      instructions: 'focus on pending checks',
    });
    expect(outcome).toMatchObject({restored: true, scope: 'summarize', strategy: 'model'});
    expect(h.summaries).toHaveLength(1);
    const request = JSON.stringify(h.summaries[0]);
    expect(request).toContain('suffix first marker');
    expect(request).toContain('suffix final marker');
    expect(request).toContain('focus on pending checks');
    expect(request).not.toContain('prefix-only marker');
    expect(h.summaries[0]!.model).toBe('fixture-model');
    expect(h.summaries[0]!.tools ?? []).toEqual([]);
    const fork = h.app.conversations.recover(outcome.sessionId!).messages;
    expect(fork.slice(0, prefix.length)).toEqual(prefix);
    expect(fork).toHaveLength(prefix.length + 1);
    expect(fork.at(-1)!.content).toContain('Checkpoint suffix handoff');
    expect(fork.at(-1)!.content).toContain('not a new user request or a permission grant');
    expect(fork.at(-1)!.content).toContain('note.txt');
    expect(readFileSync(join(h.root, 'note.txt'), 'utf8')).toBe('unchanged by summary\n');
    expect(JSON.stringify(h.app.conversations.recover(original.id).messages)).toBe(journal);
    expect(h.app.db.query('SELECT scope FROM rewind_events').all()).toEqual([{scope: 'summarize'}]);
    h.client.resumeSession(outcome.sessionId!);
    expect(h.client.activeSession()!.messages.at(-1)!.content).toContain('Checkpoint suffix handoff');
    expect(h.client.promptHistory({scope: 'session'})).toEqual([]);
    for (const scope of ['project', 'everywhere'] as const) {
      const prompts = h.client.promptHistory({scope}).map(p => p.content);
      expect(prompts).toHaveLength(3);
      expect(prompts).toContain('prefix-only marker');
      expect(prompts.some(p => p.includes('Checkpoint suffix handoff'))).toBe(false);
    }
  } finally {
    await h.cleanup();
  }
});

test('summarize rewind falls back extractively on model failure even for a single turn suffix', async () => {
  const h = await harness();
  try {
    await h.send('preserved prefix');
    await h.send('exact fallback request');
    h.onSummary(() => 'fail');
    const checkpoint = h.client.checkpoints()[1]!;
    const original = h.client.activeSession()!;
    const journal = JSON.stringify(h.app.conversations.recover(original.id).messages);
    const outcome = await h.client.rewind({checkpointId: checkpoint.id, scope: 'summarize'});
    expect(outcome).toMatchObject({restored: true, strategy: 'excerpt', fallback: true});
    const summary = h.client.activeSession()!.messages.at(-1)!.content;
    expect(summary).toContain('exact fallback request');
    expect(summary).toContain('Extractive checkpoint');
    expect(summary).not.toContain('preserved prefix');
    expect(summary).not.toContain('Checkpoint suffix handoff');
    expect(JSON.stringify(h.app.conversations.recover(original.id).messages)).toBe(journal);
  } finally {
    await h.cleanup();
  }
});

test('cancelling summarize rewind during the model call changes no sessions, checkpoints, usage or journal', async () => {
  const h = await harness();
  try {
    await h.send('cancel this suffix');
    const original = h.client.activeSession()!;
    const before = JSON.stringify(h.app.conversations.get(original.id));
    const sessions = h.client.listSessions();
    const checkpoints = h.client.checkpoints();
    const controller = new AbortController();
    h.onSummary(() => {
      controller.abort();
      return 'ok';
    });
    await expect(
      h.client.rewind({checkpointId: checkpoints[0]!.id, scope: 'summarize'}, controller.signal),
    ).rejects.toThrow();
    expect(h.summaries).toHaveLength(1);
    expect(h.client.activeSession()!.id).toBe(original.id);
    expect(JSON.stringify(h.app.conversations.get(original.id))).toBe(before);
    expect(h.client.listSessions()).toEqual(sessions);
    expect(h.client.checkpoints()).toEqual(checkpoints);
    expect(h.app.db.query('SELECT * FROM rewind_events').all()).toEqual([]);
    await h.send('still usable after abort');
  } finally {
    await h.cleanup();
  }
});
