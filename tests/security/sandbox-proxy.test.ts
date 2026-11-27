/**
 * ADR 0061: the sandbox network gate. A command inside the OS sandbox has no direct network; every
 * connection goes through the Futryn proxy, which allows configured domains, asks for new ones,
 * blocks denied ones and never reaches private addresses.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {createServer, request as httpRequest, type Server} from 'node:http';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCommandRuntime, SandboxProxy, isPrivateAddress, parseConnectTarget, type ProxyEvent} from '@cosmew/tools';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});

async function origin() {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
    res.end('ORIGIN_BODY');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  clean.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as {port: number}).port;
  return {hits, port};
}

/** DNS: `allowed.test` and `ask.test` are public, `internal.test` resolves into the LAN. */
const resolveHost = async (host: string) =>
  host === 'internal.test' ? ['10.0.0.5'] : host.endsWith('.test') ? ['203.0.113.7'] : [];

async function fixture(allowed: string[] = ['allowed.test']) {
  const site = await origin();
  const asked: string[] = [];
  const events: ProxyEvent[] = [];
  const proxy = new SandboxProxy({
    decide: async target => {
      asked.push(`${target.host}:${target.port}`);
      return allowed.includes(target.host);
    },
    onEvent: event => events.push(event),
    resolve: resolveHost,
    dial: () => ({address: '127.0.0.1', port: site.port}),
  });
  clean.push(() => proxy.stop());
  const url = await proxy.start();
  return {site, asked, events, proxy, url, port: Number(new URL(url).port)};
}

/** One plain-HTTP request through the proxy (absolute-URI form). */
function viaProxy(port: number, target: string): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {host: '127.0.0.1', port, method: 'GET', path: target, headers: {host: new URL(target).host}},
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({status: res.statusCode ?? 0, body}));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** CONNECT tunnel, then a plain HTTP request over it (the origin speaks HTTP). */
function tunnel(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    let opened = false;
    socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on('data', chunk => {
      data += chunk;
      if (!opened && data.includes('\r\n\r\n')) {
        opened = true;
        if (data.startsWith('HTTP/1.1 200'))
          socket.write('GET / HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n');
        else socket.end();
      }
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('proxy decisions', () => {
  test('an allowed domain passes through HTTP forwarding and CONNECT tunnels', async () => {
    const f = await fixture();
    const plain = await viaProxy(f.port, 'http://allowed.test/path?q=1');
    expect(plain).toEqual({status: 200, body: 'ORIGIN_BODY'});
    expect(f.site.hits[0]).toBe('GET /path?q=1 host=allowed.test');
    const tunnelled = await tunnel(f.port, 'allowed.test:443');
    expect(tunnelled).toContain('HTTP/1.1 200 Connection Established');
    expect(tunnelled).toContain('ORIGIN_BODY');
    expect(f.events.filter(event => event.allowed)).toHaveLength(2);
  });

  test('an unknown domain asks (the decision callback), and a refusal never reaches the origin', async () => {
    const f = await fixture(['allowed.test']);
    const denied = await viaProxy(f.port, 'http://ask.test/');
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('denied by the Cosmew sandbox');
    const refusedTunnel = await tunnel(f.port, 'ask.test:443');
    expect(refusedTunnel).toContain('403');
    expect(f.asked).toEqual(['ask.test:80', 'ask.test:443']);
    expect(f.site.hits).toEqual([]);
    expect(f.events.every(event => !event.allowed && event.reason === 'denied')).toBe(true);
  });

  test('a throwing or slow-to-fail decision denies', async () => {
    const site = await origin();
    const proxy = new SandboxProxy({
      decide: async () => {
        throw new Error('boom');
      },
      resolve: resolveHost,
      dial: () => ({address: '127.0.0.1', port: site.port}),
    });
    clean.push(() => proxy.stop());
    const port = Number(new URL(await proxy.start()).port);
    expect((await viaProxy(port, 'http://allowed.test/')).status).toBe(403);
    expect(site.hits).toEqual([]);
  });

  test('a hostname that resolves to a private address is refused even when the user allowed it', async () => {
    const f = await fixture(['internal.test']);
    const result = await viaProxy(f.port, 'http://internal.test/');
    expect(result.status).toBe(403);
    expect(result.body).toContain('private or local address');
    expect(f.site.hits).toEqual([]);
    expect(f.events.at(-1)).toMatchObject({allowed: false, reason: 'private-address'});
    // Literal private and metadata addresses never get that far.
    expect((await viaProxy(f.port, 'http://169.254.169.254/latest/meta-data')).status).toBe(403);
    expect((await viaProxy(f.port, 'http://127.0.0.1:8080/')).status).toBe(403);
  });

  test('malformed targets and non-proxy requests are rejected', async () => {
    const f = await fixture();
    expect(await tunnel(f.port, 'no-port')).toContain('400');
    expect(await tunnel(f.port, 'host:99999')).toContain('400');
    const direct = await new Promise<number>(resolve =>
      httpRequest({host: '127.0.0.1', port: f.port, path: '/not-absolute'}, res => resolve(res.statusCode ?? 0))
        .on('error', () => resolve(0))
        .end(),
    );
    expect(direct).toBe(400);
  });

  test('address and target parsing', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '192.0.0.1',
      '198.18.0.1',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      '0:0:0:0:0:ffff:169.254.169.254',
      '::127.0.0.1',
      '64:ff9b::10.0.0.1',
      '2002:7f00:0001::1',
      '2001:db8::1',
      '0.0.0.0',
    ])
      expect({address, private: isPrivateAddress(address)}).toEqual({address, private: true});
    for (const address of ['1.1.1.1', '203.0.113.7', '2606:4700:4700::1111'])
      expect({address, private: isPrivateAddress(address)}).toEqual({address, private: false});
    expect(parseConnectTarget('Example.COM:443')).toEqual({host: 'example.com', port: 443});
    expect(parseConnectTarget('[2001:db8::1]:8443')).toEqual({host: '2001:db8::1', port: 8443});
    expect(parseConnectTarget('a b:443')).toBeNull();
    expect(parseConnectTarget('host:0')).toBeNull();
  });
});

