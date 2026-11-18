import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fixtureServer} from '../fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function context() {
  const home = mkdtempSync(join(tmpdir(), 'fyn-exec-home-'));
  const root = mkdtempSync(join(tmpdir(), 'fyn-exec-root-'));
  const server = fixtureServer();
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
    () => server.server.stop(true),
  );
  const spawn = (args: string[], input = '', extraEnv: Record<string, string | undefined> = {}) => {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
      env: {...process.env, FUTRYN_HOME: home, EXEC_FIXTURE_KEY: 'exec-fixture-secret', ...extraEnv},
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(input);
    child.stdin.end();
    return child;
  };
  const collect = async (child: ReturnType<typeof spawn>) => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout + stderr).not.toContain('exec-fixture-secret');
    return {stdout, stderr, code};
  };
  const cli = (args: string[], input = '', extraEnv: Record<string, string | undefined> = {}) =>
    collect(spawn(args, input, extraEnv));
  const configure = async () => {
    expect(
      (
        await cli([
          'providers',
          'add',
          'fixture',
          '--url',
          server.url + '/v1',
          '--protocol',
          'chat',
          '--catalog',
          'openai',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await cli(['auth', 'login', '--provider', 'fixture', '--alias', 'exec-test', '--env', 'EXEC_FIXTURE_KEY'])).code,
    ).toBe(0);
    expect((await cli(['models', 'select', 'fixture-model'])).code).toBe(0);
  };
  return {home, root, server, cli, configure, spawn, collect};
}

test('exec validates arguments (64), stdin and missing tool account (2) without a provider', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fyn-exec-args-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const cli = async (args: string[], input = '') => {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'exec', ...args], {
      env: {...process.env, FUTRYN_HOME: home},
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(input);
    child.stdin.end();
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return code;
  };
  for (const args of [
    [],
    ['hi', '--approval', 'yes'],
    ['hi', '--sandbox', 'oops'],
    ['hi', '--approval', 'never', '--ask-for-approval', 'on-request'],
    ['hi', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'read-only'],
    ['hi', '--yolo', '--sandbox', 'read-only'],
    ['hi', '--yolo', '--full-auto'],
    ['hi', '--full-auto', '--approval', 'never'],
    ['hi', '--unknown'],
    ['a', 'b'],
    ['-C'],
    ['hi', '--cd', join(home, 'missing')],
  ]) {
    expect(await cli(args)).toBe(64);
  }
  expect(await cli(['-', '--cd', home], '   ')).toBe(64);
  expect(await cli(['hi', '--cd', home])).toBe(2);
  expect(await cli(['-', '--cd', home], 'stdin prompt')).toBe(2);
}, 30_000);

test('exec streams valid JSONL, reads stdin -, selects account/model and saves only the final response', async () => {
  const x = context();
  await x.configure();
  x.server.set({
    script: view =>
      view.results.length
        ? {text: 'FINAL exec-fixture-secret'}
        : {text: 'intermediate', calls: [{name: 'read', input: {path: '.'}}]},
  });
  const output = join(x.root, 'last.txt');
  const result = await x.cli(
    ['exec', '-', '-C', x.root, '--json', '-o', output, '--account', 'exec-test', '--model', 'fixture-model'],
    'stdin prompt',
  );
  expect(result.code).toBe(0);
  const events = result.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({contractVersion: '1.31', type: 'turn.completed'});
  expect(events.some(e => e.type === 'toolResult' && e.result.status === 'ok')).toBe(true);
  expect(readFileSync(output, 'utf8')).toBe('FINAL [REDACTED]\n');
  expect(JSON.stringify(x.server.requests)).toContain('stdin prompt');
});

test('exec -o never follows a symlink planted at the output path', async () => {
  const x = context();
  await x.configure();
  x.server.set({script: () => ({text: 'FINAL'})});
  const victim = join(x.root, 'victim.txt');
  writeFileSync(victim, 'original');
  const link = join(x.root, 'link.txt');
  symlinkSync(victim, link);
  const result = await x.cli([
    'exec',
    'hi',
    '-C',
    x.root,
    '-o',
    link,
    '--account',
    'exec-test',
    '--model',
    'fixture-model',
  ]);
  expect(result.code).toBe(1);
  expect(readFileSync(victim, 'utf8')).toBe('original');
});

