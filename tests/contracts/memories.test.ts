import {afterEach, expect, spyOn, test} from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as persistence from '@cosmew/persistence';
import {Redactor, SessionGrants} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, ToolDispatcher} from '@cosmew/tools';
import * as fs from 'node:fs';
import {WorkspaceRoot} from '@cosmew/workspace';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-memories-')));
  roots.push(root);
  const state = join(root, 'state'),
    project = join(root, 'project');
  mkdirSync(state);
  mkdirSync(project);
  const redactor = new Redactor();
  const store = new persistence.FileMemories(state, project, text => redactor.text(text));
  return {root, state, project, store, redactor};
}
const entry = {
  name: 'preference',
  description: 'Use Vietnamese',
  type: 'user' as const,
  content: 'User prefers Vietnamese.',
};
test('private Markdown memories CRUD updates the index without duplicates', () => {
  expect(persistence).toHaveProperty('FileMemories');
  const {store} = fixture();
  expect(store.list()).toEqual([]);
  store.write(entry);
  expect(store.read(entry.name)).toContain('type: user');
  expect(store.list()).toMatchObject([{name: entry.name, description: entry.description, type: entry.type}]);
  store.write({...entry, description: 'Updated'});
  expect(readFileSync(join(store.directory, 'MEMORY.md'), 'utf8')).toBe('- [preference](preference.md) — Updated\n');
  expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(store.directory, 'preference.md')).mode & 0o777).toBe(0o600);
  store.delete(entry.name);
  expect(store.list()).toEqual([]);
  expect(store.context()).toBe('');
});
test('invalid names, secrets and size limits fail before durable writes', () => {
  const {store, redactor} = fixture();
  redactor.register('fixture-secret-value');
  redactor.register('quoted\"credential\\value');
  for (const name of ['../escape', '/root', 'MEMORY', 'memory', 'a.md', 'with space', 'a\\b', 'a'.repeat(65)])
    expect(() => store.write({...entry, name})).toThrow();
  for (const content of [
    'fixture-secret-value',
    'quoted\"credential\\value',
    'sk-secret-example',
    'Bearer private-value',
    'x'.repeat(16384),
  ])
    expect(() => store.write({...entry, content})).toThrow();
  expect(store.list()).toEqual([]);
});
test('symlink files and parent directories are rejected; canonical workspaces isolate storage', () => {
  const {store, root, state, project, redactor} = fixture();
  store.write(entry);
  const other = join(root, 'other');
  mkdirSync(other);
  expect(new persistence.FileMemories(state, other, t => redactor.text(t)).directory).not.toBe(store.directory);
  const alias = join(root, 'alias');
  symlinkSync(project, alias);
  expect(new persistence.FileMemories(state, alias, t => redactor.text(t)).directory).toBe(store.directory);
  rmSync(join(store.directory, 'preference.md'));
  symlinkSync(join(root, 'outside'), join(store.directory, 'preference.md'));
  expect(() => store.read(entry.name)).toThrow();
  expect(() => store.write(entry)).toThrow();
  expect(() => store.delete(entry.name)).toThrow();
  rmSync(join(state, 'projects'), {recursive: true});
  symlinkSync(other, join(state, 'projects'));
  expect(() => store.write(entry)).toThrow();
});
test('index context has a data label, stale-evidence reminder and both truncation bounds', () => {
  const {store} = fixture();
  store.write(entry);
  const index = join(store.directory, 'MEMORY.md');
  expect(store.context()).toContain('untrusted');
  expect(store.context()).toContain('memory read');
  writeFileSync(index, Array.from({length: 201}, (_, n) => `line ${n}`).join('\n'));
  expect(store.context()).toContain('truncated');
  expect(store.context()).not.toContain('line 200');
  writeFileSync(index, 'é'.repeat(14000));
  expect(store.context()).toContain('truncated');
  expect(Buffer.byteLength(store.context())).toBeLessThan(26000);
});
test('memory dispatcher state operations are audited, redacted, never request filesystem approval', async () => {
  const {store, project, redactor} = fixture();
  const audit: string[] = [];
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(project),
    memories: store,
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    grants: new SessionGrants(),
    redact: t => redactor.text(t),
    approve: async request => {
      expect(request.capability).toBe('agent.state.write');
      return 'once'; // Normal edit policy approves without a UI prompt.
    },
    audit: r => audit.push(r.phase),
  });
  const invoke = (input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name: 'memory', input});
  expect((await invoke({action: 'write', ...entry})).status).toBe('ok');
  expect((await invoke({action: 'read', name: entry.name})).content).toContain(entry.content);
  expect((await invoke({action: 'list'})).content).toContain(entry.description);
  expect((await invoke({action: 'write', ...entry, content: 'sk-private-fixture'})).status).toBe('error');
  expect((await invoke({action: 'delete', name: entry.name})).status).toBe('ok');
  expect(audit.filter(p => p === 'requested')).toHaveLength(5);
  expect(audit).toContain('decided');
  expect(audit.filter(p => p === 'completed')).toHaveLength(5);
});

