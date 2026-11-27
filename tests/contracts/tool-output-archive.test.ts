import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteToolOutputArchive} from '@cosmew/persistence';
import {WorkspaceRoot} from '@cosmew/workspace';
import {SessionGrants} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, ToolDispatcher} from '@cosmew/tools';

test('dispatcher archives redacted producer output and retrieves middle evidence without repeating execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-'));
  const db = new Database(':memory:');
  try {
    writeFileSync(
      join(dir, 'evidence.txt'),
      'start\n' + 'ordinary evidence\n'.repeat(1800) + 'MIDDLE_NEEDLE SECRET\n' + 'trailing\n'.repeat(1000),
    );
    const store = new SqliteToolOutputArchive(db);
    const grants = new SessionGrants();
    let session = 'session-a',
      policy = 'initial';
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(dir),
      grants,
      approve: async () => 'once',
      redact: s => s.replaceAll('SECRET', '[REDACTED]'),
      outputArchive: {store, scope: () => ({workspace: dir, session}), permissionContext: () => policy},
    });
    const result = await dispatcher.invoke({id: 'read-1', name: 'read', input: {path: 'evidence.txt', limit: 2000}});
    const id = result.content.match(/output_id=([\w-]+)/)?.[1];
    expect(id).toBeDefined();
    const page = await dispatcher.invoke({
      id: 'page',
      name: 'tool_output',
      input: {output_id: id, query: 'MIDDLE_NEEDLE'},
    });
    expect(page.status).toBe('ok');
    expect(page.content).toContain('MIDDLE_NEEDLE [REDACTED]');
    expect(page.content).not.toContain('SECRET');
    grants.clear();
    expect((await dispatcher.invoke({id: 'revoked', name: 'tool_output', input: {output_id: id}})).status).toBe(
      'denied',
    );
    policy = 'changed';
    session = 'session-b';
    expect((await dispatcher.invoke({id: 'cross', name: 'tool_output', input: {output_id: id}})).code).toBe(
      'OUTPUT_UNAVAILABLE',
    );
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('archive retention, UTF-8 cap, session budget and scoped missing handles', () => {
  const db = new Database(':memory:');
  let now = 1000000000;
  const store = new SqliteToolOutputArchive(db, () => now);
  const scope = {workspace: 'workspace', session: 'a'};
  const output = {
    content: '🙂'.repeat(300000),
    source: {tool: 'read', kind: 'read' as const, target: 'a', truncated: false},
    permissionContext: 'epoch',
    sourceTruncated: false,
  };
  try {
    const first = store.put(scope, output);
    const artifact = store.get(scope, first)!;
    expect(Buffer.byteLength(artifact.content)).toBe(1024 * 1024);
    expect(artifact.content).not.toContain('�');
    expect(artifact.sourceTruncated).toBe(true);
    expect(store.get({...scope, session: 'b'}, first)).toBeUndefined();
    expect(store.get({...scope, workspace: 'other'}, first)).toBeUndefined();
    for (let i = 0; i < 8; i++) store.put(scope, output);
    expect(store.get(scope, first)).toBeUndefined();
    const fresh = store.put(scope, {...output, content: 'fresh'});
    now += 7 * 24 * 60 * 60 * 1000 + 1;
    expect(store.get(scope, fresh)).toBeUndefined();
  } finally {
    db.close();
  }
});

