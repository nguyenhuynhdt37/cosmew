import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionGrants} from '@futryn/security';
import {ToolDispatcher} from '@futryn/tools';
import {WorkspaceRoot} from '@futryn/workspace';
import {locateRipgrep} from '../../packages/tools/src/builtin/ripgrep';

const RG = Bun.which('rg');
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function workspace() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'futryn-grep-')));
  cleanup.push(() => rmSync(base, {recursive: true, force: true}));
  const root = join(base, 'ws');
  mkdirSync(join(root, 'src'), {recursive: true});
  mkdirSync(join(root, 'state'));
  writeFileSync(join(base, 'outside.ts'), 'export const needle = "outside";\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'one\nconst needle = 1;\nthree\nfour\nfive\nconst needle2 = 2;\n');
  writeFileSync(join(root, 'src', 'b.py'), 'needle = True\n');
  writeFileSync(join(root, '.env'), 'NEEDLE_TOKEN=secret-value\n');
  writeFileSync(join(root, 'state', 'cache.json'), '{"needle": "state"}\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
  writeFileSync(join(root, 'ignored.ts'), 'needle ignored\n');
  symlinkSync(join(base, 'outside.ts'), join(root, 'src', 'link.ts'));
  Bun.spawnSync(['git', 'init', '-q'], {cwd: root});
  return {base, root};
}

function dispatcher(root: string, ripgrep: string | null) {
  const tools = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    stateDirectory: join(root, 'state'),
    approve: async () => 'deny',
    redact: text => text,
    ripgrep,
  });
  return (input: Record<string, unknown>) => tools.invoke({id: crypto.randomUUID(), name: 'grep', input});
}

const backends: [string, string | null][] = [['built-in', null], ...(RG ? [['ripgrep', RG] as [string, string]] : [])];

describe.each(backends)('grep (%s backend)', (_name, ripgrep) => {
  test('content lists path:line:text, never secret, state, ignored or symlinked-outside files', async () => {
    const {root} = workspace();
    const result = await dispatcher(root, ripgrep)({pattern: 'needle', ignoreCase: true});
    expect(result.status).toBe('ok');
    expect(result.content).toContain('src/a.ts:2:const needle = 1;');
    expect(result.content).toContain('src/b.py:1:needle = True');
    expect(result.content).not.toContain('secret-value');
    expect(result.content).not.toContain('state');
    expect(result.content).not.toContain('ignored');
    expect(result.content).not.toContain('outside');
    expect(result.content).toContain('1 secret-looking file(s) skipped');
  });

  test('a glob narrows the search but never re-includes gitignored files', async () => {
    const {root} = workspace();
    const result = await dispatcher(root, ripgrep)({pattern: 'needle', glob: '**/*.ts'});
    expect(result.content).toContain('src/a.ts:2:');
    expect(result.content).not.toContain('ignored');
    expect(result.content).not.toContain('b.py');
  });

  test('files_with_matches and count modes', async () => {
    const {root} = workspace();
    const grep = dispatcher(root, ripgrep);
    const files = await grep({pattern: 'needle', output_mode: 'files_with_matches'});
    expect(files.content.split('\n\n')[0]!.split('\n')).toEqual(['src/a.ts', 'src/b.py']);
    const count = await grep({pattern: 'needle', output_mode: 'count'});
    expect(count.content.split('\n\n')[0]!.split('\n')).toEqual(['src/a.ts:2', 'src/b.py:1']);
  });

  test('head_limit and offset page through results', async () => {
    const {root} = workspace();
    const grep = dispatcher(root, ripgrep);
    const first = await grep({pattern: 'needle', output_mode: 'files_with_matches', head_limit: 1});
    expect(first.content).toStartWith('src/a.ts\n\n[showing entries 1-1 of 2; continue with offset 1');
    expect(first.truncated).toBe(true);
    const second = await grep({pattern: 'needle', output_mode: 'files_with_matches', head_limit: 1, offset: 1});
    expect(second.content.split('\n')[0]).toBe('src/b.py');
  });

  test('multiline patterns span lines', async () => {
    const {root} = workspace();
    const result = await dispatcher(root, ripgrep)({pattern: 'needle = 1;\\nthree', multiline: true});
    expect(result.content).toContain('src/a.ts:2:const needle = 1;');
    expect(result.content).toContain('src/a.ts:3:three');
  });
});

describe.skipIf(!RG)('grep ripgrep-only features', () => {
  test('context lines use path-line-text and -- separates groups', async () => {
    const {root} = workspace();
    const result = await dispatcher(root, RG)({pattern: 'needle', glob: '**/*.ts', context: 1});
    expect(result.content.split('\n\n')[0]).toBe(
      [
        'src/a.ts-1-one',
        'src/a.ts:2:const needle = 1;',
        'src/a.ts-3-three',
        '--',
        'src/a.ts-5-five',
        'src/a.ts:6:const needle2 = 2;',
      ].join('\n'),
    );
  });

  test('type narrows by language and a bad pattern is reported, not thrown', async () => {
    const {root} = workspace();
    const grep = dispatcher(root, RG);
    const py = await grep({pattern: 'needle', type: 'py', output_mode: 'files_with_matches'});
    expect(py.content.split('\n')[0]).toBe('src/b.py');
    expect(py.content).not.toContain('a.ts');
    const bad = await grep({pattern: '(unclosed'});
    expect(bad.status).toBe('error');
    expect(bad.code).toBe('INVALID_PATTERN');
  });

  test('a catastrophic backtracking pattern returns promptly', async () => {
    const {root} = workspace();
    writeFileSync(join(root, 'evil.txt'), Array.from({length: 20}, () => 'x'.repeat(30)).join('\n'));
    const started = Date.now();
    const result = await dispatcher(root, RG)({pattern: '(x+x+)+y'});
    expect(result.status).toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('an rg planted inside the workspace or a relative one is never used', () => {
    const {root} = workspace();
    const planted = join(root, 'node_modules', '.bin', 'rg');
    mkdirSync(join(root, 'node_modules', '.bin'), {recursive: true});
    writeFileSync(planted, '#!/bin/sh\ntouch pwned\n');
    chmodSync(planted, 0o755);
    expect(locateRipgrep(root, planted)).toBeNull();
    expect(locateRipgrep(root, 'rg')).toBeNull();
    expect(locateRipgrep(root, RG!)).toBe(RG!);
  });
});