const nativeTest = test.skipIf(
  process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') || !Bun.which('curl'),
);

describe('real Seatbelt through the proxy', () => {
  nativeTest('curl reaches an allowed domain, is refused for others, and has no direct egress', async () => {
    const f = await fixture(['allowed.test']);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-proxy-ws-')));
    clean.push(() => rmSync(root, {recursive: true, force: true}));
    const runtime = new NativeCommandRuntime({workspaceRoot: root});
    clean.push(() => runtime.shutdown());
    const run = (command: string, proxyUrl?: string) =>
      runtime.run({
        command,
        cwd: root,
        timeoutMs: 20_000,
        maxOutputBytes: 20_000,
        sandbox: {mode: 'workspace-write', network: false, ...(proxyUrl ? {proxyUrl} : {})},
      });
    const allowed = await run('curl -sS -m 8 http://allowed.test/hello; echo " rc=$?"', f.url);
    expect(allowed.output).toContain('ORIGIN_BODY');
    expect(allowed.output).toContain('rc=0');
    // Proxy variables are set for the command, with loopback excluded.
    const env = await run('echo "$HTTP_PROXY $HTTPS_PROXY $ALL_PROXY $NO_PROXY"', f.url);
    expect(env.output).toContain(`${f.url} ${f.url} ${f.url} localhost`);
    // A domain the user has not allowed is blocked by the proxy.
    const blocked = await run('curl -sS -m 8 -o /dev/null -w "%{http_code}" http://ask.test/x; echo', f.url);
    expect(blocked.output).toMatch(/403|CONNECT|denied/);
    expect(f.asked).toContain('ask.test:80');
    // Without the proxy URL no variable exists and no external address is reachable.
    const none = await run(
      'echo "[${HTTP_PROXY}]"; curl -sS -m 5 --noproxy "*" http://203.0.113.7/ 2>&1; echo " rc=$?"',
    );
    expect(none.output).toContain('[]');
    expect(none.output).not.toContain('ORIGIN_BODY');
    // Even with the variables, a command that ignores them cannot connect directly.
    const direct = await run('curl -sS -m 5 --noproxy "*" http://203.0.113.7/ 2>&1; echo " rc=$?"', f.url);
    expect(direct.output).not.toContain('ORIGIN_BODY');
    expect(direct.output).not.toContain('rc=0');
  });
});
