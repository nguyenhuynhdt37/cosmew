/** S5c: isolated worktrees use real Git; the child's sandbox can write only its worktree (never the main checkout or `.git`). */
import {afterEach, expect, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCommandRuntime, ToolDispatcher, DEFAULT_SANDBOX_CONFIG, type ApprovalRequest} from '@cosmew/tools';
import {SessionGrants} from '@cosmew/security';
import {formatSubagentNotification} from '@cosmew/agents';
import {GitWorktrees, WorktreeError, WorkspaceRoot, contentHash} from '@cosmew/workspace';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
const git = (cwd: string, ...args: string[]) =>
  spawnSync(
    'git',
    ['-C', cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    {encoding: 'utf8'},
  );
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  clean.push(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
};
function repository() {
  const root = tmp('fyn-wt-repo-');
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const base = tmp('fyn-wt-base-');
  return {root, worktrees: new GitWorktrees({workspaceRoot: root, baseDirectory: base})};
}
const ID = '11111111-2222-4333-8444-555555555555';

test('an unchanged worktree is deleted with its branch; a changed one is kept', () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  expect(existsSync(join(info.path, 'a.txt'))).toBe(true);
  expect(info.path.startsWith(root)).toBe(false);
  expect(git(root, 'branch', '--list', info.branch).stdout).toContain(info.branch);
  expect(worktrees.finish(info)).toEqual({changed: false, removed: true});
  expect(existsSync(info.path)).toBe(false);
  expect(git(root, 'branch', '--list', info.branch).stdout.trim()).toBe('');

  const second = worktrees.create(ID);
  writeFileSync(join(second.path, 'new.txt'), 'x');
  expect(worktrees.finish(second)).toEqual({changed: true, removed: false});
  expect(readFileSync(join(second.path, 'new.txt'), 'utf8')).toBe('x');
  expect(git(root, 'branch', '--list', second.branch).stdout).toContain(second.branch);
  // Reopenable after a restart, still reported as changed; the main checkout is untouched.
  expect(worktrees.open(ID)?.path).toBe(second.path);
  expect(existsSync(join(root, 'new.txt'))).toBe(false);
  worktrees.remove(second);

  const committed = worktrees.create(ID);
  git(committed.path, 'commit', '-q', '--allow-empty', '-m', 'work');
  expect(worktrees.hasChanges(committed)).toBe(true);
  worktrees.remove(committed);
});

test('non-Git workspaces and repositories without a commit are refused clearly', () => {
  const plain = tmp('fyn-wt-plain-');
  const base = tmp('fyn-wt-base2-');
  expect(() => new GitWorktrees({workspaceRoot: plain, baseDirectory: base}).create(ID)).toThrow(WorktreeError);
  try {
    new GitWorktrees({workspaceRoot: plain, baseDirectory: base}).create(ID);
  } catch (error) {
    expect((error as WorktreeError).reason).toBe('not-a-repository');
  }
  const empty = tmp('fyn-wt-empty-');
  git(empty, 'init', '-q');
  try {
    new GitWorktrees({workspaceRoot: empty, baseDirectory: base}).create(ID);
    throw new Error('expected refusal');
  } catch (error) {
    expect((error as WorktreeError).reason).toBe('no-commit');
  }
  expect(() => new GitWorktrees({workspaceRoot: plain, baseDirectory: base}).create('../escape')).toThrow();
});