test('exec requires explicit folder consent and never waits for approval without a TTY', async () => {
  const x = context();
  await x.configure();
  expect((await x.cli(['exec', 'hi'])).code).toBe(2);
  x.server.set({toolCall: {name: 'web_fetch', args: JSON.stringify({url: 'https://example.com'})}});
  const result = await x.cli(['exec', 'fetch', '--cd', x.root, '--json']);
  expect(result.code).toBe(0);
  const events = result.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(events.some(e => e.type === 'toolResult' && e.result.status === 'denied')).toBe(true);
  expect(events.some(e => e.type === 'permission.requested')).toBe(false);
  expect(JSON.stringify(x.server.requests.at(-1)?.body)).toContain('denied');
}, 30_000);

test('exec cancels provider work cleanly on SIGINT and SIGTERM (1)', async () => {
  const x = context();
  await x.configure();
  x.server.set({delay: 5000});
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const before = x.server.requests.length;
    const child = x.spawn(['exec', 'wait', '--cd', x.root, '--json']);
    while (x.server.requests.length === before) await Bun.sleep(10);
    child.kill(signal);
    const result = await x.collect(child);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      type: 'turn.failed',
      error: {code: 'CANCELLED'},
    });
  }
}, 15000);

test('exec reports provider turn failure as exit 1 and a terminal JSONL failure', async () => {
  const x = context();
  await x.configure();
  x.server.set({status: 401});
  const result = await x.cli(['exec', 'fail', '--cd', x.root, '--json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
    type: 'turn.failed',
    error: {code: 'AUTH'},
  });
});

test.skipIf(process.platform !== 'darwin')(
  'exec --sandbox danger-full-access and --dangerously-bypass-approvals-and-sandbox run unsandboxed with stderr warning',
  async () => {
    const x = context();
    await x.configure();
    const outside = join(tmpdir(), `fyn-exec-dfa-${crypto.randomUUID()}`);
    cleanup.push(() => rmSync(outside, {force: true}));
    x.server.set({
      script: view =>
        view.results.length ? {text: 'DONE'} : {calls: [{name: 'exec_command', input: {cmd: `touch ${outside}`}}]},
    });
    const result = await x.cli(
      [
        'exec',
        'write marker',
        '--cd',
        x.root,
        '--sandbox',
        'danger-full-access',
        '--json',
        '--account',
        'exec-test',
        '--model',
        'fixture-model',
      ],
      '',
      {FUTRYN_COMMAND_BACKEND: 'native'},
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('WARNING: Full Access');
    expect(existsSync(outside)).toBe(true);
    const events = result.stdout
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(events.some(e => e.type === 'permission.requested')).toBe(false);
    expect(events.at(-1)).toMatchObject({contractVersion: '1.31', type: 'turn.completed'});

    rmSync(outside, {force: true});
    const yolo = await x.cli(
      [
        'exec',
        'write marker again',
        '-C',
        x.root,
        '--dangerously-bypass-approvals-and-sandbox',
        '--account',
        'exec-test',
        '--model',
        'fixture-model',
      ],
      '',
      {FUTRYN_COMMAND_BACKEND: 'native'},
    );
    expect(yolo.code).toBe(0);
    expect(yolo.stderr).toContain('WARNING: Full Access');
    expect(existsSync(outside)).toBe(true);

    rmSync(outside, {force: true});
    const yoloAlias = await x.cli(
      [
        'exec',
        'write marker with --yolo',
        '-C',
        x.root,
        '--yolo',
        '--account',
        'exec-test',
        '--model',
        'fixture-model',
      ],
      '',
      {FUTRYN_COMMAND_BACKEND: 'native'},
    );
    expect(yoloAlias.code).toBe(0);
    expect(yoloAlias.stderr).toContain('WARNING: Full Access');
    expect(existsSync(outside)).toBe(true);
  },
  20_000,
);
