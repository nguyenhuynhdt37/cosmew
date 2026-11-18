/** S5c: isolated worktrees use real Git; the child's sandbox can write only its worktree (never the main checkout or `.git`). */
import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCommandRuntime} from '@futryn/tools';
import {GitWorktrees, WorktreeError} from '@futryn/workspace';

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
