import {afterEach, expect, test} from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  realpathSync,
  mkdirSync,
  linkSync,
  renameSync,
  chmodSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {computeWorkspaceGitDiff, refreshWorkspaceGitDiff} from '@cosmew/workspace';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-base-')));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ['/usr/bin/git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      {cwd: root},
    );
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'note.txt'), 'initial\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return {root, git};
}
test('real Git branch base includes branch commits plus index/worktree/untracked, Current uses session preimages', async () => {
  const {root, git} = repository();
  git('branch', 'feature');
  git('symbolic-ref', 'HEAD', 'refs/heads/feature');
  writeFileSync(join(root, 'note.txt'), 'committed\n');
  git('add', '.');
  git('commit', '-qm', 'feature');
  writeFileSync(join(root, 'note.txt'), 'staged\n');
  git('add', '.');
  writeFileSync(join(root, 'note.txt'), 'working\n');
  writeFileSync(join(root, 'new.txt'), 'new\n');
  const beforeIndex = readFileSync(join(root, '.git/index'));
  const branch = await refreshWorkspaceGitDiff(root, {base: 'branch'});
  const uncommitted = computeWorkspaceGitDiff(root, {base: 'uncommitted'});
  const current = computeWorkspaceGitDiff(root, {
    base: 'session',
    sessionFiles: [{path: 'note.txt', before: 'staged\n'}],
  });
  expect(branch.base).toBe('branch');
  expect(branch.capabilities?.branch.available).toBe(true);
  expect(
    branch.files
      .find(f => f.path === 'note.txt')
      ?.lines.filter(l => l.type === 'del')
      .map(l => l.content),
  ).toEqual(['initial']);
  expect(branch.files.some(f => f.path === 'new.txt')).toBe(true);
  expect(uncommitted.files.filter(f => f.path === 'note.txt')).toHaveLength(1);
  expect(
    uncommitted.files
      .find(f => f.path === 'note.txt')
      ?.lines.filter(l => l.type === 'del')
      .map(l => l.content),
  ).toEqual(['committed']);
  expect(current.files.map(f => f.path)).toEqual(['note.txt']);
  expect(current.files[0]?.lines.map(l => l.content)).toEqual(['staged', 'working']);
  expect(readFileSync(join(root, '.git/index'))).toEqual(beforeIndex);
  expect(git('symbolic-ref', '--short', 'HEAD')).toBe('feature');
});
test('detached HEAD, missing default branch, partial clone and non-Git expose truthful unavailable capabilities', () => {
  const {root, git} = repository();
  git('update-ref', '--no-deref', 'HEAD', git('rev-parse', 'HEAD'));
  let report = computeWorkspaceGitDiff(root, {base: 'branch'});
  expect(report.files).toEqual([]);
  expect(report.capabilities?.branch.reason).toContain('Detached');
  expect(report.capabilities?.uncommitted.available).toBe(true);
  git('symbolic-ref', 'HEAD', 'refs/heads/other');
  git('update-ref', 'refs/heads/other', git('rev-parse', 'main'));
  git('branch', '-D', 'main');
  report = computeWorkspaceGitDiff(root, {base: 'branch'});
  expect(report.capabilities?.branch.reason).toContain('default branch');
  git('config', 'remote.evil.promisor', 'true');
  git('config', 'remote.evil.url', 'ext::touch NEVER');
  report = computeWorkspaceGitDiff(root, {base: 'uncommitted'});
  expect(report.message).toContain('Partial-clone');
  expect(report.files).toEqual([]);
  const outside = mkdtempSync(join(tmpdir(), 'fyn-no-base-'));
  roots.push(outside);
  report = computeWorkspaceGitDiff(outside, {base: 'session', sessionFiles: []});
  expect(report.state).toBe('ready');
  expect(report.gitAvailable).toBe(false);
  expect(report.capabilities?.session.available).toBe(true);
  expect(report.capabilities?.branch.available).toBe(false);
  writeFileSync(join(outside, 'session.txt'), 'new');
  report = computeWorkspaceGitDiff(outside, {base: 'session', sessionFiles: [{path: 'session.txt', before: 'old'}]});
  expect(report.files[0]?.lines.map(line => line.content)).toEqual(['old', 'new']);
});
test('all bases filter tracked, untracked and symlink paths with host policy and redact before exposure', () => {
  const {root} = repository();
  writeFileSync(join(root, 'note.txt'), 'sensitive-token\n');
  writeFileSync(join(root, '.env'), 'withheld\n');
  symlinkSync('/etc/passwd', join(root, 'outside'));
  for (const base of ['session', 'uncommitted', 'branch'] as const) {
    const report = computeWorkspaceGitDiff(root, {
      base,
      sessionFiles: [
        {path: 'note.txt', before: 'initial\n'},
        {path: '.env', before: null},
      ],
      canRead: path => path !== '.env',
      redact: text => text.replaceAll('sensitive-token', '[REDACTED]'),
    });
    expect(report.files.map(f => f.path)).toEqual(['note.txt']);
    expect(JSON.stringify(report)).not.toContain('sensitive-token');
    expect(JSON.stringify(report)).not.toContain('withheld');
    expect(JSON.stringify(report)).toContain('[REDACTED]');
  }
});

