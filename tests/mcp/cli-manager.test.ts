import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {parseMcpCli, readMcpLockfile, safeMcpOutput} from '../../apps/cli/src/mcp-cli';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

test('MCP CLI maps human actions and preserves command argv without a shell', () => {
  expect(parseMcpCli(['add', 'fixture', '--', '/bin/server', '--flag', 'space value']).action).toEqual({
    type: 'add',
    name: 'fixture',
    config: {transport: 'stdio', command: '/bin/server', args: ['--flag', 'space value']},
  });
  expect(parseMcpCli(['add', 'remote', '--url', 'https://example.com/mcp']).action).toEqual({
    type: 'add',
    name: 'remote',
    config: {transport: 'http', url: 'https://example.com/mcp'},
  });
  expect(parseMcpCli(['search', 'code tools', '--cursor', 'next']).action).toEqual({
    type: 'search',
    query: 'code tools',
    cursor: 'next',
  });
  for (const type of ['login', 'logout', 'enable', 'disable', 'reconnect', 'doctor', 'remove'] as const)
    expect(parseMcpCli([type, 'fixture']).action).toEqual({type, name: 'fixture'});
  expect(parseMcpCli([]).command).toBe('list');
  expect(parseMcpCli(['list', '--managed', '--json']).values.managed).toBe(true);
});

test('MCP CLI rejects ambiguous targets, secret argv and unrelated flags before performing work', () => {
  for (const args of [
    ['credentials', 'fixture', 'secret'],
    ['credentials', 'fixture', '--bearer', 'secret'],
    ['credentials', 'fixture', '--clear', '--bearer-stdin'],
    ['add', 'x', '--url', 'https://example.com', '--command', 'server'],
    ['add', 'x', '--command', 'server', '--args', '{}'],
    ['install', 'x', '--package', 'one', '--package', 'two', '--version', '1.0.0'],
    ['remove', 'x', 'y'],
    ['list', '--url', 'https://example.com'],
    ['install'],
  ])
    expect(() => parseMcpCli(args)).toThrow();
});

test('install lock inputs are bounded regular JSON files and never symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-cli-lock-'));
  roots.push(root);
  const path = join(root, 'lock.json');
  writeFileSync(path, '{"lockfileVersion":3}');
  expect(readMcpLockfile(path)).toEqual({lockfileVersion: 3});
  symlinkSync(path, join(root, 'link.json'));
  expect(() => readMcpLockfile(join(root, 'link.json'))).toThrow();
  expect(() => readMcpLockfile(root)).toThrow();
  writeFileSync(path, ' '.repeat(512 * 1024 + 1));
  expect(() => readMcpLockfile(path)).toThrow();
});

test('MCP JSON redacts decoded strings and remains valid with escaped secrets', () => {
  const secret = 'token"\\value';
  const result = safeMcpOutput({message: `failure ${secret}`, nested: [secret], [secret]: true}, text =>
    text.replaceAll(secret, '[REDACTED]'),
  );
  const encoded = JSON.stringify(result);
  expect(JSON.parse(encoded)).toEqual({message: 'failure [REDACTED]', nested: ['[REDACTED]'], '[REDACTED]': true});
  expect(encoded).not.toContain('token');
});

test('MCP human CLI manages a real local server across restarts without a provider account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-cli-manager-'));
  roots.push(root);
  const entry = resolve('apps/cli/src/index.ts');
  const fixture = resolve('tests/fixtures/mcp-stdio-server.ts');
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, entry, 'mcp', ...args, '--json'], {
      cwd: root,
      env: {...process.env, COSMEW_HOME: root, FUTRYN_HOME: root, HANNES_HOME: root},
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({code, stderr: code === 0 ? '' : stderr}).toEqual({code: 0, stderr: ''});
    return JSON.parse(stdout);
  };
  const added = await run('add', 'fixture', '--command', process.execPath, '--args', JSON.stringify([fixture]));
  expect(added.snapshot.servers[0]).toMatchObject({name: 'fixture', connection: 'connected', toolCount: 1});
  expect(await run('get', 'fixture')).toMatchObject({
    name: 'fixture',
    source: 'manual',
    installation: {state: 'unmanaged'},
  });
  expect((await run('disable', 'fixture')).snapshot.servers[0]).toMatchObject({
    enabled: false,
    connection: 'disabled',
    toolCount: 0,
  });
  expect((await run('list', '--managed')).servers[0]).toMatchObject({name: 'fixture', enabled: false});
  expect((await run('enable', 'fixture')).snapshot.servers[0]).toMatchObject({enabled: true, connection: 'connected'});
  expect((await run('doctor', 'fixture')).snapshot.servers[0]).toMatchObject({connection: 'connected', toolCount: 1});
  expect((await run('recommended')).entries.length).toBeGreaterThan(0);
  expect((await run('remove', 'fixture')).snapshot.servers).toEqual([]);
  expect((await run('list', '--managed')).servers).toEqual([]);
}, 30_000);

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'GitHub MCP CLI login reaches the hidden credential prompt and can cancel',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-github-login-'));
    roots.push(root);
    writeFileSync(
      join(root, 'mcp.json'),
      JSON.stringify({mcpServers: {work: {url: 'https://api.githubcopilot.com/mcp/', enabled: false}}}),
      {mode: 0o600},
    );
    const entry = resolve('apps/cli/src/index.ts');
    const argv = [process.execPath, entry, 'mcp', 'login', 'work'];
    const options = {cwd: root, env: {...process.env, COSMEW_HOME: root}};
    const batch = Bun.spawn(argv, {...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
    const [status, error] = await Promise.all([batch.exited, new Response(batch.stderr).text()]);
    expect(status).not.toBe(0);
    expect(error).toContain('cosmew mcp credentials work');

    let output = '';
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 24,
      data: (_terminal, data) => {
        output += Buffer.from(data).toString('utf8');
      },
    });
    const child = Bun.spawn(argv, {...options, terminal});
    try {
      const deadline = Date.now() + 4000;
      while (!output.includes('GitHub personal access token (hidden):') && Date.now() < deadline) await Bun.sleep(10);
      expect(output).toContain('GitHub personal access token (hidden):');
      terminal.write('\x03');
      expect(await child.exited).not.toBe(0);
    } finally {
      child.kill();
      await child.exited;
      terminal.close();
    }
  },
  10_000,
);