test('repository filter drivers and hooks never run while inspecting a worktree', () => {
  const {root, worktrees} = repository();
  const marker = join(tmp('fyn-wt-marker-'), 'ran');
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil\n');
  git(root, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-q', '-m', 'attrs');
  rmSync(marker, {force: true}); // the test's own commit may have run the driver
  const info = worktrees.create(ID);
  writeFileSync(join(info.path, 'a.txt'), 'edited\n');
  expect(worktrees.hasChanges(info)).toBe(true);
  expect(existsSync(marker)).toBe(false);
  worktrees.remove(info);
});

const native = test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'));
native('a child sandbox rooted at the worktree writes there but not to the main checkout or .git', async () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  const runtime = new NativeCommandRuntime({
    workspaceRoot: info.path,
    skillDirectories: [info.gitCommonDir],
    readOnlySkillDirectories: [info.gitCommonDir],
  });
  clean.push(() => runtime.shutdown());
  const run = (command: string) =>
    runtime.run({
      command,
      cwd: '.',
      timeoutMs: 20_000,
      maxOutputBytes: 10_000,
      sandbox: {mode: 'workspace-write', network: false},
    });
  const result = await run(
    [
      'echo ok > made.txt',
      `echo x > ${JSON.stringify(join(root, 'escape.txt'))} 2>/dev/null && echo MAIN_WRITE`,
      'echo x > .git 2>/dev/null && echo DOTGIT_WRITE',
      `echo x > ${JSON.stringify(join(info.gitCommonDir, 'escape'))} 2>/dev/null && echo GITDIR_WRITE`,
      'git status --short 2>&1 | head -3',
      'true',
    ].join('; '),
  );
  expect(readFileSync(join(info.path, 'made.txt'), 'utf8')).toBe('ok\n');
  expect(result.output).not.toContain('MAIN_WRITE');
  expect(result.output).not.toContain('DOTGIT_WRITE');
  expect(result.output).not.toContain('GITDIR_WRITE');
  expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  expect(existsSync(join(info.gitCommonDir, 'escape'))).toBe(false);
  expect(result.output).toContain('made.txt'); // git status works: the Git directory is readable
  worktrees.remove(info);
});

test('worktree creation does not run repository smudge/process filter drivers', () => {
  const root = tmp('fyn-wt-filter-');
  const marker = join(tmp('fyn-wt-marker-'), 'ran');
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil\n');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'config', 'filter.evil.smudge', `touch ${marker}; cat`);
  git(root, 'config', 'filter.evil.process', `touch ${marker}`);
  git(root, 'config', 'filter.evil.required', 'true');
  const worktrees = new GitWorktrees({workspaceRoot: root, baseDirectory: tmp('fyn-wt-base-f-')});
  const info = worktrees.create(ID);
  expect(readFileSync(join(info.path, 'a.txt'), 'utf8')).toBe('base\n');
  expect(existsSync(marker)).toBe(false);
  worktrees.remove(info);
});

test('a symlinked or loosely-permissioned worktree base directory is refused', () => {
  const {root} = repository();
  const holder = tmp('fyn-wt-holder-');
  const target = tmp('fyn-wt-target-');
  const link = join(holder, 'base-link');
  symlinkSync(target, link);
  expect(() => new GitWorktrees({workspaceRoot: root, baseDirectory: link}).create(ID)).toThrow(WorktreeError);
  expect(existsSync(join(target, 'x'))).toBe(false);

  const loose = join(holder, 'loose');
  mkdirSync(loose, {mode: 0o755});
  chmodSync(loose, 0o755);
  expect(() => new GitWorktrees({workspaceRoot: root, baseDirectory: loose}).create(ID)).toThrow(WorktreeError);

  // A pre-created per-repository directory that is a symlink is refused too.
  const base = tmp('fyn-wt-base-s-');
  const first = new GitWorktrees({workspaceRoot: root, baseDirectory: base});
  first.remove(first.create(ID));
  const entry = join(base, require('node:fs').readdirSync(base)[0]);
  rmSync(entry, {recursive: true, force: true});
  symlinkSync(target, entry);
  expect(() => first.create(ID)).toThrow(WorktreeError);
});

function reviewInput(note: string): {patch: string; expected_files: Record<string, string | null>} {
  const line = note.split('\n').find(line => line.startsWith('{"patch":'));
  if (!line) throw new Error(note);
  return JSON.parse(line);
}
function integrationTools(root: string, approve?: (request: ApprovalRequest) => Promise<'once' | 'deny'>) {
  const requests: ApprovalRequest[] = [];
  const tools = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    stateDirectory: join(root, 'host-state'),
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    redact: text => text,
    approve: async request => {
      requests.push(request);
      return approve ? approve(request) : 'once';
    },
  });
  return {requests, run: (input: unknown) => tools.invoke({id: crypto.randomUUID(), name: 'apply_patch', input})};
}

