import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fixtureServer} from '../fixtures';
import {writeSandboxSettings} from '../sandbox-config';

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
      env: {...process.env, COSMEW_HOME: home, EXEC_FIXTURE_KEY: 'exec-fixture-secret', ...extraEnv},
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

test('exec --json keeps the one-time sandbox notice on stderr in an isolated state directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fyn-exec-notice-'));
  const workspace = mkdtempSync(join(tmpdir(), 'fyn-exec-notice-project-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(workspace, {recursive: true, force: true}),
  );
  for (const first of [true, false]) {
    const child = Bun.spawn(
      [process.execPath, resolve('apps/cli/src/index.ts'), 'exec', 'work', '--cd', workspace, '--json'],
      {
        env: {...process.env, COSMEW_HOME: home},
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(2); // No account: no provider or command process is required for this regression.
    expect(
      stdout
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
    ).toEqual([expect.objectContaining({type: 'turn.failed', error: expect.objectContaining({code: 'AUTH'})})]);
    expect(stderr.includes('Notice: Sandbox is now off by default')).toBe(first);
  }
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  expect(settings).toMatchObject({sandboxDefaultsNoticeVersion: 1});
  expect(Object.hasOwn(settings, 'sandbox')).toBe(false);
});

test('exec validates arguments (64), stdin and missing tool account (2) without a provider', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fyn-exec-args-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const cli = async (args: string[], input = '') => {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'exec', ...args], {
      env: {...process.env, COSMEW_HOME: home},
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
    ['hi', '--permission-mode', 'auto'],
    ['hi', '--permission-mode', 'default', '--dangerously-skip-permissions'],
    ['hi', '--allowedTools', 'Bogus(x)'],
    ['hi', '--approval', 'never'],
    ['hi', '--sandbox', 'read-only'],
    ['hi', '--yolo'],
    ['hi', '--full-auto'],
    ['hi', '--dangerously-bypass-approvals-and-sandbox'],
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
  expect(events.at(-1)).toMatchObject({contractVersion: '1.69', type: 'turn.completed'});
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

/** One headless run against a scripted model that makes the given tool calls, once each. */
async function scripted(
  x: ReturnType<typeof context>,
  calls: {name: string; input: Record<string, unknown>}[],
  flags: string[],
  files: Record<string, unknown> = {},
) {
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(x.root, path, '..'), {recursive: true});
    writeFileSync(join(x.root, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  x.server.set({script: view => (view.results.length ? {text: 'DONE'} : {calls})});
  const result = await x.cli(
    ['exec', 'work', '--cd', x.root, '--json', '--account', 'exec-test', '--model', 'fixture-model', ...flags],
    '',
    {COSMEW_COMMAND_BACKEND: 'native'},
  );
  const events = result.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  return {...result, events, results: events.filter(e => e.type === 'toolResult').map(e => e.result)};
}

test.skipIf(process.platform !== 'darwin')(
  'exec permission flags: without a TTY whatever would ask is denied, flags select the mode, the sandbox always applies',
  async () => {
    const x = context();
    // Sandbox flag acceptance opts in; ADR 0081 leaves ordinary launches off.
    writeSandboxSettings(x.home);
    await x.configure();
    const outside = join(tmpdir(), `fyn-exec-outside-${crypto.randomUUID()}`);
    cleanup.push(() => rmSync(outside, {force: true}));
    const edit = {name: 'write', input: {path: 'notes.md', content: 'ok\n'}};
    const escape = {name: 'exec_command', input: {cmd: `touch ${outside}`}};
    const notes = () => existsSync(join(x.root, 'notes.md'));

    // default: a sandboxed command runs without asking, the edit would ask and is denied (no TTY, no event).
    const plain = await scripted(x, [edit, escape], []);
    expect(plain.code).toBe(0);
    expect(plain.results.map(r => r.status)).toEqual(['denied', 'error']);
    expect(plain.results[1].code).toBe('SANDBOX_DENIED');
    expect(plain.events.some(e => e.type === 'permission.requested')).toBe(false);
    expect(notes()).toBe(false);
    expect(existsSync(outside)).toBe(false);
    expect(plain.stderr).not.toContain('WARNING');

    // acceptEdits approves the edit.
    expect((await scripted(x, [edit], ['--permission-mode', 'acceptEdits'])).results[0].status).toBe('ok');
    expect(notes()).toBe(true);
    rmSync(join(x.root, 'notes.md'));

    // plan refuses edits and commands.
    const plan = await scripted(x, [edit, {name: 'exec_command', input: {cmd: 'ls'}}], ['--permission-mode', 'plan']);
    expect(plan.results.map(r => r.status)).toEqual(['denied', 'denied']);
    expect(notes()).toBe(false);

    // --allowedTools / --disallowedTools behave like `claude -p`.
    expect((await scripted(x, [edit], ['--allowedTools', 'Edit'])).results[0].status).toBe('ok');
    rmSync(join(x.root, 'notes.md'));
    const disallowed = await scripted(x, [edit], ['--permission-mode', 'acceptEdits', '--disallowedTools', 'Edit']);
    expect(disallowed.results[0].status).toBe('denied');
    expect(notes()).toBe(false);

    // --dangerously-skip-permissions: warning, no prompts, edit approved - but the OS sandbox still applies.
    const bypass = await scripted(x, [edit, escape], ['--dangerously-skip-permissions']);
    expect(bypass.code).toBe(0);
    expect(bypass.stderr).toContain('WARNING: bypassPermissions');
    expect(bypass.results[0].status).toBe('ok');
    expect(bypass.results[1].code).toBe('SANDBOX_DENIED');
    expect(existsSync(outside)).toBe(false);
    expect(bypass.events.some(e => e.type === 'permission.requested')).toBe(false);
    expect(bypass.events.at(-1)).toMatchObject({contractVersion: '1.69', type: 'turn.completed'});
  },
  60_000,
);

test.skipIf(process.platform !== 'darwin')(
  'exec bypass with sandbox off permits external cwd, while ask and deny rules still prevent execution without a TTY',
  async () => {
    const x = context();
    await x.configure();
    const outside = mkdtempSync(join(tmpdir(), 'cosmew-bypass-cwd-'));
    cleanup.push(() => rmSync(outside, {recursive: true, force: true}));
    const proof = join(outside, 'proof.txt');
    const call = {name: 'exec_command', input: {cmd: 'printf approved > proof.txt', workdir: outside}};
    const normal = await scripted(x, [call], []);
    expect(normal.results[0].status).toBe('denied');
    expect(existsSync(proof)).toBe(false);
    const bypass = await scripted(x, [call], ['--dangerously-skip-permissions']);
    expect(bypass.code).toBe(0);
    expect(bypass.results[0].status).toBe('ok');
    expect(readFileSync(proof, 'utf8')).toBe('approved');
    expect(bypass.events.some(event => event.type === 'permission.requested')).toBe(false);
    rmSync(proof);
    writeFileSync(
      join(x.home, 'settings.json'),
      JSON.stringify({permissions: {ask: ['Bash(printf:*)']}, sandbox: {enabled: false}}),
    );
    const asked = await scripted(x, [call], ['--dangerously-skip-permissions']);
    expect(asked.results[0].status).toBe('denied');
    expect(existsSync(proof)).toBe(false);
    const denied = await scripted(x, [call], ['--dangerously-skip-permissions', '--disallowedTools', 'Bash(printf:*)']);
    expect(denied.results[0].status).toBe('denied');
    expect(existsSync(proof)).toBe(false);
  },
  30000,
);

test.skipIf(process.platform !== 'darwin')(
  'exec reads settings files: user settings apply, repository settings that loosen are ignored with a notice, deny rules always apply',
  async () => {
    const x = context();
    await x.configure();
    const edit = {name: 'write', input: {path: 'notes.md', content: 'ok\n'}};
    // A repository file tries to allow edits, disable the sandbox and deny a path.
    const repo = {
      permissions: {allow: ['Edit'], deny: ['Edit(secret/**)']},
      sandbox: {enabled: false},
    };
    const ignored = await scripted(x, [edit, {name: 'write', input: {path: 'secret/a.txt', content: 'x'}}], [], {
      '.futryn/settings.json': repo,
    });
    expect(ignored.results.map(r => r.status)).toEqual(['denied', 'denied']);
    expect(ignored.stderr).toContain('ignoring the loosening parts of');
    expect(ignored.stderr).toContain('allow rule: Edit');
    expect(existsSync(join(x.root, 'notes.md'))).toBe(false);
    // The user's own settings.json is trusted: its allow rule applies, the repository deny rule still wins.
    writeFileSync(join(x.home, 'settings.json'), JSON.stringify({permissions: {allow: ['Edit']}}), {mode: 0o600});
    const trusted = await scripted(x, [edit, {name: 'write', input: {path: 'secret/a.txt', content: 'x'}}], []);
    expect(trusted.results.map(r => r.status)).toEqual(['ok', 'denied']);
    expect(readFileSync(join(x.root, 'notes.md'), 'utf8')).toBe('ok\n');
    // permissions.defaultMode of the user settings is the starting mode.
    rmSync(join(x.root, 'notes.md'));
    writeFileSync(join(x.home, 'settings.json'), JSON.stringify({permissions: {defaultMode: 'plan'}}), {mode: 0o600});
    expect((await scripted(x, [edit], [])).results[0].status).toBe('denied');
  },
  60_000,
);
