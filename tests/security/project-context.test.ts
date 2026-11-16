import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, statSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ProjectContextLoader, WorkspaceRoot} from '@futryn/workspace';
import {ToolDispatcher} from '@futryn/tools';
import {SessionGrants, Redactor, evaluateRead} from '@futryn/security';
import {FutrynError, type ProjectContextOptions} from '@futryn/contracts';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function setup(options: ProjectContextOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hannes-instructions-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const state = join(root, 'state');
  mkdirSync(state);
  const workspace = new WorkspaceRoot(root),
    grants = new SessionGrants(),
    redactor = new Redactor();
  let prompts = 0;
  const dispatcher = new ToolDispatcher({
    workspace,
    grants,
    stateDirectory: join(workspace.root, 'state'),
    approve: async () => {
      prompts++;
      return 'deny';
    },
    redact: (text, incomplete) => (incomplete ? redactor.stream().push(text) : redactor.text(text)),
  });
  return {
    root,
    state,
    workspace,
    grants,
    redactor,
    dispatcher,
    loader: new ProjectContextLoader(workspace, {read: (p, b, s) => dispatcher.readInstruction(p, b, s)}, options),
    prompts: () => prompts,
  };
}
const docs = (content: string) =>
  JSON.parse(content.slice(content.indexOf('\n') + 1)).instructions as {path: string; content: string; hash: string}[];

test('root instructions load with source hashes; same-size/same-mtime edits refresh', async () => {
  const c = setup();
  writeFileSync(join(c.root, 'AGENTS.md'), 'Architecture: RULE_A');
  const before = statSync(join(c.root, 'AGENTS.md'));
  const a = await c.loader.load();
  expect(a.sources[0]?.path).toBe('AGENTS.md');
  expect(docs(a.content)[0]?.content).toBe('Architecture: RULE_A');
  expect(a.sources[0]?.hash).toBe(createHash('sha256').update('Architecture: RULE_A').digest('hex'));
  const same = await c.loader.load();
  expect(same.fingerprint).toBe(a.fingerprint);
  writeFileSync(join(c.root, 'AGENTS.md'), 'Architecture: RULE_B');
  utimesSync(join(c.root, 'AGENTS.md'), before.atime, before.mtime);
  const b = await c.loader.load();
  expect(b.fingerprint).not.toBe(a.fingerprint);
  expect(b.content).toContain('RULE_B');
  expect(b.content).not.toContain('RULE_A');
  rmSync(join(c.root, 'AGENTS.md'));
  expect((await c.loader.load()).content).toBe('');
});

test('root-to-cwd precedence includes local overrides and excludes unrelated subtrees', async () => {
  const c = setup({workingDirectory: 'src/deep'});
  mkdirSync(join(c.root, 'src/deep'), {recursive: true});
  mkdirSync(join(c.root, 'other'));
  writeFileSync(join(c.root, 'AGENTS.md'), 'Root rule');
  writeFileSync(join(c.root, 'src/AGENTS.md'), 'Replaced rule');
  writeFileSync(join(c.root, 'src/AGENTS.override.md'), 'Local override');
  writeFileSync(join(c.root, 'src/deep/AGENTS.md'), 'Deep rule');
  writeFileSync(join(c.root, 'other/AGENTS.md'), 'Unrelated');
  const result = await c.loader.load();
  expect(result.sources.map(s => s.path)).toEqual(['AGENTS.md', 'src/AGENTS.override.md', 'src/deep/AGENTS.md']);
  expect(docs(result.content).map(s => s.content)).toEqual(['Root rule', 'Local override', 'Deep rule']);
  writeFileSync(join(c.root, 'src/deep/AGENTS.override.md'), 'New deepest override');
  expect((await c.loader.load()).sources.at(-1)?.path).toBe('src/deep/AGENTS.override.md');
});

test('absent and empty projects work; an empty local override does not silently fall back', async () => {
  const c = setup();
  expect((await c.loader.load()).content).toBe('');
  writeFileSync(join(c.root, 'AGENTS.md'), 'Must not fall back');
  writeFileSync(join(c.root, 'AGENTS.override.md'), '  ');
  const result = await c.loader.load();
  expect(result.content).toBe('');
  expect(result.diagnostics[0]?.code).toBe('EMPTY_FILE');
});

test('complete rendered context fits its byte budget without broken UTF-8', async () => {
  const c = setup({maxBytes: 4096, maxFileBytes: 8192});
  writeFileSync(join(c.root, 'AGENTS.md'), '规则😃\n'.repeat(10000));
  const result = await c.loader.load();
  expect(result.sources).toHaveLength(1);
  expect(result.usedBytes).toBe(Buffer.byteLength(result.content));
  expect(result.usedBytes).toBeLessThanOrEqual(4096);
  expect(result.sources[0]?.truncated).toBe(true);
  expect(result.content).not.toContain('�');
  expect(result.diagnostics.some(d => d.code === 'TRUNCATED')).toBe(true);
  const source = docs(result.content)[0]!;
  expect(source.hash).toBe(createHash('sha256').update(source.content).digest('hex'));
  const disabled = setup({maxBytes: 0});
  writeFileSync(join(disabled.root, 'AGENTS.md'), 'Never read');
  expect((await disabled.loader.load()).sources).toHaveLength(0);
  expect(() => setup({maxBytes: 65537})).toThrow(FutrynError);
});