test('real Git handoff integrates committed, uncommitted, untracked, deleted and empty files after approval', async () => {
  const {root, worktrees} = repository();
  writeFileSync(join(root, 'deleted.txt'), 'remove\n');
  writeFileSync(join(root, 'empty.txt'), '');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'preparation');
  const info = worktrees.create(ID);
  writeFileSync(join(info.path, 'a.txt'), 'committed\n');
  git(info.path, 'add', 'a.txt');
  git(info.path, 'commit', '-q', '-m', 'child commit');
  writeFileSync(join(info.path, 'a.txt'), 'committed and uncommitted\n');
  writeFileSync(join(info.path, 'new.txt'), 'untracked\n');
  writeFileSync(join(info.path, 'empty.txt'), 'filled\n');
  writeFileSync(join(info.path, 'new-empty.txt'), '');
  rmSync(join(info.path, 'deleted.txt'));
  const note = worktrees.handoff(info);
  expect(note).toContain('committed changes: yes; uncommitted/untracked changes: yes');
  const input = reviewInput(note);
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base\n');
  expect(git(root, 'status', '--porcelain').stdout).toBe('');
  const f = integrationTools(root, async request => {
    expect(request.diffPreview).toContain('+committed and uncommitted');
    expect(request.diffPreview).toContain('deleted.txt');
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
    return 'once';
  });
  expect((await f.run(input)).status).toBe('ok');
  expect(f.requests).toHaveLength(1);
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('committed and uncommitted\n');
  expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('untracked\n');
  expect(readFileSync(join(root, 'empty.txt'), 'utf8')).toBe('filled\n');
  expect(readFileSync(join(root, 'new-empty.txt'), 'utf8')).toBe('');
  expect(existsSync(join(root, 'deleted.txt'))).toBe(false);
  expect(worktrees.finish(info)).toEqual({changed: true, removed: false});
  expect(worktrees.handoff(info)).toContain('already integrated');
  expect(existsSync(info.path)).toBe(true);
});

test('handoff conflicts preserve parent edits before review and exact hashes reject later whitespace and append changes', async () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  writeFileSync(join(info.path, 'a.txt'), 'child\n');
  const input = reviewInput(worktrees.handoff(info));
  const f = integrationTools(root);
  for (const parent of ['base \n', 'base\nappended\n']) {
    writeFileSync(join(root, 'a.txt'), parent);
    expect(worktrees.handoff(info)).toContain('CONFLICT');
    expect(['PATCH_CONFLICT', 'PATCH_MISMATCH']).toContain((await f.run(input)).code ?? '');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(parent);
  }
  expect(f.requests).toHaveLength(0);
  expect(worktrees.finish(info).removed).toBe(false);
});

test('guarded deletion, creation and full target coverage refuse conflicts without prompting', async () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  rmSync(join(info.path, 'a.txt'));
  writeFileSync(join(info.path, 'new.txt'), 'new\n');
  const input = reviewInput(worktrees.handoff(info));
  const f = integrationTools(root);
  expect((await f.run({...input, expected_files: {'a.txt': contentHash('base\n')}})).code).toBe('PATCH_CONFLICT');
  expect((await f.run({...input, expected_files: {...input.expected_files, extra: null}})).code).toBe('PATCH_CONFLICT');
  writeFileSync(join(root, 'a.txt'), 'parent\n');
  expect((await f.run(input)).code).toBe('PATCH_CONFLICT');
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('parent\n');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  writeFileSync(join(root, 'new.txt'), 'parent-created\n');
  expect((await f.run(input)).status).toBe('error');
  expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('parent-created\n');
  expect(f.requests).toHaveLength(0);
});

test('handoff denial and modification during approval retain source and refuse stale writes', async () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  writeFileSync(join(info.path, 'a.txt'), 'child\n');
  const input = reviewInput(worktrees.handoff(info));
  expect((await integrationTools(root, async () => 'deny').run(input)).status).toBe('denied');
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base\n');
  const f = integrationTools(root, async () => {
    writeFileSync(join(root, 'a.txt'), 'concurrent\n');
    return 'once';
  });
  expect((await f.run(input)).status).toBe('error');
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('concurrent\n');
  expect(readFileSync(join(info.path, 'a.txt'), 'utf8')).toBe('child\n');
  expect(worktrees.finish(info).removed).toBe(false);
});

