import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {FileMcpSettings} from '@cosmew/persistence';
import {McpManager} from '../../apps/cli/src/bootstrap/mcp-manager';
import type {CredentialVault} from '@cosmew/contracts';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
function fixture(fetcher?: typeof fetch) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-manager-')));
  clean.push(() => rmSync(directory, {recursive: true, force: true}));
  const values = new Map<string, string>();
  const vault: CredentialVault = {
    get: async ref => (ref.kind === 'keyring' ? values.get(ref.key) : undefined),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async ref => {
      if (ref.kind === 'keyring') values.delete(ref.key);
    },
  };
  let invalidated = 0;
  const manager = new McpManager({
    directory,
    vault,
    fetch: fetcher,
    redact: t => t,
    registerSecret: () => {},
    openURL: async () => {
      throw new Error('no browser');
    },
    onChange: () => invalidated++,
  });
  clean.push(() => manager.hub.close());
  return {directory, manager, vault, invalidated: () => invalidated};
}
test('user MCP settings preserve unknown fields, reject lost updates, symlinks and unsafe modes', () => {
  const f = fixture();
  writeFileSync(join(f.directory, 'mcp.json'), JSON.stringify({other: {keep: true}, mcpServers: {}}));
  const store = new FileMcpSettings(f.directory),
    original = store.read();
  store.update(original.revision, d => {
    d.mcpServers.docs = {url: 'https://example.com/mcp'};
  });
  expect(store.read().document.other).toEqual({keep: true});
  expect(() =>
    store.update(original.revision, d => {
      d.mcpServers = {};
    }),
  ).toThrow();
  expect(statSync(join(f.directory, 'mcp.json')).mode & 0o777).toBe(0o600);
  rmSync(join(f.directory, 'mcp.json'));
  writeFileSync(join(f.directory, 'outside'), 'untouched');
  symlinkSync(join(f.directory, 'outside'), join(f.directory, 'mcp.json'));
  expect(() => store.read()).toThrow();
  expect(readFileSync(join(f.directory, 'outside'), 'utf8')).toBe('untouched');
});
test('manager add/disable/enable/reconnect/remove/reopen operates actual stdio without a provider account', async () => {
  const f = fixture();
  const initial = await f.manager.snapshot();
  expect(initial.servers).toEqual([]);
  const add = await f.manager.perform({
    type: 'add',
    name: 'fixture',
    config: {transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-stdio-server.ts')]},
  });
  expect(add.snapshot.servers[0]).toMatchObject({
    name: 'fixture',
    connection: 'connected',
    auth: {state: 'not-required'},
    installation: {state: 'unmanaged'},
    toolCount: 1,
  });
  expect(await f.manager.hub.call('mcp__fixture__echo', {text: 'works'})).toContain('works');
  const off = await f.manager.perform({type: 'disable', name: 'fixture'});
  expect(off.snapshot.servers[0]?.connection).toBe('disabled');
  expect(f.manager.hub.tools()).toEqual([]);
  await expect(f.manager.hub.call('mcp__fixture__echo', {})).rejects.toMatchObject({code: 'NOT_FOUND'});
  expect(JSON.parse(readFileSync(join(f.directory, 'mcp.json'), 'utf8')).mcpServers.fixture.enabled).toBe(false);
  expect((await f.manager.perform({type: 'enable', name: 'fixture'})).snapshot.servers[0]?.connection).toBe(
    'connected',
  );
  expect((await f.manager.perform({type: 'reconnect', name: 'fixture'})).snapshot.servers[0]?.toolCount).toBe(1);
  await expect(
    f.manager.perform({type: 'add', name: 'fixture', config: {transport: 'stdio', command: 'echo'}}),
  ).rejects.toMatchObject({code: 'INVALID_INPUT'});
  expect((await f.manager.perform({type: 'remove', name: 'fixture'})).snapshot.servers).toEqual([]);
  expect(f.invalidated()).toBeGreaterThanOrEqual(4);
});
test('bad config is not overwritten; unsafe names and cancelled actions never change configuration', async () => {
  const f = fixture();
  writeFileSync(join(f.directory, 'mcp.json'), 'bad');
  expect((await f.manager.snapshot()).problems).toHaveLength(1);
  await expect(
    f.manager.perform({type: 'add', name: 'new', config: {transport: 'http', url: 'https://example.com/mcp'}}),
  ).rejects.toMatchObject({code: 'STORAGE'});
  expect(readFileSync(join(f.directory, 'mcp.json'), 'utf8')).toBe('bad');
  await expect(f.manager.perform({type: 'remove', name: '__proto__'})).rejects.toMatchObject({code: 'INVALID_INPUT'});
  const controller = new AbortController();
  controller.abort();
  await expect(f.manager.perform({type: 'remove', name: 'x'}, controller.signal)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
});
test('remote auth-free connect stores no fake local version and bearer credentials never enter config or public view', async () => {
  const f = fixture();
  let header: string | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, {status: 405});
      header = req.headers.get('authorization');
      const m = (await req.json()) as any;
      if (m.id === undefined) return new Response(null, {status: 202});
      return Response.json({
        jsonrpc: '2.0',
        id: m.id,
        result:
          m.method === 'initialize'
            ? {
                protocolVersion: m.params.protocolVersion,
                capabilities: {tools: {}},
                serverInfo: {name: 'fixture', version: '1'},
              }
            : m.method === 'tools/list'
              ? {tools: []}
              : {},
      });
    },
  });
  clean.push(() => server.stop(true));
  const added = await f.manager.perform({
    type: 'add',
    name: 'docs',
    config: {transport: 'http', url: `http://127.0.0.1:${server.port}/mcp`},
  });
  expect(added.snapshot.servers[0]).toMatchObject({
    connection: 'connected',
    auth: {state: 'not-required'},
    installation: {state: 'not-applicable'},
  });
  const result = await f.manager.perform({type: 'credentials', name: 'docs', bearer: 'fixture-private-token'});
  expect(String(header)).toBe('Bearer fixture-private-token');
  expect(result.snapshot.servers[0]?.auth.state).toBe('authorized');
  expect(JSON.stringify(result)).not.toContain('fixture-private-token');
  expect(readFileSync(join(f.directory, 'mcp.json'), 'utf8')).not.toContain('fixture-private-token');
  await f.manager.perform({
    type: 'add',
    name: 'alias',
    config: {transport: 'http', url: `http://127.0.0.1:${server.port}/mcp`},
  });
  expect((await f.manager.snapshot()).servers.find(server => server.name === 'alias')?.connection).toBe('connected');
  const logout = await f.manager.perform({type: 'logout', name: 'docs'});
  expect(logout.snapshot.servers.find(server => server.name === 'alias')?.connection).toBe('needs-auth');
  expect(f.manager.hub.tools()).toEqual([]);
  await f.manager.perform({type: 'credentials', name: 'alias', bearer: 'fixture-next-token'});
  expect(header === 'Bearer fixture-next-token').toBe(true);
  await f.manager.perform({type: 'remove', name: 'alias'});
  expect((await f.manager.snapshot()).servers.find(server => server.name === 'docs')?.auth.state).toBe('authorized');
  expect(logout.logout).toMatchObject({localCleared: true, remoteStatus: 'not-needed'});
  expect(logout.snapshot.servers[0]?.auth.state).toBe('needs-login');
});

