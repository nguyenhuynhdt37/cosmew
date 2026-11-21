import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

async function cli(dir: string, args: string[]) {
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
    env: {...process.env, HANNES_HOME: dir},
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {stdout, stderr, code};
}

test('CLI exposes the Claude Code appearances and rejects retired color themes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-themes-cli-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  expect((await cli(dir, ['themes', 'set', 'dark'])).code).toBe(0);
  const listed = JSON.parse((await cli(dir, ['themes', 'list', '--json'])).stdout);
  expect(listed.themes.map((theme: {id: string}) => theme.id)).toEqual([
    'auto',
    'dark',
    'light',
    'dark-daltonized',
    'light-daltonized',
    'dark-ansi',
    'light-ansi',
    'midnight',
    'parchment',
  ]);
  expect(listed.mode).toBe('dark');
  expect((await cli(dir, ['themes', 'set', 'parchment'])).code).toBe(0);
  const selected = JSON.parse((await cli(dir, ['themes', 'list', '--json'])).stdout);
  expect(selected.mode).toBe('light');
  expect((await cli(dir, ['themes', 'set', 'sakura'])).code).toBe(1);
  expect((await cli(dir, ['themes', 'wallpaper', 'neon-rain'])).code).toBe(1);
  const file = join(dir, 'old-theme.json');
  writeFileSync(file, JSON.stringify({id: 'old', bg: '#ff0000'}));
  expect((await cli(dir, ['themes', 'import', file])).code).toBe(1);
  expect((await cli(dir, ['themes', 'mode', 'light'])).code).toBe(0);
  expect((await cli(dir, ['themes', 'mode', 'auto'])).code).toBe(0);
  expect(JSON.parse((await cli(dir, ['themes', 'list', '--json'])).stdout).mode).toBe('system');
}, 30000);