test('workspace diffs never expose canonical or legacy state roots', () => {
  const {root} = repository();
  mkdirSync(join(root, '.cosmew'), {recursive: true});
  writeFileSync(join(root, '.cosmew/settings.json'), 'private\n');
  for (const base of ['session', 'uncommitted', 'branch'] as const) {
    const report = computeWorkspaceGitDiff(root, {
      base,
      sessionFiles: [{path: '.cosmew/settings.json', before: null}],
    });
    expect(report.files.some(file => file.path.startsWith('.cosmew/'))).toBe(false);
  }
});
test('production SDK default is Current; separate cached bases do not mix and deny/ask rules include untracked files', async () => {
  const {root} = repository();
  writeFileSync(join(root, '.env'), 'secret\n');
  writeFileSync(join(root, 'visible.txt'), 'public\n');
  writeFileSync(join(root, 'denied.txt'), 'denied content');
  writeFileSync(join(root, 'asked.txt'), 'asked content');
  mkdirSync(join(root, '.futryn'));
  writeFileSync(
    join(root, '.futryn/settings.json'),
    JSON.stringify({permissions: {deny: ['Read(denied.txt)'], ask: ['Read(asked.txt)']}}),
  );
  const app = startup(join(root, 'state'), {vault: memoryVault(), skillsHome: root, memoriesHome: root});
  try {
    const client = app.createFutrynClient(root);
    client.setToolsEnabled(true);
    const session = await client.refreshWorkspaceDiff();
    expect(session.base).toBe('session');
    expect(session.files).toEqual([]);
    const dirty = await client.refreshWorkspaceDiff({base: 'uncommitted'});
    expect(dirty.files.some(f => f.path === 'visible.txt')).toBe(true);
    expect(dirty.files.some(f => f.path === '.env')).toBe(false);
    expect(dirty.files.some(f => f.path === 'denied.txt' || f.path === 'asked.txt')).toBe(false);
    expect(client.getWorkspaceDiff().base).toBe('session');
    expect(client.getWorkspaceDiff({base: 'uncommitted'}).base).toBe('uncommitted');
    client.setToolsEnabled(false);
    expect(client.getWorkspaceDiff({base: 'uncommitted'}).files).toEqual([]);
  } finally {
    await app.shutdownCommands();
    app.db.close();
  }
});

test('session baseline keeps earliest durable preimage across turns and refuses pruned or redacted history', async () => {
  const {Database} = await import('bun:sqlite');
  const {CheckpointStore} = await import('@cosmew/persistence');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE turn_checkpoints(id TEXT PRIMARY KEY,session_id TEXT,workspace TEXT,data TEXT)');
  try {
    const store = new CheckpointStore(db);
    const first = store.begin('session', '/workspace', 'first', []);
    const change = {
      path: 'note.txt',
      before: 'initial\n',
      beforeMode: 0o644,
      afterHash: 'first',
      afterMode: 0o644,
      additions: 1,
      deletions: 1,
    };
    store.capture(first, [change]);
    const second = store.begin('session', '/workspace', 'second', []);
    store.capture(second, [{...change, before: 'first\n', afterHash: 'second'}]);
    expect(new CheckpointStore(db).sessionDiffBaseline('session', '/workspace').files).toEqual([
      {path: 'note.txt', before: 'initial\n'},
    ]);
    expect(store.sessionDiffBaseline('other', '/workspace').files).toEqual([]);
    for (let i = 0; i < 100; i++) store.begin('session', '/workspace', String(i), []);
    expect(store.sessionDiffBaseline('session', '/workspace').reason).toContain('retention');
    const redacting = new CheckpointStore(db, text => text.replaceAll('SECRET', '[REDACTED]'));
    const secret = redacting.begin('secret', '/workspace', 'secret edit', []);
    redacting.capture(secret, [{...change, before: 'SECRET'}]);
    expect(redacting.sessionDiffBaseline('secret', '/workspace').reason).toContain('redacted');
    expect(redacting.sessionDiffBaseline('secret', '/workspace').files).toEqual([]);
  } finally {
    db.close();
  }
});