test('handoff safely reports unsupported binary, symlink, mode and oversized changes and never runs filters', () => {
  const {root, worktrees} = repository();
  const marker = join(tmp('fyn-handoff-marker-'), 'ran');
  git(root, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
  git(root, 'config', 'filter.evil.smudge', `touch ${marker}; cat`);
  git(root, 'config', 'diff.external', `touch ${marker}`);
  const info = worktrees.create(ID);
  writeFileSync(join(info.path, '.gitattributes'), '*.txt filter=evil\n');
  writeFileSync(join(info.path, 'binary.txt'), Buffer.from([0, 255, 1]));
  symlinkSync(join(root, 'a.txt'), join(info.path, 'link'));
  writeFileSync(join(info.path, 'exec'), 'script\n');
  chmodSync(join(info.path, 'exec'), 0o755);
  writeFileSync(join(info.path, 'large.txt'), 'large\n'.repeat(4000));
  const note = worktrees.handoff(info);
  expect(note).toContain('manual review');
  expect(note).toContain('binary.txt');
  expect(note).toContain('link');
  expect(note).toContain('exec');
  expect(note).toContain('large.txt');
  expect(note.length).toBeLessThan(4000);
  expect(existsSync(marker)).toBe(false);
  expect(worktrees.finish(info).removed).toBe(false);
});

test('handoff mode guard refuses deleting a file chmodded by the parent after review', async () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  rmSync(join(info.path, 'a.txt'));
  const input = reviewInput(worktrees.handoff(info));
  chmodSync(join(root, 'a.txt'), 0o755);
  const f = integrationTools(root);
  expect((await f.run(input)).code).toBe('PATCH_CONFLICT');
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base\n');
  expect(f.requests).toHaveLength(0);
});

test('bounded background handoff JSON survives notification escaping and actually integrates source punctuation', async () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  const content = '<component value="a&b">text</component>\n';
  writeFileSync(join(info.path, 'a.txt'), content);
  for (let index = 0; index < 40; index++) writeFileSync(join(info.path, `new-${index}.txt`), 'new\n'.repeat(25));
  const note = worktrees.handoff(info);
  expect(note.length).toBeLessThan(3800);
  const notification = formatSubagentNotification({
    agentId: ID,
    agentType: 'worker',
    description: 'test',
    status: 'completed',
    summary: note + '\n' + 'summary'.repeat(1000),
  });
  const input = reviewInput(notification);
  expect(input.patch).toContain(content.trim());
  expect(JSON.stringify(input).length).toBeLessThanOrEqual(2200);
  expect((await integrationTools(root).run(input)).status).toBe('ok');
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(content);
  expect(worktrees.finish(info).removed).toBe(false);
});

test('a small contextual hunk integrates a one-line fix in a 150-line executable source with mode preserved', async () => {
  const {root, worktrees} = repository();
  const original = Array.from({length: 150}, (_, i) => `echo line-${i}`).join('\n') + '\n';
  writeFileSync(join(root, 'script.sh'), original);
  chmodSync(join(root, 'script.sh'), 0o755);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'script');
  const info = worktrees.create(ID);
  const next = original.replace('echo line-75\n', 'echo fixed\n');
  writeFileSync(join(info.path, 'script.sh'), next);
  const input = reviewInput(worktrees.handoff(info));
  expect(input.patch.length).toBeLessThan(500);
  expect(input.patch).not.toContain('line-0\n');
  expect((await integrationTools(root).run(input)).status).toBe('ok');
  expect(readFileSync(join(root, 'script.sh'), 'utf8')).toBe(next);
  expect(require('node:fs').statSync(join(root, 'script.sh')).mode & 0o777).toBe(0o755);
  writeFileSync(join(root, 'script.sh'), original + 'parent edit\n');
  expect((await integrationTools(root).run(input)).status).toBe('error');
  expect(readFileSync(join(root, 'script.sh'), 'utf8')).toBe(original + 'parent edit\n');
});