for (const restriction of ['read-only', 'plan', 'analysisOnly'] as const)
  test(`memory ${restriction} refuses mutations but permits list/read`, async () => {
    const {store, project} = fixture();
    store.write(entry);
    const before = readFileSync(join(store.directory, 'preference.md'), 'utf8');
    const index = readFileSync(join(store.directory, 'MEMORY.md'), 'utf8');
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(project),
      memories: store,
      grants: new SessionGrants(),
      sandbox: () => ({
        ...DEFAULT_SANDBOX_CONFIG,
        readOnly: restriction === 'read-only',
        permissionMode: restriction === 'plan' ? 'plan' : 'default',
      }),
      analysisOnly: () => restriction === 'analysisOnly',
      redact: t => t,
      approve: async () => {
        throw new Error('unexpected prompt');
      },
    });
    const invoke = (input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name: 'memory', input});
    for (const input of [
      {action: 'write', ...entry, content: 'changed'},
      {action: 'delete', name: entry.name},
    ]) {
      const result = await invoke(input);
      expect(result.status).toBe('denied');
      expect(result.content).toContain('Nothing was written');
      expect(readFileSync(join(store.directory, 'preference.md'), 'utf8')).toBe(before);
      expect(readFileSync(join(store.directory, 'MEMORY.md'), 'utf8')).toBe(index);
    }
    expect((await invoke({action: 'list'})).status).toBe('ok');
    expect((await invoke({action: 'read', name: entry.name})).content).toContain(entry.content);
  });

test('memory mutation rechecks analysis mode after approval and cancellation never writes', async () => {
  const {store, project} = fixture();
  let analysis = false;
  const controller = new AbortController();
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(project),
    memories: store,
    grants: new SessionGrants(),
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    analysisOnly: () => analysis,
    redact: t => t,
    approve: async () => {
      analysis = true;
      return 'once';
    },
  });
  const call = () => ({id: crypto.randomUUID(), name: 'memory', input: {action: 'write', ...entry}});
  expect((await dispatcher.invoke(call())).status).toBe('denied');
  expect(store.list()).toEqual([]);
  analysis = false;
  controller.abort();
  await expect(dispatcher.invoke(call(), controller.signal)).rejects.toThrow();
  expect(store.list()).toEqual([]);
});

test('16 KiB includes frontmatter, aggregate bytes and count are enforced before update', () => {
  const {store} = fixture();
  store.write(entry);
  const header = store.read(entry.name).slice(0, -entry.content.length - 1);
  store.write({...entry, content: 'x'.repeat(16384 - Buffer.byteLength(header) - 1)});
  expect(statSync(join(store.directory, 'preference.md')).size).toBe(16384);
  expect(() => store.write({...entry, content: 'x'.repeat(16384 - Buffer.byteLength(header))})).toThrow();
  const text = (name: string, content: string) =>
    `---\nname: ${name}\ndescription: Fixture\ntype: reference\n---\n${content}`;
  for (let n = 0; n < 65; n++) writeFileSync(join(store.directory, `f${n}.md`), text(`f${n}`, 'x'.repeat(16000)));
  expect(() => store.write(entry)).toThrow();
  for (let n = 0; n < 65; n++) rmSync(join(store.directory, `f${n}.md`));
  for (let n = 0; n < 255; n++) writeFileSync(join(store.directory, `f${n}.md`), text(`f${n}`, 'short'));
  expect(() => store.write({...entry, name: 'extra'})).toThrow();
  expect(store.read(entry.name).length).toBe(16384);
});

test('hardlinked memories and symlinked index never overwrite external files', () => {
  const {store, root} = fixture();
  store.write(entry);
  const index = join(store.directory, 'MEMORY.md'),
    outside = join(root, 'outside');
  writeFileSync(outside, 'unchanged');
  rmSync(index);
  symlinkSync(outside, index);
  expect(() => store.write({...entry, content: 'changed'})).toThrow();
  expect(() => store.delete(entry.name)).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('unchanged');
  expect(readFileSync(join(store.directory, 'preference.md'), 'utf8')).toContain(entry.content);
  expect(() => store.read(entry.name)).toThrow(); // Usage writes also fail closed on an unsafe index.
});