test('uncommitted is working tree versus HEAD, including staged changes reverted in the worktree', () => {
  const {root, git} = repository();
  writeFileSync(join(root, 'note.txt'), 'staged\n');
  git('add', 'note.txt');
  writeFileSync(join(root, 'note.txt'), 'initial\n');
  const report = computeWorkspaceGitDiff(root, {base: 'uncommitted'});
  expect(report.files).toEqual([]);
  expect(computeWorkspaceGitDiff(root).files.filter(file => file.path === 'note.txt')).toHaveLength(2);
});

test('sealed explicit bases reject parent symlinks, FIFOs and hardlinks before reading current bytes', () => {
  const {root, git} = repository();
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested/file.txt'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'nested');
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-outside-base-')));
  roots.push(outside);
  writeFileSync(join(outside, 'file.txt'), 'OUTSIDE-SENSITIVE\n');
  rmSync(join(root, 'nested'), {recursive: true});
  symlinkSync(outside, join(root, 'nested'));
  linkSync(join(outside, 'file.txt'), join(root, 'hardlink.txt'));
  const fifo = Bun.spawnSync(['/usr/bin/mkfifo', join(root, 'pipe')]);
  expect(fifo.exitCode).toBe(0);
  for (const base of ['session', 'uncommitted', 'branch'] as const) {
    const report = computeWorkspaceGitDiff(root, {
      base,
      sessionFiles: [
        {path: 'nested/file.txt', before: 'original\n'},
        {path: 'hardlink.txt', before: null},
        {path: 'pipe', before: null},
      ],
    });
    expect(JSON.stringify(report)).not.toContain('OUTSIDE-SENSITIVE');
    expect(report.files.some(file => ['nested/file.txt', 'hardlink.txt', 'pipe'].includes(file.path))).toBe(false);
  }
});

test('swapping an authorized parent to an outside symlink between policy and content read cannot leak bytes', () => {
  for (const base of ['session', 'uncommitted', 'branch'] as const) {
    const {root, git} = repository();
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested/file.txt'), 'before\n');
    git('add', '.');
    git('commit', '-qm', 'nested');
    writeFileSync(join(root, 'nested/file.txt'), 'after\n');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-race-base-')));
    roots.push(outside);
    writeFileSync(join(outside, 'file.txt'), 'RACE-OUTSIDE-SECRET\n');
    let calls = 0,
      swapped = false;
    const report = computeWorkspaceGitDiff(root, {
      base,
      sessionFiles: [{path: 'nested/file.txt', before: 'before\n'}],
      canRead: path => {
        if (path === 'nested/file.txt' && ++calls === (base === 'session' ? 4 : 2)) {
          renameSync(join(root, 'nested'), join(root, 'saved'));
          symlinkSync(outside, join(root, 'nested'));
          swapped = true;
        }
        return true;
      },
    });
    expect(swapped).toBe(true);
    expect(JSON.stringify(report)).not.toContain('RACE-OUTSIDE-SECRET');
    expect(report.files.some(file => file.path === 'nested/file.txt')).toBe(false);
  }
});

test('unborn HEAD compares the working tree against an empty baseline without writing a Git object', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-unborn-base-')));
  roots.push(root);
  expect(Bun.spawnSync(['/usr/bin/git', 'init', '-q', '-b', 'main'], {cwd: root}).exitCode).toBe(0);
  writeFileSync(join(root, 'first.txt'), 'staged\n');
  expect(Bun.spawnSync(['/usr/bin/git', 'add', 'first.txt'], {cwd: root}).exitCode).toBe(0);
  writeFileSync(join(root, 'first.txt'), 'working\n');
  const indexBefore = readFileSync(join(root, '.git/index'));
  const report = computeWorkspaceGitDiff(root, {base: 'uncommitted'});
  expect(report.state).toBe('ready');
  expect(report.files[0]?.lines.map(line => line.content)).toEqual(['working']);
  expect(report.capabilities?.branch.available).toBe(false);
  expect(readFileSync(join(root, '.git/index'))).toEqual(indexBefore);
});

test('explicit Git bases retain executable-mode-only changes while file contents stay identical', () => {
  const {root} = repository();
  chmodSync(join(root, 'note.txt'), 0o755);
  for (const base of ['uncommitted', 'branch'] as const) {
    const report = computeWorkspaceGitDiff(root, {base});
    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.path).toBe('note.txt');
    expect(report.files[0]?.lines.map(line => line.content)).toEqual(['old mode 100644', 'new mode 100755']);
    expect(report.totalAdditions + report.totalDeletions).toBe(0);
  }
});
