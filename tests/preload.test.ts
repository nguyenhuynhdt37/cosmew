import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('the repository preload isolates inherited home and state and removes its temporary directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-preload-fixture-'));
  try {
    const fixture = join(home, 'isolation.test.ts');
    writeFileSync(
      fixture,
      `import {test} from 'bun:test';
test('prints the test environment', () => console.log('isolation ' + JSON.stringify({
  home: process.env.HOME,
  state: process.env.COSMEW_HOME,
  futryn: process.env.FUTRYN_HOME,
  hannes: process.env.HANNES_HOME,
  backend: process.env.COSMEW_COMMAND_BACKEND,
})));
`,
    );
    const child = Bun.spawnSync([process.execPath, 'test', fixture], {
      env: {
        ...process.env,
        HOME: home,
        COSMEW_HOME: join(home, 'cosmew'),
        FUTRYN_HOME: join(home, 'futryn'),
        HANNES_HOME: join(home, 'hannes'),
        COSMEW_COMMAND_BACKEND: undefined,
      },
      stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    const env = JSON.parse(child.stdout.toString().match(/^isolation (.*)$/m)![1]!);
    expect(env.home).not.toBe(home);
    expect(env.state).toBe(join(env.home, 'state'));
    expect(env.futryn).toBeUndefined();
    expect(env.hannes).toBeUndefined();
    expect(env.backend).toBe('none');
    expect(existsSync(env.home)).toBe(false);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

test.each([
  ['unchanged', ''],
  ['created', "writeFileSync(file, 'fixture');"],
  ['removed', 'unlinkSync(file);'],
  ['mtime changed', 'utimesSync(file, timestamp, timestamp + 1);'],
  ['size changed', "writeFileSync(file, 'longer fixture'); utimesSync(file, timestamp, timestamp);"],
  ['hash changed', "writeFileSync(file, 'changed'); utimesSync(file, timestamp, timestamp);"],
] as const)('guard checks fake user state after tests and at teardown (%s)', (kind, change) => {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-state-guard-'));
  try {
    const root = join(home, '.futryn');
    const file = join(root, 'provider-auth.sqlite');
    mkdirSync(root);
    if (kind !== 'created') writeFileSync(file, 'fixture');
    const fixture = join(home, 'guard.test.ts');
    writeFileSync(
      fixture,
      `import {afterAll, afterEach, test} from 'bun:test';
import {existsSync, unlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {watchUserState} from ${JSON.stringify(join(import.meta.dir, 'user-state-guard.ts'))};
const file = ${JSON.stringify(file)};
const timestamp = 1_700_000_000;
if (existsSync(file)) utimesSync(file, timestamp, timestamp);
const check = watchUserState(${JSON.stringify(home)});
afterEach(() => check(true));
afterAll(() => check());
test('simulates a state write', () => { ${change} });
test('runs after the state write', () => {});
`,
    );
    const child = Bun.spawnSync([process.execPath, 'test', '--config=/dev/null', fixture], {
      cwd: home,
      stderr: 'pipe',
    });
    const output = child.stderr.toString();
    if (kind === 'unchanged') {
      expect(child.exitCode).toBe(0);
      expect(output).not.toContain(file);
    } else {
      expect(child.exitCode).toBe(1);
      expect(output).toContain(file);
    }
    expect(output).not.toContain('(fail) runs after the state write');
    if (kind === 'unchanged' || kind === 'hash changed') {
      expect(output).toContain('2 pass');
    } else {
      expect(output).toContain('(fail) simulates a state write');
    }
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});