test('invalid configured entries stay visible and can be repaired or removed; oversized lists can shrink', async () => {
  const f = fixture();
  const entries = Object.fromEntries(Array.from({length: 18}, (_, i) => ['broken' + i, {command: ''}]));
  writeFileSync(join(f.directory, 'mcp.json'), JSON.stringify({mcpServers: entries}));
  expect((await f.manager.snapshot()).servers).toHaveLength(18);
  await f.manager.perform({type: 'remove', name: 'broken0'});
  expect((await f.manager.snapshot()).servers).toHaveLength(17);
  await f.manager.perform({type: 'remove', name: 'broken1'});
  expect((await f.manager.snapshot()).servers).toHaveLength(16);
  const repaired = await f.manager.perform({
    type: 'edit',
    name: 'broken2',
    config: {transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-stdio-server.ts')]},
  });
  expect(repaired.snapshot.servers.find(server => server.name === 'broken2')?.connection).toBe('connected');
});

test('tool approval is fenced when the same-name MCP server changes registration identity', async () => {
  const {ToolDispatcher, DEFAULT_SANDBOX_CONFIG} = await import('@cosmew/tools');
  const {WorkspaceRoot} = await import('@cosmew/workspace');
  const {SessionGrants} = await import('@cosmew/security');
  const f = fixture();
  let identity = 'A',
    called = 0;
  let approve!: () => void;
  let asked!: () => void;
  const waiting = new Promise<void>(resolve => (asked = resolve));
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(f.directory),
    grants: new SessionGrants(),
    redact: t => t,
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode: 'default', readOnly: false}),
    approve: async () => {
      asked();
      await new Promise<void>(resolve => (approve = resolve));
      return 'once';
    },
    mcp: {
      tools: () => [{name: 'mcp__same__tool', description: 'same', inputSchema: {type: 'object'}, identity}],
      call: async () => {
        called++;
        return 'ok';
      },
    },
  });
  const run = dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__same__tool', input: {}});
  await waiting;
  identity = 'B';
  approve();
  expect((await run).status).toBe('denied');
  expect(called).toBe(0);
});

