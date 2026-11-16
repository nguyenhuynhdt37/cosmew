import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {computeWorkspaceGitDiff} from '../../apps/cli/src/bootstrap/workspace-info';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'fyn-diff-'));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: root,
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
  };
  git('init', '-q');
  for (const name of ['staged.txt', 'unstaged.txt', 'delete.txt', 'rename.txt'])
    writeFileSync(join(root, name), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return {root, git};
}
test('diff collects staged, unstaged, untracked, deletion, rename and binary with matching totals', () => {
  const {root, git} = repo();
  writeFileSync(join(root, 'staged.txt'), 'after\n');
  git('add', 'staged.txt');
  writeFileSync(join(root, 'unstaged.txt'), 'after\n');
  rmSync(join(root, 'delete.txt'));
  renameSync(join(root, 'rename.txt'), join(root, 'renamed.txt'));
  git('add', 'rename.txt', 'renamed.txt');
  writeFileSync(join(root, 'new\nfile.txt'), 'new\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  const report = computeWorkspaceGitDiff(root);
  expect(report.files.some(file => file.path === 'staged.txt')).toBe(true);
  expect(report.files.some(file => file.status === 'renamed')).toBe(true);
  expect(report.files.some(file => file.status === 'deleted')).toBe(true);
  expect(report.files.some(file => file.status === 'untracked')).toBe(true);
  expect(report.files.find(file => file.path === 'binary.bin')?.lines).toHaveLength(0);
  expect(report.totalAdditions).toBe(report.files.reduce((n, file) => n + file.additions, 0));
  expect(report.totalDeletions).toBe(report.files.reduce((n, file) => n + file.deletions, 0));
});
test('informational diff never executes configured filters, fsmonitor, external diff or textconv', () => {
  const {root, git} = repo();
  const marker = join(root, 'EXECUTED');
  const evil = `touch '${marker}'`;
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil diff=evil\n');
  git('config', 'filter.evil.clean', evil);
  git('config', 'filter.evil.process', evil);
  git('config', 'filter.evil.required', 'true');
  git('config', 'diff.external', evil);
  git('config', 'diff.evil.textconv', evil);
  git('config', 'diff.evil.command', evil);
  git('config', 'core.fsmonitor', evil);
  writeFileSync(join(root, 'unstaged.txt'), 'after\n');
  const report = computeWorkspaceGitDiff(root);
  expect(existsSync(marker)).toBe(false);
  expect(report.gitAvailable).toBe(true);
  expect(report.files.some(file => file.path === 'unstaged.txt')).toBe(true);
});
test('clean and non-Git workspaces are distinct and very large untracked data is bounded', () => {
  const {root} = repo();
  expect(computeWorkspaceGitDiff(root).files).toHaveLength(0);
  const outside = mkdtempSync(join(tmpdir(), 'fyn-not-git-'));
  roots.push(outside);
  expect(computeWorkspaceGitDiff(outside).gitAvailable).toBe(false);
  writeFileSync(join(root, 'large.txt'), 'line\n'.repeat(100000));
  const report = computeWorkspaceGitDiff(root);
  expect(report.files[0]!.lines.length).toBeLessThanOrEqual(2000);
  expect(report.totalAdditions).toBe(report.files[0]!.additions);
});

test('staged submodule commit updates are never reported as a clean repository', () => {
  const {root, git} = repo();
  const head = () => Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: root}).stdout.toString().trim();
  const first = head();
  git('update-index', '--add', '--cacheinfo', `160000,${first},sub`);
  git('commit', '-qm', 'gitlink');
  git('update-index', '--cacheinfo', `160000,${head()},sub`);
  const report = computeWorkspaceGitDiff(root);
  expect(report.files.some(file => file.path === 'sub' && file.layer === 'staged')).toBe(true);
});