test('hardlinks and state roots in the repository are refused', () => {
  const {store, root, project, redactor} = fixture();
  store.write(entry);
  const outside = join(root, 'hardlink');
  fs.linkSync(join(store.directory, 'preference.md'), outside);
  expect(() => store.read(entry.name)).toThrow();
  expect(() => store.write(entry)).toThrow();
  expect(() => store.delete(entry.name)).toThrow();
  const inRepo = join(project, 'state');
  mkdirSync(inRepo);
  expect(() => new persistence.FileMemories(inRepo, project, t => redactor.text(t))).toThrow();
});

test('directory swap during a write cannot redirect the temp file or final rename', () => {
  const {store, root} = fixture();
  store.write(entry);
  const moved = store.directory + '-moved',
    outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'preference.md'), 'outside unchanged');
  const original = fs.writeFileSync;
  let swapped = false;
  const hook = spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
    if (!swapped && typeof args[0] === 'number') {
      swapped = true;
      fs.renameSync(store.directory, moved);
      symlinkSync(outside, store.directory);
    }
    return original(...args);
  }) as typeof fs.writeFileSync);
  try {
    store.write({...entry, content: 'updated in pinned directory'});
  } finally {
    hook.mockRestore();
  }
  expect(swapped).toBe(true);
  expect(readFileSync(join(outside, 'preference.md'), 'utf8')).toBe('outside unchanged');
  expect(readFileSync(join(moved, 'preference.md'), 'utf8')).toContain('updated in pinned directory');
  expect(readFileSync(join(moved, 'MEMORY.md'), 'utf8')).toContain('preference.md');
  expect(() => store.read(entry.name)).toThrow();
});

test('user-edited scalar frontmatter supports reordered fields and rejects duplicate authority', () => {
  const {store} = fixture();
  store.write(entry);
  const path = join(store.directory, 'preference.md');
  writeFileSync(path, "---\ntype: \"user\"\ndescription: 'User''s preference'\nname: preference\n---\nDetails");
  expect(store.list()).toMatchObject([{name: 'preference', description: "User's preference", type: 'user'}]);
  writeFileSync(path, '---\nname: preference\nname: other\ndescription: Duplicate\ntype: user\n---\nDetails');
  expect(() => store.list()).toThrow();
});

test('reads persist usage atomically, while index/list do not count; writes preserve counts, delete clears them', () => {
  const {store} = fixture();
  store.write(entry);
  expect(store.list()[0]).toMatchObject({usage_count: 0, last_usage: null, unused: false});
  store.context();
  store.list();
  store.read(entry.name);
  store.read(entry.name);
  expect(store.list()[0]).toMatchObject({usage_count: 2, last_usage: expect.any(String)});
  store.write({...entry, description: 'new description'});
  expect(store.list()[0]!.usage_count).toBe(2);
  const usage = join(store.directory, '.usage.json');
  expect(statSync(usage).mode & 0o777).toBe(0o600);
  store.delete(entry.name);
  store.write(entry);
  expect(store.list()[0]!.usage_count).toBe(0);
});

test('oversized index selects most used then newest without changing disk; old notes are only flagged', () => {
  const {store} = fixture();
  store.write({...entry, name: 'aaa'});
  store.write({...entry, name: 'zzz'});
  store.read('zzz');
  expect(store.context().indexOf('aaa.md')).toBeLessThan(store.context().indexOf('zzz.md')); // No reordering below the budget.
  const index = join(store.directory, 'MEMORY.md');
  const text =
    '- [aaa](aaa.md) — first\n' +
    Array.from({length: 199}, () => 'padding').join('\n') +
    '\n- [zzz](zzz.md) — useful\n';
  writeFileSync(index, text);
  const context = store.context();
  expect(context.indexOf('zzz.md')).toBeLessThan(context.indexOf('aaa.md'));
  expect(context).toContain('truncated');
  expect(readFileSync(index, 'utf8')).toBe(text);
  const usagePath = join(store.directory, '.usage.json');
  const usage = JSON.parse(readFileSync(usagePath, 'utf8'));
  usage.entries.zzz.last_usage = '2000-01-01T00:00:00.000Z';
  writeFileSync(usagePath, JSON.stringify(usage));
  expect(store.list().find(e => e.name === 'zzz')!.unused).toBe(true);
  expect(store.read('zzz')).toContain(entry.content);
  expect(store.list().find(e => e.name === 'zzz')!.unused).toBe(false);
});

