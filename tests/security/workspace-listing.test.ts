import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionGrants} from '@cosmew/security';
import {ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function repo() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'futryn-listing-')));
  cleanup.push(() => rmSync(base, {recursive: true, force: true}));
  const root = join(base, 'ws');
  Bun.spawnSync(['mkdir', root]);
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], {cwd: root, stdout: 'ignore', stderr: 'ignore'});
  git('init', '-q');
  const call = (name: string, input: Record<string, unknown>) =>
    new ToolDispatcher({
      workspace: new WorkspaceRoot(root),
      grants: new SessionGrants(),
      approve: async () => 'deny',
      redact: s => s,
      ripgrep: null,
    }).invoke({id: crypto.randomUUID(), name, input});
  return {base, root, git, call};
}

test('listing files never runs a fsmonitor program configured by the repository', async () => {
  const r = repo();
  const marker = join(r.base, 'fsmonitor-ran');
  writeFileSync(join(r.root, 'a.ts'), 'needle\n');
  r.git('config', 'core.fsmonitor', `touch '${marker}'; false`);
  // Prove the hazard is real: an unhardened git ls-files would run it.
  Bun.spawnSync(['git', 'ls-files', '--others'], {cwd: r.root, stdout: 'ignore', stderr: 'ignore'});
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  expect((await r.call('glob', {pattern: '**/*.ts'})).content).toContain('a.ts');
  expect((await r.call('grep', {pattern: 'needle'})).content).toContain('a.ts:1:needle');
  expect(existsSync(marker)).toBe(false);
});

test('glob lists the most recently modified files first', async () => {
  const r = repo();
  for (const [name, age] of [
    ['old.ts', 300],
    ['new.ts', 0],
    ['mid.ts', 100],
  ] as const) {
    writeFileSync(join(r.root, name), '');
    const when = new Date(Date.now() - age * 1000);
    utimesSync(join(r.root, name), when, when);
  }
  const result = await r.call('glob', {pattern: '*.ts'});
  expect(result.content.split('\n')).toEqual(['new.ts', 'mid.ts', 'old.ts']);
});