test('repeated source context targets the actual occurrence and end insertion stays exact', async () => {
  const {root, worktrees} = repository();
  const original = 'head\n' + 'same\n'.repeat(20) + 'tail\n';
  writeFileSync(join(root, 'a.txt'), original);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'repeat');
  const info = worktrees.create(ID);
  const next = 'head\n' + 'same\n'.repeat(10) + 'changed\n' + 'same\n'.repeat(9) + 'tail\n';
  writeFileSync(join(info.path, 'a.txt'), next);
  expect((await integrationTools(root).run(reviewInput(worktrees.handoff(info)))).status).toBe('ok');
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(next);
});

test('0664 new non-executable text normalizes explicitly while tracked parent mode is preserved', async () => {
  const {root, worktrees} = repository();
  const info = worktrees.create(ID);
  writeFileSync(join(info.path, 'new.txt'), 'new\n');
  chmodSync(join(info.path, 'new.txt'), 0o664);
  writeFileSync(join(info.path, 'a.txt'), 'child\n');
  chmodSync(join(info.path, 'a.txt'), 0o664);
  chmodSync(join(root, 'a.txt'), 0o664);
  const note = worktrees.handoff(info);
  expect(note).toContain(`normalized to ${(0o644 & ~process.umask()).toString(8).padStart(4, '0')}`);
  expect(note).toContain('preserve parent mode 664');
  expect((await integrationTools(root).run(reviewInput(note))).status).toBe('ok');
  expect(require('node:fs').statSync(join(root, 'new.txt')).mode & 0o777).toBe(0o644 & ~process.umask());
  expect(require('node:fs').statSync(join(root, 'a.txt')).mode & 0o777).toBe(0o664);
});

test('restrictive 0600 and 0700 umask files preserve exact parent permissions and stale mode guards', async () => {
  const {root, worktrees} = repository();
  writeFileSync(join(root, 'script.sh'), 'echo base\n');
  chmodSync(join(root, 'script.sh'), 0o700);
  chmodSync(join(root, 'a.txt'), 0o600);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'private script');
  const info = worktrees.create(ID);
  chmodSync(join(info.path, 'a.txt'), 0o600);
  chmodSync(join(info.path, 'script.sh'), 0o700);
  writeFileSync(join(info.path, 'a.txt'), 'private edit\n');
  writeFileSync(join(info.path, 'script.sh'), 'echo private\n');
  const input = reviewInput(worktrees.handoff(info));
  expect((await integrationTools(root).run(input)).status).toBe('ok');
  expect(require('node:fs').statSync(join(root, 'a.txt')).mode & 0o777).toBe(0o600);
  expect(require('node:fs').statSync(join(root, 'script.sh')).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(root, 'script.sh'), 'utf8')).toBe('echo private\n');
});

test('new private text created under umask 077 stays 0600 through real dispatcher integration', async () => {
  const previous = process.umask(0o077);
  try {
    const {root, worktrees} = repository();
    const info = worktrees.create(ID);
    writeFileSync(join(info.path, 'private.txt'), 'private text\n');
    expect(require('node:fs').statSync(join(info.path, 'private.txt')).mode & 0o777).toBe(0o600);
    const input = reviewInput(worktrees.handoff(info));
    expect((await integrationTools(root).run(input)).status).toBe('ok');
    expect(require('node:fs').statSync(join(root, 'private.txt')).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(previous);
  }
});

test('a new source more private than parent default creation mode is retained for manual review', () => {
  const previous = process.umask(0o022);
  try {
    const {root, worktrees} = repository();
    const info = worktrees.create(ID);
    writeFileSync(join(info.path, 'private.txt'), 'private text\n');
    chmodSync(join(info.path, 'private.txt'), 0o600);
    expect(worktrees.handoff(info)).toContain('source permissions are more restrictive');
    expect(existsSync(join(root, 'private.txt'))).toBe(false);
    expect(worktrees.finish(info).removed).toBe(false);
  } finally {
    process.umask(previous);
  }
});