test('command retrieval pages/searches redacted capture, audits and never re-executes; storage failure preserves success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-command-'));
  const db = new Database(':memory:');
  const store = new SqliteToolOutputArchive(db),
    grants = new SessionGrants();
  let runs = 0,
    context = 'rules',
    denied = false,
    replacement = false;
  const audits: {tool: string; phase: string}[] = [];
  const commands: import('@cosmew/contracts').CommandRuntime = {
    id: 'fixture-runtime',
    label: 'fixture',
    availability: () => ({ok: true}),
    run: async () => {
      runs++;
      return {
        kind: 'exited',
        exitCode: 0,
        signal: null,
        output: '🙂'.repeat(10000) + 'TARGET later-secret\n' + 'z'.repeat(50000),
        omittedBytes: 100,
        durationMs: 1,
      };
    },
  };
  const options: ConstructorParameters<typeof ToolDispatcher>[0] = {
    workspace: new WorkspaceRoot(dir),
    grants,
    commands,
    approve: async () => 'once',
    redact: text => (replacement ? text.replaceAll('later-secret', '[REDACTED]') : text),
    audit: record => audits.push(record),
    outputArchive: {
      store,
      scope: () => ({workspace: dir, session: 'a'}),
      permissionContext: () => context,
      policy: () => (denied ? 'deny' : 'allow'),
    },
  };
  try {
    const dispatcher = new ToolDispatcher(options);
    const result = await dispatcher.invoke({id: 'exec', name: 'exec_command', input: {cmd: 'fixture'}});
    const id = result.content.match(/output_id=([\w-]+)/)![1]!;
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(60000);
    expect(result.content.endsWith('use tool_output to retrieve archived evidence]')).toBe(true);
    replacement = true;
    const invoke = (input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name: 'tool_output', input});
    const page = await invoke({output_id: id, query: 'TARGET', limit: 40});
    expect(page.content).toContain('TARGET [REDACTED]');
    expect(page.content).toContain('"source_truncated":true');
    expect(page.content).not.toContain('later-secret');
    expect(runs).toBe(1);
    const utf = await invoke({output_id: id, offset: 400, limit: 7});
    expect(utf.content).not.toContain('�');
    const emojiStart = JSON.parse(utf.content.split('\n')[0]!).coverage.start;
    expect((await invoke({output_id: id, offset: emojiStart, limit: 1})).code).toBe('OUTPUT_PAGE_TOO_SMALL');
    expect(Buffer.byteLength(utf.content)).toBeLessThan(12288);
    const noMatch = await invoke({output_id: id, query: 'ABSENT'});
    expect(noMatch.content).toContain('"found":false');
    expect(noMatch.content).toContain('"next_offset":null');
    expect((await invoke({output_id: id, limit: 10001})).code).toBe('INVALID_INPUT');
    expect((await invoke({output_id: crypto.randomUUID()})).code).toBe('OUTPUT_UNAVAILABLE');
    expect(audits.filter(a => a.tool === 'tool_output').some(a => a.phase === 'decided')).toBe(true);
    denied = true;
    expect((await invoke({output_id: id})).status).toBe('denied');
    denied = false;
    context = 'new rules';
    expect((await invoke({output_id: id})).status).toBe('denied');
    const failedStore = {
      put() {
        throw new Error('disk full');
      },
      get: store.get.bind(store),
    };
    const resilient = new ToolDispatcher({...options, outputArchive: {...options.outputArchive!, store: failedStore}});
    const successful = await resilient.invoke({id: 'disk-full', name: 'exec_command', input: {cmd: 'fixture'}});
    expect(successful.status).toBe('ok');
    expect(successful.content).not.toContain('output_id=');
    expect(runs).toBe(2);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('source read policy is consulted again and denied producers never enter the archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-policy-'));
  const db = new Database(':memory:');
  try {
    writeFileSync(join(dir, 'a.txt'), 'evidence\n'.repeat(3000));
    const store = new SqliteToolOutputArchive(db);
    let readsDenied = false;
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(dir),
      grants: new SessionGrants(),
      approve: async () => 'once',
      redact: s => s,
      readPolicy: () => (readsDenied ? 'deny' : 'allow'),
      outputArchive: {store, scope: () => ({workspace: dir, session: 'a'}), permissionContext: () => 'rules'},
    });
    const first = await dispatcher.invoke({id: 'allowed', name: 'read', input: {path: 'a.txt'}});
    const id = first.content.match(/output_id=([\w-]+)/)![1]!;
    readsDenied = true;
    expect((await dispatcher.invoke({id: 'retrieval', name: 'tool_output', input: {output_id: id}})).status).toBe(
      'denied',
    );
    const denied = await dispatcher.invoke({id: 'denied', name: 'read', input: {path: 'a.txt'}});
    expect(denied.status).toBe('denied');
    expect(denied.content).not.toContain('output_id=');
    expect((db.query('SELECT count(*) AS count FROM tool_output_archive').get() as {count: number}).count).toBe(1);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('archive survives reopening SQLite without changing conversation schema version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-reopen-'));
  const path = join(dir, 'archive.sqlite'),
    scope = {workspace: 'workspace', session: 'a'};
  let db = new Database(path);
  try {
    db.exec('PRAGMA user_version=8');
    const id = new SqliteToolOutputArchive(db).put(scope, {
      content: 'durable captured evidence',
      source: {tool: 'read', kind: 'read', target: 'a.txt', truncated: false},
      permissionContext: 'epoch',
      sourceTruncated: false,
    });
    db.close();
    db = new Database(path);
    expect(new SqliteToolOutputArchive(db).get(scope, id)?.content).toBe('durable captured evidence');
    expect((db.query('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(8);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('archived MCP tool output is invalidated when the MCP server identity changes on reconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-mcp-id-'));
  const db = new Database(':memory:');
  try {
    const store = new SqliteToolOutputArchive(db);
    let identity = 'hub:srv:1';
    const grants = new SessionGrants();
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(dir),
      grants,
      sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode: 'default', readOnly: false}),
      approve: async () => 'session',
      redact: s => s,
      outputArchive: {store, scope: () => ({workspace: dir, session: 'a'}), permissionContext: () => 'rules'},
      mcp: {
        tools: () => [{name: 'mcp__srv__dump', description: 'dump', inputSchema: {type: 'object'}, identity}],
        call: async () => 'payload '.repeat(8000) + 'TAIL_MARKER',
      },
    });
    const captured = await dispatcher.invoke({id: 'call-1', name: 'mcp__srv__dump', input: {}});
    const id = captured.content.match(/output_id=([\w-]+)/)?.[1];
    expect(id).toBeDefined();

    const sameIdPage = await dispatcher.invoke({
      id: 'read-1',
      name: 'tool_output',
      input: {output_id: id, query: 'TAIL_MARKER'},
    });
    expect(sameIdPage.status).toBe('ok');
    expect(sameIdPage.content).toContain('TAIL_MARKER');

    // Server reconnect rotates identity -> archived retrieval must be refused.
    identity = 'hub:srv:2';
    const rotated = await dispatcher.invoke({id: 'read-2', name: 'tool_output', input: {output_id: id}});
    expect(rotated.status).toBe('denied');
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('new grant scopes and tool-rule changes during an approval cannot reuse stored authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-approval-')),
    db = new Database(':memory:');
  try {
    writeFileSync(join(dir, 'a.txt'), 'evidence\n'.repeat(3000));
    const store = new SqliteToolOutputArchive(db);
    let effect: 'allow' | 'ask' | 'deny' = 'ask';
    let prompts = 0;
    const options: ConstructorParameters<typeof ToolDispatcher>[0] = {
      workspace: new WorkspaceRoot(dir),
      grants: new SessionGrants(),
      approve: async () => {
        prompts++;
        effect = 'deny';
        return 'once';
      },
      redact: s => s,
      outputArchive: {
        store,
        scope: () => ({workspace: dir, session: 'a'}),
        permissionContext: () => 'rules',
        policy: () => effect,
      },
    };
    const dispatcher = new ToolDispatcher(options);
    const captured = await dispatcher.invoke({id: 'read', name: 'read', input: {path: 'a.txt'}});
    const id = captured.content.match(/output_id=([\w-]+)/)![1]!;
    const fresh = new ToolDispatcher({...options, grants: new SessionGrants()});
    expect((await fresh.invoke({id: 'restart', name: 'tool_output', input: {output_id: id}})).status).toBe('denied');
    expect(prompts).toBe(0);
    expect((await dispatcher.invoke({id: 'approval', name: 'tool_output', input: {output_id: id}})).status).toBe(
      'denied',
    );
    expect(prompts).toBe(1);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a once-approved secret capture cannot be authorized through a replacement safe symlink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-secret-source-')),
    db = new Database(':memory:');
  try {
    writeFileSync(join(dir, '.env'), 'ARCHIVED_PRIVATE_VALUE\n'.repeat(1500));
    writeFileSync(join(dir, 'safe.txt'), 'public file');
    let prompts = 0;
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(dir),
      grants: new SessionGrants(),
      approve: async () => {
        prompts++;
        return 'once';
      },
      redact: s => s,
      outputArchive: {
        store: new SqliteToolOutputArchive(db),
        scope: () => ({workspace: dir, session: 'a'}),
        permissionContext: () => 'constant',
      },
    });
    const captured = await dispatcher.invoke({id: 'capture', name: 'read', input: {path: '.env'}});
    const id = captured.content.match(/output_id=([\w-]+)/)![1]!;
    expect(prompts).toBe(1);
    unlinkSync(join(dir, '.env'));
    symlinkSync('safe.txt', join(dir, '.env'));
    const result = await dispatcher.invoke({id: 'retrieve', name: 'tool_output', input: {output_id: id}});
    expect(result.status).toBe('denied');
    expect(result.content).not.toContain('ARCHIVED_PRIVATE_VALUE');
    expect(prompts).toBe(1);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('allow-to-ask source policy changes during authorization invalidate archived reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-output-policy-race-')),
    db = new Database(':memory:');
  try {
    writeFileSync(join(dir, 'a.txt'), 'ARCHIVED_POLICY_EVIDENCE\n'.repeat(1500));
    let effect: 'allow' | 'ask' = 'allow',
      race = false,
      prompts = 0;
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(dir),
      grants: new SessionGrants(),
      approve: async () => {
        prompts++;
        return 'once';
      },
      redact: s => s,
      readPolicy: () => {
        if (race) {
          race = false;
          queueMicrotask(() => {
            effect = 'ask';
          });
        }
        return effect;
      },
      outputArchive: {
        store: new SqliteToolOutputArchive(db),
        scope: () => ({workspace: dir, session: 'a'}),
        permissionContext: () => 'constant',
      },
    });
    const captured = await dispatcher.invoke({id: 'capture', name: 'read', input: {path: 'a.txt'}});
    const id = captured.content.match(/output_id=([\w-]+)/)![1]!;
    race = true;
    const result = await dispatcher.invoke({id: 'retrieve', name: 'tool_output', input: {output_id: id}});
    expect(String(effect)).toBe('ask');
    expect(result.status).toBe('denied');
    expect(result.content).not.toContain('ARCHIVED_POLICY_EVIDENCE');
    expect(prompts).toBe(0);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