test.skipIf(process.platform === 'win32')(
  'escape/symlink/secret/state targets cannot bypass policy or prompt automatically',
  async () => {
    const c = setup();
    const outside = mkdtempSync(join(tmpdir(), 'hannes-outside-'));
    cleanup.push(() => rmSync(outside, {recursive: true, force: true}));
    writeFileSync(join(outside, 'AGENTS.md'), 'OUTSIDE_PRIVATE');
    symlinkSync(join(outside, 'AGENTS.md'), join(c.root, 'AGENTS.override.md'));
    writeFileSync(join(c.root, 'AGENTS.md'), 'Must not fall back');
    const denied = await c.loader.load();
    expect(denied.sources).toHaveLength(0);
    expect(denied.diagnostics[0]?.code).toBe('DENIED');
    expect(denied.content).not.toContain('OUTSIDE_PRIVATE');
    const escaped = new ProjectContextLoader(
      c.workspace,
      {read: (p, b, s) => c.dispatcher.readInstruction(p, b, s)},
      {workingDirectory: outside},
    );
    expect((await escaped.load()).diagnostics[0]?.code).toBe('WORKING_DIRECTORY_DENIED');
    symlinkSync(outside, join(c.root, 'escape'));
    const cwdLink = new ProjectContextLoader(
      c.workspace,
      {read: (p, b, s) => c.dispatcher.readInstruction(p, b, s)},
      {workingDirectory: 'escape'},
    );
    expect((await cwdLink.load()).sources).toHaveLength(0);
    rmSync(join(c.root, 'AGENTS.override.md'));
    rmSync(join(c.root, 'AGENTS.md'));
    writeFileSync(join(c.root, '.env'), 'PRIVATE_SECRET');
    symlinkSync('.env', join(c.root, 'AGENTS.md'));
    expect((await c.loader.load()).diagnostics[0]?.code).toBe('APPROVAL_REQUIRED');
    expect(c.prompts()).toBe(0);
    c.grants.grant('fs.read', join(c.workspace.root, '.env'));
    expect((await c.loader.load()).sources[0]?.canonicalPath).toBe('.env');
    c.grants.clear();
    expect((await c.loader.load()).content).toBe('');
    writeFileSync(join(c.state, 'AGENTS.md'), 'STATE_PRIVATE');
    c.grants.grant('fs.read', join(c.workspace.root, 'state/AGENTS.md'));
    const state = new ProjectContextLoader(
      c.workspace,
      {read: (p, b, s) => c.dispatcher.readInstruction(p, b, s)},
      {workingDirectory: 'state'},
    );
    expect((await state.load()).sources.some(s => s.path === 'state/AGENTS.md')).toBe(false);
  },
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'inaccessible files produce diagnostics rather than disappearing as missing',
  async () => {
    const c = setup();
    const file = join(c.root, 'AGENTS.md');
    writeFileSync(file, 'Unreadable');
    chmodSync(file, 0);
    try {
      expect((await c.loader.load()).diagnostics[0]?.code).toBe('UNREADABLE');
    } finally {
      chmodSync(file, 0o600);
    }
  },
);

test('binary/invalid UTF-8 are skipped and partial known secrets are withheld', async () => {
  const c = setup({maxFileBytes: 1024});
  writeFileSync(join(c.root, 'AGENTS.md'), Buffer.from([0, 1, 2]));
  expect((await c.loader.load()).diagnostics[0]?.code).toBe('BINARY_FILE');
  writeFileSync(join(c.root, 'AGENTS.md'), Buffer.from([0xff, 0xfe]));
  expect((await c.loader.load()).diagnostics[0]?.code).toBe('INVALID_UTF8');
  c.redactor.register('registered-private-secret-value');
  writeFileSync(join(c.root, 'AGENTS.md'), 'a'.repeat(1010) + 'registered-private-secret-value');
  const result = await c.loader.load();
  expect(result.content).not.toContain('registered-');
  expect(result.sources[0]?.truncated).toBe(true);
  const abort = new AbortController();
  abort.abort();
  await expect(c.loader.load(abort.signal)).rejects.toThrow();
});

test('state-directory denial uses canonical Windows separators and cannot be carved out by path spelling', () => {
  expect(
    evaluateRead('state/AGENTS.md', 'C:\\Work\\state\\AGENTS.md', {stateDirectory: 'c:\\work\\state'}).effect,
  ).toBe('deny');
  expect(
    evaluateRead('other/AGENTS.md', 'C:\\Work\\state-other\\AGENTS.md', {stateDirectory: 'C:/Work/state'}).effect,
  ).toBe('allow');
});

test.skipIf(process.platform === 'win32')(
  'canonical aliases deduplicate and permission revocation is rechecked before a read',
  async () => {
    const c = setup({workingDirectory: 'child'});
    mkdirSync(join(c.root, 'child'));
    writeFileSync(join(c.root, 'AGENTS.md'), 'ONE_CANONICAL_RULE');
    symlinkSync('../AGENTS.md', join(c.root, 'child/AGENTS.md'));
    const result = await c.loader.load();
    expect(result.sources).toHaveLength(1);
    expect(result.diagnostics.some(d => d.code === 'DUPLICATE_SOURCE')).toBe(true);
    rmSync(join(c.root, 'AGENTS.md'));
    writeFileSync(join(c.root, '.env'), 'Do not load after grant revocation');
    symlinkSync('.env', join(c.root, 'AGENTS.md'));
    const target = join(c.workspace.root, '.env');
    c.grants.grant('fs.read', target);
    const pending = c.dispatcher.readInstruction('AGENTS.md', 4096);
    c.grants.clear();
    expect(await pending).toMatchObject({status: 'denied', code: 'APPROVAL_REQUIRED'});
  },
);