test('managed install registers only ready owned artifacts and removal cleans the package without touching other files', async () => {
  const {mkdirSync} = await import('node:fs');
  const f = fixture();
  const sri = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const manager = new McpManager({
    directory: f.directory,
    vault: f.vault,
    redact: t => t,
    registerSecret: () => {},
    openURL: async () => {},
    fetch: (async () =>
      Response.json({
        name: '@fixture/server',
        version: '1.0.0',
        dist: {integrity: sri, tarball: 'https://registry.npmjs.org/@fixture/server/-/server-1.0.0.tgz'},
      })) as unknown as typeof fetch,
    installRunner: async request => {
      const path = join(request.cwd, 'node_modules/@fixture/server');
      mkdirSync(path, {recursive: true});
      writeFileSync(
        join(path, 'package.json'),
        JSON.stringify({name: '@fixture/server', version: '1.0.0', bin: './server.js'}),
      );
      writeFileSync(
        join(path, 'server.js'),
        `const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'installed-fixture',version:'1'}}:m.method==='tools/list'?{tools:[]} : {};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`,
      );
    },
  });
  clean.push(() => manager.hub.close());
  const added = await manager.perform({
    type: 'install',
    name: 'installed',
    packageName: '@fixture/server',
    version: '1.0.0',
  });
  expect(added.snapshot.servers[0]?.installation.state).toBe('ready');
  expect(added.snapshot.servers[0]?.connection).toBe('connected');
  const config = JSON.parse(readFileSync(join(f.directory, 'mcp.json'), 'utf8'));
  const executable = config.mcpServers.installed.args[0];
  rmSync(executable);
  expect((await manager.snapshot()).servers[0]?.installation.state).toBe('missing');
  writeFileSync(join(f.directory, 'keep.txt'), 'keep');
  await manager.perform({type: 'remove', name: 'installed'});
  expect((await manager.snapshot()).servers).toEqual([]);
  expect(readFileSync(join(f.directory, 'keep.txt'), 'utf8')).toBe('keep');
});

test('real hub replacement cannot reuse a pending approval or a prior session grant with identical tool schema', async () => {
  const {McpHub} = await import('@cosmew/mcp');
  const {ToolDispatcher, DEFAULT_SANDBOX_CONFIG} = await import('@cosmew/tools');
  const {WorkspaceRoot} = await import('@cosmew/workspace');
  const {SessionGrants} = await import('@cosmew/security');
  const f = fixture();
  const script = resolve('tests/fixtures/mcp-stdio-server.ts');
  const a = {name: 'fixture', transport: 'stdio' as const, command: process.execPath, args: [script], env: {REV: 'A'}};
  const hub = new McpHub([a], {configPath: join(f.directory, 'mcp.json'), redact: t => t});
  clean.push(() => hub.close());
  await hub.connect();
  const first = hub.tools()[0]!.identity;
  let release!: () => void;
  let asked!: () => void;
  const ready = new Promise<void>(resolve => (asked = resolve));
  let calls = 0,
    prompts = 0;
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(f.directory),
    grants: new SessionGrants(),
    redact: t => t,
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode: 'default', readOnly: false}),
    approve: async () => {
      prompts++;
      if (prompts === 1) {
        asked();
        await new Promise<void>(resolve => (release = resolve));
      }
      return 'session';
    },
    mcp: {
      tools: () => hub.tools(),
      call: async (name, args, signal) => {
        calls++;
        return hub.call(name, args, signal);
      },
    },
  });
  const run = dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__echo', input: {text: 'x'}});
  await ready;
  await hub.replaceSpecs([{...a, env: {REV: 'B'}}]);
  expect(hub.tools()[0]!.identity).not.toBe(first);
  release();
  expect((await run).status).toBe('denied');
  expect(calls).toBe(0);
  expect(
    (await dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__echo', input: {text: 'x'}})).status,
  ).toBe('ok');
  expect(prompts).toBe(2);
  await hub.replaceSpecs([{...a, env: {REV: 'C'}}]);
  expect(
    (await dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__echo', input: {text: 'x'}})).status,
  ).toBe('ok');
  expect(prompts).toBe(3);
});