test('usage metadata cannot follow links or escape quotas; failed read does not change a counter', () => {
  const {store, root} = fixture();
  store.write(entry);
  const usagePath = join(store.directory, '.usage.json'),
    outside = join(root, 'outside-usage');
  const original = readFileSync(usagePath, 'utf8');
  writeFileSync(outside, original);
  rmSync(usagePath);
  symlinkSync(outside, usagePath);
  expect(() => store.read(entry.name)).toThrow();
  expect(() => store.write(entry)).toThrow();
  expect(() => store.delete(entry.name)).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe(original);
  rmSync(usagePath);
  writeFileSync(usagePath, 'x'.repeat(65537));
  expect(() => store.read(entry.name)).toThrow();
  writeFileSync(usagePath, original);
  expect(() => store.read('missing')).toThrow();
  expect(store.list()[0]!.usage_count).toBe(0);
});

test('30-day stale boundary is deterministic; legacy files use file modification time', () => {
  const {state, project, store} = fixture();
  store.write(entry);
  let now = Date.parse('2040-01-31T00:00:00Z');
  const timed = new persistence.FileMemories(state, project, t => t, {now: () => now});
  timed.write({...entry, name: 'recent'});
  timed.read('recent');
  const usagePath = join(timed.directory, '.usage.json'),
    usage = JSON.parse(readFileSync(usagePath, 'utf8'));
  usage.entries.recent.last_usage = new Date(now - 30 * 86400000).toISOString();
  writeFileSync(usagePath, JSON.stringify(usage));
  expect(timed.list().find(e => e.name === 'recent')!.unused).toBe(false);
  now++;
  expect(timed.list().find(e => e.name === 'recent')!.unused).toBe(true);
  rmSync(usagePath);
  expect(store.list()[0]).toMatchObject({usage_count: 0, last_usage: null, unused: false});
  expect(store.list()[0]!.updated_at).toBe(
    statSync(join(store.directory, `${store.list()[0]!.name}.md`)).mtime.toISOString(),
  );
});

test('recency breaks usage ties when the 25 KB index budget is exceeded', () => {
  const {store} = fixture();
  store.write({...entry, name: 'aaa'});
  store.write({...entry, name: 'zzz'});
  const usagePath = join(store.directory, '.usage.json'),
    state = JSON.parse(readFileSync(usagePath, 'utf8'));
  for (const name of ['aaa', 'zzz']) state.entries[name].usage_count = 3;
  state.entries.aaa.last_usage = new Date(Date.now() - 3600000).toISOString();
  state.entries.zzz.last_usage = new Date().toISOString();
  writeFileSync(usagePath, JSON.stringify(state));
  const index = join(store.directory, 'MEMORY.md');
  const text = '- [aaa](aaa.md) — older\n' + 'é'.repeat(13000) + '\n- [zzz](zzz.md) — recent\n';
  writeFileSync(index, text);
  const context = store.context();
  expect(context.indexOf('zzz.md')).toBeLessThan(context.indexOf('aaa.md'));
  expect(Buffer.byteLength(context)).toBeLessThan(26000);
  expect(context).not.toContain('�');
  expect(readFileSync(index, 'utf8')).toBe(text);
});

test('legacy usage lookup never treats inherited object keys as a record', () => {
  const {store} = fixture();
  store.write({...entry, name: 'constructor'});
  rmSync(join(store.directory, '.usage.json'));
  expect(store.list()[0]).toMatchObject({name: 'constructor', usage_count: 0, last_usage: null, unused: false});
  store.read('constructor');
  expect(store.list()[0]!.usage_count).toBe(1);
});

test('index redaction precedes byte truncation so a credential crossing the boundary cannot leak a prefix', () => {
  const {store, redactor} = fixture();
  store.write(entry);
  redactor.register('memorized-credential-that-must-not-leak');
  writeFileSync(join(store.directory, 'MEMORY.md'), 'x'.repeat(24990) + 'memorized-credential-that-must-not-leak');
  const context = store.context();
  expect(context).not.toContain('memorized-');
  expect(context).toContain('[REDACTED]');
});

test('redaction expansion obeys the context byte budget and reports truncation', () => {
  const {store, redactor} = fixture();
  store.write(entry);
  redactor.register('abc');
  writeFileSync(join(store.directory, 'MEMORY.md'), 'abc '.repeat(4000));
  const context = store.context();
  expect(Buffer.byteLength(context)).toBeLessThan(26000);
  expect(context).toContain('truncated');
});
