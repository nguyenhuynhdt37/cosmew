import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {McpHub, parseMcpConfig} from '@cosmew/mcp';
import {Redactor, SessionGrants, registerConfigSecrets} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, ToolDispatcher, type ApprovalRequest} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {openUserMcp} from '../../apps/cli/src/bootstrap/mcp';

const SECRET = 'fixture-token-value';
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.ts');
const cleanup: (() => void)[] = [];
const pids = new Set<number>();

afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  pids.clear();
  for (const finish of cleanup.splice(0)) finish();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('mcp.json accepts stdio and http entries and rejects shells, sse and secrets in problems', () => {
  const parsed = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        local: {command: process.execPath, args: ['server.ts'], env: {TOKEN: SECRET}},
        remote: {url: 'https://example.com/mcp', headers: {Authorization: 'Bearer secret'}},
        shell: {command: 'bun;touch'},
        old: {type: 'sse', url: 'https://example.com/sse'},
        creds: {url: 'https://user:pass@example.com/mcp'},
      },
    }),
  );
  expect(parsed.servers.map(server => server.name)).toEqual(['local', 'remote']);
  expect(parsed.problems.join('\n')).not.toContain(SECRET);
  expect(parsed.problems.join('\n')).not.toContain('Bearer');
  expect(parsed.problems.some(problem => problem.startsWith('shell:'))).toBe(true);
  expect(parsed.problems.some(problem => problem.includes('sse'))).toBe(true);
  expect(parsed.problems.some(problem => problem.startsWith('creds:'))).toBe(true);
  expect(parseMcpConfig('{}').problems).toEqual(['mcp.json has no mcpServers object.']);
  expect(parseMcpConfig('x'.repeat(256 * 1024 + 1)).problems[0]).toContain('256 KiB');
});

test('a stdio server lists echo, skips a bad name, redacts the call and dies on close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-mcp-hub-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  const probe = join(dir, 'probe.json');
  process.env.PARENT_SECRET = 'parent-should-not-leak';
  cleanup.push(() => {
    delete process.env.PARENT_SECRET;
  });
  const hub = new McpHub(
    [
      {
        name: 'fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [FIXTURE],
        env: {TOKEN: SECRET, FIXTURE_PROBE: probe},
      },
    ],
    {redact: text => text.split(SECRET).join('[REDACTED]'), configPath: join(dir, 'mcp.json')},
  );
  cleanup.push(() => void hub.close());
  const snapshot = await hub.connect();
  expect(snapshot.servers).toEqual([{name: 'fixture', transport: 'stdio', state: 'connected', tools: 1}]);
  expect(hub.tools().map(tool => tool.name)).toEqual(['mcp__fixture__echo']);
  const text = await hub.call('mcp__fixture__echo', {text: `hi ${SECRET}`});
  expect(text).toContain('echo:hi');
  expect(text).not.toContain(SECRET);
  expect(text).toContain('[REDACTED]');
  const seen = JSON.parse(readFileSync(probe, 'utf8')) as {pid: number; hasParentSecret: boolean; token: string};
  pids.add(seen.pid);
  expect(seen.hasParentSecret).toBe(false);
  expect(seen.token).toBe(SECRET);
  await hub.close();
  expect(alive(seen.pid)).toBe(false);
  pids.delete(seen.pid);
}, 20000);