test('official GitHub MCP directs login to a PAT without starting browser OAuth', async () => {
  const f = fixture();
  const url = 'https://api.githubcopilot.com/mcp/';
  const store = new FileMcpSettings(f.directory);
  store.update(store.read().revision, document => {
    document.mcpServers.work = {url, enabled: false};
    document.mcpServers.lookalike = {url: 'https://api.githubcopilot.com.example.com/mcp/', enabled: false};
  });
  const snapshot = await f.manager.snapshot();
  expect(snapshot.servers.find(server => server.name === 'work')?.auth).toMatchObject({method: 'github-pat'});
  expect(snapshot.servers.find(server => server.name === 'lookalike')?.auth).not.toHaveProperty('method');
  await expect(f.manager.perform({type: 'login', name: 'work'})).rejects.toThrow('cosmew mcp credentials work');
  await expect(f.manager.perform({type: 'login', name: 'lookalike', bearer: 'test-token'})).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  const result = await f.manager.perform({type: 'login', name: 'work', bearer: 'test-token'});
  expect(await f.manager.auth.bearer(url)).toBe('test-token');
  expect(JSON.stringify(result)).not.toContain('test-token');
  expect(readFileSync(join(f.directory, 'mcp.json'), 'utf8')).not.toContain('test-token');
});

test('GitHub HTTP 401 stays in the credential flow without OAuth discovery', async () => {
  const requests: {url: string; authenticated: boolean}[] = [];
  const url = 'https://api.githubcopilot.com/mcp/';
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authenticated: new Headers(init?.headers).get('authorization') === 'Bearer fixture-pat',
      });
      return new Response(null, {status: 401});
    },
    {preconnect: () => {}},
  );
  const f = fixture(fetcher);
  const added = await f.manager.perform({type: 'add', name: 'github', config: {transport: 'http', url}});
  expect(added.snapshot.servers[0]).toMatchObject({
    connection: 'needs-auth',
    auth: {state: 'needs-login', method: 'github-pat'},
  });
  const retried = await f.manager.perform({type: 'login', name: 'github', bearer: 'fixture-pat'});
  expect(retried.snapshot.servers[0]).toMatchObject({connection: 'needs-auth', auth: {state: 'needs-login'}});
  expect(requests.every(request => request.url === url)).toBe(true);
  expect(requests.some(request => request.authenticated)).toBe(true);
});

test('new MCP configuration diagnoses a registered-client requirement and fences the token fallback', async () => {
  const origin = 'http://127.0.0.1:39199';
  const url = origin + '/mcp';
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === url)
        return new Response(null, {
          status: 401,
          headers: {'WWW-Authenticate': `Bearer resource_metadata="${origin}/protected"`},
        });
      if (String(input) === origin + '/protected')
        return Response.json({resource: url, authorization_servers: [origin]});
      if (String(input) === origin + '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: origin,
          authorization_endpoint: origin + '/authorize',
          token_endpoint: origin + '/token',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(null, {status: 404});
    },
    {preconnect: () => {}},
  );
  const f = fixture(fetcher);
  const result = await f.manager.perform({type: 'add', name: 'manual', config: {transport: 'http', url}});
  expect(result.snapshot.servers[0]).toMatchObject({
    connection: 'needs-auth',
    auth: {state: 'needs-login', issue: 'client-registration-required'},
  });
  await expect(f.manager.perform({type: 'login', name: 'manual'})).rejects.toMatchObject({
    code: 'AUTH',
    message: expect.stringContaining('cosmew mcp credentials manual'),
  });
  await expect(
    f.manager.perform({
      type: 'credentials',
      name: 'manual',
      bearer: 'fixture-user-token',
      expectedEndpoint: origin + '/old',
    }),
  ).rejects.toMatchObject({code: 'POLICY'});
  expect(await f.manager.auth.bearer(url)).toBeUndefined();
});
