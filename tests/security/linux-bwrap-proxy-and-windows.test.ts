import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, request as httpRequest, type Server} from 'node:http';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  BWRAP_PROXY_PORT,
  BWRAP_PROXY_PORT_HEX,
  BWRAP_PROXY_SOCKET_GUEST,
  BubblewrapSandbox,
  NativeCommandRuntime,
  SandboxProxy,
  findExecutable,
  sandboxDependencies,
  shellArgvForPlatform,
  type ProxyEvent,
} from '@cosmew/tools';
import {BINARY_TARGETS, hostTargetKey, resolveTargets, sha256File} from '../../scripts/build-binary';

const cleanups: (() => void | Promise<void>)[] = [];

function makeTempDir(prefix = 'cosmew-d-'): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startOrigin(): Promise<{port: number; hits: string[]}> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
    res.end('UNIX_PROXY_ORIGIN_OK');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return {port: (server.address() as {port: number}).port, hits};
}

function httpViaUnix(socketPath: string, target: string): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({socketPath, method: 'GET', path: target, headers: {host: new URL(target).host}}, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({status: res.statusCode ?? 0, body}));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectViaUnix(socketPath: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = '';
    let opened = false;
    socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on('data', chunk => {
      data += chunk;
      if (!opened && data.includes('\r\n\r\n')) {
        opened = true;
        if (data.startsWith('HTTP/1.1 200'))
          socket.write('GET /tunneled HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n');
        else socket.end();
      }
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('D1 — Linux Bubblewrap Unix-socket SandboxProxy bridge', () => {
  test('SandboxProxy.startUnix enforces domain policy, DNS pinning, private-IP refusal, and cleans up socket on stop', async () => {
    const origin = await startOrigin();
    const events: ProxyEvent[] = [];
    const proxy = new SandboxProxy({
      decide: async target => target.host === 'allowed.test' || target.host === 'internal.test',
      onEvent: ev => events.push(ev),
      resolve: async host => (host === 'internal.test' ? ['10.0.0.5'] : ['203.0.113.10']),
      dial: () => ({address: '127.0.0.1', port: origin.port}),
    });
    cleanups.push(() => proxy.stop());

    const socketPath = await proxy.startUnix();
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(100);
    expect(existsSync(socketPath)).toBe(true);
    // Idempotent second call returns the same socket path
    expect(await proxy.startUnix()).toBe(socketPath);

    // Allowed HTTP + CONNECT tunnel work over Unix domain socket
    const plain = await httpViaUnix(socketPath, 'http://allowed.test/hello?a=1');
    expect(plain).toEqual({status: 200, body: 'UNIX_PROXY_ORIGIN_OK'});
    const tunneled = await connectViaUnix(socketPath, 'allowed.test:443');
    expect(tunneled).toContain('HTTP/1.1 200 Connection Established');
    expect(tunneled).toContain('UNIX_PROXY_ORIGIN_OK');

    // Denied domain is rejected with 403
    const denied = await httpViaUnix(socketPath, 'http://blocked.test/');
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('denied');

    // Allowed domain resolving to private IP is blocked by DNS pinning
    const privateRefused = await connectViaUnix(socketPath, 'internal.test:443');
    expect(privateRefused).toContain('403');
    expect(events.some(e => e.host === 'internal.test' && e.reason === 'private-address')).toBe(true);

    // Stop unlinks socket file and removes private directory
    await proxy.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test('BubblewrapSandbox bridges host proxy socket with positional socat trampoline and stays fail-closed without socat', () => {
    const workspace = makeTempDir('cosmew-bwrap-ws-');
    const scratch = makeTempDir('cosmew-bwrap-scratch-');
    const home = makeTempDir('cosmew-bwrap-home-');
    mkdirSync(join(scratch, 'home'), {recursive: true});
    mkdirSync(join(scratch, 'tmp'), {recursive: true});

    const hostSocket = '/tmp/cmw-px-test/p.sock';
    const withSocat = new BubblewrapSandbox({
      bwrap: '/usr/bin/bwrap',
      socat: '/usr/bin/socat',
      workspace,
      scratch,
      home,
      hideSecrets: true,
    });
    const dangerousArg = `$(touch /tmp/pwned); "quoted" 'single'`;
    const bridged = withSocat.wrap(
      ['/bin/bash', '--noprofile', '--norc', '-c', dangerousArg],
      {mode: 'workspace-write', network: false, proxyUrl: 'http://127.0.0.1:49999', proxySocketPath: hostSocket},
      workspace,
    );

    expect(bridged).toContain('--unshare-net');
    const bindIdx = bridged.indexOf(hostSocket);
    expect(bindIdx).toBeGreaterThan(0);
    expect(bridged[bindIdx - 1]).toBe('--bind');
    expect(bridged[bindIdx + 1]).toBe(BWRAP_PROXY_SOCKET_GUEST);
    // Socket bind must come AFTER scratch/tmp bind so tmp does not shadow it
    expect(bindIdx).toBeGreaterThan(bridged.indexOf(join(scratch, 'tmp')));

    const sepIdx = bridged.indexOf('--');
    const guestCmd = bridged.slice(sepIdx + 1);
    expect(guestCmd[0]).toBe('/bin/sh');
    expect(guestCmd[1]).toBe('-c');
    // Dynamic arguments are passed positionally, never interpolated into the shell script text
    expect(guestCmd[2]).not.toContain(hostSocket);
    expect(guestCmd[2]).not.toContain(dangerousArg);
    expect(guestCmd[3]).toBe('cosmew-bwrap-proxy');
    expect(guestCmd[4]).toBe('/usr/bin/socat');
    expect(guestCmd[5]).toBe(BWRAP_PROXY_SOCKET_GUEST);
    expect(guestCmd[6]).toBe(String(BWRAP_PROXY_PORT));
    expect(guestCmd[7]).toBe(BWRAP_PROXY_PORT_HEX);
    expect(guestCmd.slice(8)).toEqual(['/bin/bash', '--noprofile', '--norc', '-c', dangerousArg]);

    // Fail-closed: without socat, no socket is bound and --unshare-net keeps sandbox offline
    const withoutSocat = new BubblewrapSandbox({
      bwrap: '/usr/bin/bwrap',
      workspace,
      scratch,
      home,
      hideSecrets: true,
    });
    const offline = withoutSocat.wrap(
      ['/bin/bash', '-c', 'echo hi'],
      {mode: 'workspace-write', network: false, proxySocketPath: hostSocket},
      workspace,
    );
    expect(offline).toContain('--unshare-net');
    expect(offline).not.toContain(hostSocket);
    expect(offline).not.toContain('cosmew-bwrap-proxy');
  });
});

describe('D3 — Windows hardening & standalone packaging helpers', () => {
  test('Windows NativeCommandRuntime stays fail-closed for sandboxed mode while resolving Windows executables and shells', async () => {
    const workspace = makeTempDir('cosmew-win-ws-');
    const runtime = new NativeCommandRuntime({
      workspaceRoot: workspace,
      platform: 'win32',
      hostPath: 'C:\\Windows\\System32;C:\\Tools',
    });
    cleanups.push(() => runtime.shutdown());

    // Fail-closed: no fake Windows OS sandbox
    const avail = runtime.availability();
    expect(avail.ok).toBe(false);
    if (!avail.ok) expect(avail.reason).toContain('Windows');

    // Executable lookup uses `;` delimiter and Windows extensions
    const present = new Set([
      'C:\\Tools\\rg.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
    expect(findExecutable('rg', 'C:\\Windows\\System32;C:\\Tools', 'win32', p => present.has(p))).toBe(
      'C:\\Tools\\rg.exe',
    );
    expect(findExecutable('missing', 'C:\\Windows\\System32;C:\\Tools', 'win32', p => present.has(p))).toBeUndefined();

    // Unsandboxed shell selection on Windows (never runs through /bin/bash)
    const winPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Tools';
    expect(
      shellArgvForPlatform({command: 'Write-Output hi', shell: 'sh'}, 'win32', '', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      }),
    ).toEqual(['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', 'Write-Output hi']);

    // POSIX shell selection remains untouched
    expect(shellArgvForPlatform({command: 'echo hi', shell: 'bash'}, 'linux')).toEqual([
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      'echo hi',
    ]);
    expect(shellArgvForPlatform({command: 'echo hi', shell: 'sh', login: true}, 'darwin')).toEqual([
      '/bin/sh',
      '-l',
      '-c',
      'echo hi',
    ]);

    // sandboxDependencies on win32 probes ripgrep
    const deps = await sandboxDependencies({platform: 'win32', path: winPath, probe: name => name === 'ripgrep'});
    expect(deps).toEqual({platform: 'win32', items: [{name: 'ripgrep', ok: true}]});
  });

  test('build-binary target resolution and SHA-256 helper work cleanly across all platforms', () => {
    expect(hostTargetKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hostTargetKey('win32', 'x64')).toBe('windows-x64');
    expect(hostTargetKey('linux', 'arm64')).toBe('linux-arm64');
    expect(resolveTargets({all: true})).toHaveLength(Object.keys(BINARY_TARGETS).length);
    expect(resolveTargets({target: 'bun-windows-x64'})[0]?.filename).toBe('cosmew-windows-x64.exe');
    expect(() => resolveTargets({target: 'unknown-target'})).toThrow('Unknown binary target');

    const dir = makeTempDir('cosmew-sha-');
    const sample = join(dir, 'sample.bin');
    writeFileSync(sample, 'cosmew-release-check');
    expect(sha256File(sample)).toMatch(/^[0-9a-f]{64}$/);
  });
});