test('the dispatcher asks, denies in plan and read-only, and remembers a session grant', async () => {
  const call = async (mode: {
    answer?: 'deny' | 'once' | 'session';
    permissionMode?: 'default' | 'plan';
    readOnly?: boolean;
    analysisOnly?: boolean;
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'futryn-mcp-tool-'));
    cleanup.push(() => rmSync(root, {recursive: true, force: true}));
    const asked: ApprovalRequest[] = [];
    const calls: unknown[] = [];
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(root),
      grants: new SessionGrants(),
      stateDirectory: join(root, 'state'),
      analysisOnly: () => mode.analysisOnly === true,
      sandbox: () => ({
        ...DEFAULT_SANDBOX_CONFIG,
        readOnly: mode.readOnly ?? false,
        permissionMode: mode.permissionMode ?? 'default',
      }),
      approve: async request => {
        asked.push(request);
        return mode.answer ?? 'deny';
      },
      redact: text => text.split(SECRET).join('[REDACTED]'),
      mcp: {
        tools: () => [
          {
            name: 'mcp__fixture__echo',
            description: 'Echo',
            inputSchema: {type: 'object', properties: {text: {type: 'string'}}},
          },
        ],
        call: async (_name, args) => {
          calls.push(args);
          return `echo:${String(args.text)} ${SECRET}`;
        },
      },
    });
    const invoke = () => dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__echo', input: {text: 'hi'}});
    return {asked, calls, invoke, names: dispatcher.descriptors().map(tool => tool.name)};
  };

  const denied = await call({answer: 'deny'});
  expect(denied.names).toContain('mcp__fixture__echo');
  const refused = await denied.invoke();
  expect(refused.status).toBe('denied');
  expect(denied.calls).toHaveLength(0);
  expect(denied.asked.map(request => request.capability)).toEqual(['mcp.call']);

  const once = await call({answer: 'once'});
  const ran = await once.invoke();
  expect(ran.status).toBe('ok');
  expect(ran.content).toContain('echo:hi');
  expect(ran.content).not.toContain(SECRET);
  expect(once.asked).toHaveLength(1);

  const session = await call({answer: 'session'});
  expect((await session.invoke()).status).toBe('ok');
  expect((await session.invoke()).status).toBe('ok');
  expect(session.asked).toHaveLength(1);
  expect(session.calls).toHaveLength(2);

  for (const mode of [
    {permissionMode: 'plan' as const, readOnly: false},
    {readOnly: true},
    {analysisOnly: true, readOnly: false},
  ]) {
    const blocked = await call(mode);
    const result = await blocked.invoke();
    expect(result.status).toBe('denied');
    expect(result.code).toBe('MODE_RESTRICTED');
    expect(blocked.asked).toHaveLength(0);
    expect(blocked.calls).toHaveLength(0);
  }
});

async function cli(home: string, cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
    cwd,
    env: {
      ...process.env,
      COSMEW_HOME: home,
      FUTRYN_HOME: home,
      HANNES_HOME: home,
      PARENT_SECRET: 'parent-should-not-leak',
    },
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

test('cosmew mcp connects the user file, ignores project files, and status does not spawn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'futryn-mcp-home-'));
  const project = mkdtempSync(join(tmpdir(), 'futryn-mcp-project-'));
  cleanup.push(() => {
    rmSync(home, {recursive: true, force: true});
    rmSync(project, {recursive: true, force: true});
  });
  const probe = join(home, 'probe.json');
  const marker = join(project, 'marker');
  writeFileSync(
    join(home, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        fixture: {command: process.execPath, args: [FIXTURE], env: {TOKEN: SECRET, FIXTURE_PROBE: probe}},
      },
    }),
  );
  mkdirSync(join(project, '.futryn'));
  const evil = JSON.stringify({mcpServers: {evil: {command: '/usr/bin/touch', args: [marker]}}});
  writeFileSync(join(project, '.futryn', 'mcp.json'), evil);
  writeFileSync(join(project, '.mcp.json'), evil);

  const status = await cli(home, project, ['status', '--json']);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).capabilities.mcpIntegration).toBe('partial');
  expect(existsSync(probe)).toBe(false);
  expect(existsSync(marker)).toBe(false);

  const listed = await cli(home, project, ['mcp', 'list']);
  expect(listed.code).toBe(0);
  expect(listed.stdout).not.toContain(SECRET);
  expect(listed.stderr).not.toContain(SECRET);
  expect(listed.stdout).not.toContain('/usr/bin/touch');
  const report = JSON.parse(listed.stdout) as {
    servers: {name: string; transport: string; state: string; tools: number}[];
    ignoredProjectFiles: string[];
    note: string;
  };
  expect(report.servers).toEqual([{name: 'fixture', transport: 'stdio', state: 'connected', tools: 1}]);
  const projectReal = realpathSync(project);
  // The prior status command has migrated the legacy project state directory.
  expect(report.ignoredProjectFiles).toEqual([
    join(projectReal, '.cosmew', 'mcp.json'),
    join(projectReal, '.mcp.json'),
  ]);
  expect(report.note).toContain('not started');
  expect(existsSync(marker)).toBe(false);
  const seen = JSON.parse(readFileSync(probe, 'utf8')) as {pid: number; hasParentSecret: boolean; token: string};
  expect(alive(seen.pid)).toBe(false);
  expect(seen.hasParentSecret).toBe(false);
  expect(seen.token).toBe(SECRET);

  const rejected = await cli(home, project, ['mcp', 'install']);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain('INVALID_INPUT');
}, 30000);

test('openUserMcp registers only sensitive config secrets and URL passwords without over-redacting normal values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-open-user-mcp-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        local: {
          command: process.execPath,
          args: [FIXTURE],
          env: {
            DEBUG: '1',
            NODE_ENV: 'dev',
            LOG_LEVEL: 'info',
            PORT: '3000',
            API_TOKEN: 'secret-token-alpha-99',
            CUSTOM_VAR: 'ghp_1234567890abcdef',
          },
        },
        remote: {
          url: 'https://example.com/mcp',
          headers: {
            Accept: 'application/json',
            'X-Client': 'cosmew',
            Authorization: 'Bearer secret-bearer-omega-88',
            'X-Webhook-Url': 'https://user:url-pass-7777@example.com/hook',
          },
        },
      },
    }),
  );
  const redactor = new Redactor();
  const hub = openUserMcp(
    dir,
    text => redactor.text(text),
    secret => redactor.register(secret),
  );
  cleanup.push(() => void hub.close());

  const sample =
    'Step 1 in dev mode on port 3000 logs info as application/json from cosmew with secret-token-alpha-99, ghp_1234567890abcdef, secret-bearer-omega-88, and url-pass-7777.';
  const expected =
    'Step 1 in dev mode on port 3000 logs info as application/json from cosmew with [REDACTED], [REDACTED], [REDACTED], and [REDACTED].';
  expect(redactor.text(sample)).toBe(expected);

  const stream = redactor.stream();
  const chunks = [
    'Step 1 in dev ',
    'mode on port 3000 ',
    'logs info as application/',
    'json from cosmew with secret-',
    'token-alpha-99, ghp_123456',
    '7890abcdef, secret-bearer-',
    'omega-88, and url-pass-',
    '7777.',
  ];
  const streamed = chunks.map(chunk => stream.push(chunk)).join('') + stream.finish();
  expect(streamed).toContain('Step 1 in dev mode on port 3000 logs info as application/json from cosmew');
  expect(streamed).toBe(expected);
  for (const leaked of ['secret-token-alpha-99', 'ghp_1234567890abcdef', 'secret-bearer-omega-88', 'url-pass-7777'])
    expect(streamed).not.toContain(leaked);
});

test('Redactor.register ignores empty, whitespace-only, and ultra-short (< 3 char) strings while preserving 3+ char explicit secrets', () => {
  const redactor = new Redactor();
  for (const ignored of ['', '   ', '\t\n', '1', '0', 'on', 'no', '  a  ', ' xy ']) redactor.register(ignored);
  redactor.register('abc');
  redactor.register('valid-secret-99');

  const input = 'Flag 1 is on (no xy) with abc and valid-secret-99.';
  expect(redactor.text(input)).toBe('Flag 1 is on (no xy) with [REDACTED] and [REDACTED].');

  const stream = redactor.stream();
  const streamed =
    ['Flag 1 is on (no xy) ', 'with ab', 'c and valid-sec', 'ret-99.'].map(chunk => stream.push(chunk)).join('') +
    stream.finish();
  expect(streamed).toBe('Flag 1 is on (no xy) with [REDACTED] and [REDACTED].');
});

test('registerConfigSecrets avoids false-positive key words and extracts schemes, URL passwords, and token prefixes', () => {
  const registered: string[] = [];
  registerConfigSecrets(
    {
      MONKEY: 'banana-value',
      KEYBOARD: 'qwerty-value',
      COMPAT_MODE: 'legacy-mode',
      CONCERT_HALL: 'main-stage',
      AUTHOR_NAME: 'alice-smith',
      AUTH_ENABLED: 'true',
      SECRET_ENV: 'production',
      EMPTY: '   ',
      SHORT_TOKEN: 'abc',
      apiKey: 'camel-case-secret-1',
      githubPAT: 'pat-camel-secret-2',
      'X-Custom-Auth': 'apikey custom-api-cred-3',
      'X-Short-Auth': 'Bearer xyz',
      'X-Encoded-Hook': 'https://svc:p%40ss%3Asecret@example.com/hook',
      'X-Malformed-Hook': 'https://svc:raw%ZZsecret@example.com/hook',
      CUSTOM_JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig123',
      CUSTOM_GOOGLE: 'AIzaSyD1234567890abcdef',
    },
    secret => registered.push(secret),
  );

  for (const benign of [
    'banana-value',
    'qwerty-value',
    'legacy-mode',
    'main-stage',
    'alice-smith',
    'true',
    'production',
    'abc',
    'xyz',
  ])
    expect(registered).not.toContain(benign);

  expect(registered).toContain('camel-case-secret-1');
  expect(registered).toContain('pat-camel-secret-2');
  expect(registered).toContain('apikey custom-api-cred-3');
  expect(registered).toContain('custom-api-cred-3');
  expect(registered).toContain('Bearer xyz');
  expect(registered).toContain('p%40ss%3Asecret');
  expect(registered).toContain('p@ss:secret');
  expect(registered).toContain('raw%ZZsecret');
  expect(registered).toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig123');
  expect(registered).toContain('AIzaSyD1234567890abcdef');
});