for (const change of ['symlink', 'remove'] as const)
  test(`source ${change} during authorization cannot release an archived read`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fyn-output-target-race-')),
      db = new Database(':memory:');
    try {
      writeFileSync(join(dir, 'a.txt'), 'ARCHIVED_TARGET_EVIDENCE\n'.repeat(1500));
      writeFileSync(join(dir, 'safe.txt'), 'public file');
      let race = false;
      const dispatcher = new ToolDispatcher({
        workspace: new WorkspaceRoot(dir),
        grants: new SessionGrants(),
        approve: async () => 'once',
        redact: s => s,
        readPolicy: () => {
          if (race) {
            race = false;
            queueMicrotask(() => {
              unlinkSync(join(dir, 'a.txt'));
              if (change === 'symlink') symlinkSync('safe.txt', join(dir, 'a.txt'));
            });
          }
          return 'allow';
        },
        outputArchive: {
          store: new SqliteToolOutputArchive(db),
          scope: () => ({workspace: dir, session: 'a'}),
          permissionContext: () => 'constant',
        },
      });
      const captured = await dispatcher.invoke({id: 'capture', name: 'read', input: {path: 'a.txt'}});
      const id = captured.content.match(/output_id=([\w-]+)/)![1]!;
      race = true;
      const result = await dispatcher.invoke({id: 'retrieve', name: 'tool_output', input: {output_id: id}});
      expect(result.status).toBe('denied');
      expect(result.content).not.toContain('ARCHIVED_TARGET_EVIDENCE');
    } finally {
      db.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });
