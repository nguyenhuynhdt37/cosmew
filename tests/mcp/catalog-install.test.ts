import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpCatalog, publicMcpMetadataUrl, recommendedMcpRecipes} from '@cosmew/mcp';
import {FileMcpInstallStore} from '@cosmew/persistence';
import {createManagedMcpInstaller, type ManagedMcpInstallRunner} from '../../apps/cli/src/bootstrap/mcp-install';
const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'cosmew-install-'));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, {recursive: true, force: true});
});
const sri = `sha512-${Buffer.alloc(64).toString('base64')}`;
const metadata = {
  name: '@fixture/server',
  version: '1.2.3',
  dist: {integrity: sri, tarball: 'https://registry.npmjs.org/@fixture/server/-/server-1.2.3.tgz'},
};
const input = {id: 'io.fixture/server', packageName: '@fixture/server', version: '1.2.3'};
const fixtureFetch = (async () => Response.json(metadata)) as unknown as unknown as typeof fetch;
const populate: ManagedMcpInstallRunner = async request => {
  expect(request.args).toContain('--ignore-scripts');
  expect(request.args).toContain('--bin-links=false');
  expect(request.env.HOME).toBe(request.cwd);
  expect(request.env).not.toHaveProperty('NODE_OPTIONS');
  const path = join(request.cwd, 'node_modules/@fixture/server');
  mkdirSync(path, {recursive: true});
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify({
      name: input.packageName,
      version: input.version,
      bin: './server.js',
      scripts: {postinstall: 'never execute'},
    }),
  );
  writeFileSync(join(path, 'server.js'), 'process.stdout.write("fixture");');
};

describe('registry metadata boundary', () => {
  test('official schema, escaped identity, bounded search, no publisher commands', async () => {
    const requests: string[] = [];
    const entry = {
      server: {
        name: 'io.fixture/server',
        title: 'Fixture\u001b[31m',
        description: 'data',
        version: '1.2.3',
        packages: [
          {
            registryType: 'npm',
            identifier: '@fixture/server',
            version: '1.2.3',
            transport: {type: 'stdio'},
            runtimeHint: 'malicious command',
          },
        ],
        remotes: [
          {type: 'streamable-http', url: 'https://127.0.0.1/mcp'},
          {type: 'streamable-http', url: 'https://public.example/mcp'},
        ],
      },
    };
    const catalog = new McpCatalog((async (url: RequestInfo | URL, options?: RequestInit) => {
      requests.push(String(url));
      expect(options?.redirect).toBe('error');
      return Response.json(
        String(url).includes('/versions/') ? entry : {servers: [entry], metadata: {nextCursor: 'next&cursor'}},
      );
    }) as unknown as typeof fetch);
    const page = await catalog.search('fixture&search');
    expect(page.entries[0]?.recipes).toEqual([
      {kind: 'remote', url: 'https://public.example/mcp'},
      {kind: 'npm', packageName: '@fixture/server', version: '1.2.3'},
    ]);
    expect(page.entries[0]?.tested).toBe(false);
    expect(page.nextCursor).toBe('next&cursor');
    await catalog.get('io.fixture/server');
    expect(requests[0]).toContain('search=fixture%26search');
    expect(requests[1]).toContain('io.fixture%2Fserver/versions/latest');
    expect(recommendedMcpRecipes().every(entry => entry.tested === false && !entry.registryListed)).toBe(true);
  });
  test('refuses unsafe metadata URL, oversize response and cancellation', async () => {
    for (const value of [
      'https://localhost/a',
      'https://2130706433/a',
      'https://[::1]/a',
      'https://private.local/a',
      'https://user:secret@example.com/a',
      'https://public.example/a?token=secret',
    ])
      expect(publicMcpMetadataUrl(value)).toBeUndefined();
    const catalog = new McpCatalog((async () => new Response('x'.repeat(524289))) as unknown as typeof fetch);
    await expect(catalog.search('')).rejects.toThrow('registry request failed');
    const controller = new AbortController();
    controller.abort();
    await expect(catalog.search('', {signal: controller.signal})).rejects.toThrow();
  });
});

describe('managed npm installation (injected runner, no service compatibility claim)', () => {
  test('persists only verified-ready paths and launches pinned bin through node', async () => {
    const directory = root();
    const installer = createManagedMcpInstaller({stateDirectory: directory, runner: populate, fetcher: fixtureFetch});
    const result = await installer.install(input);
    expect(result.spec.command).toBe('node');
    expect(result.spec.args[0]).toEndWith('/node_modules/@fixture/server/server.js');
    expect(installer.list()[0]?.state).toBe('ready');
    const proc = Bun.spawn([result.spec.command, ...result.spec.args], {stdout: 'pipe', stderr: 'pipe'});
    expect(await new Response(proc.stdout).text()).toBe('fixture');
    expect(await proc.exited).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(directory, 'mcp-packages', result.installationId, 'installation.json'), 'utf8'),
    );
    expect(manifest.integrity).toBe(sri);
    installer.remove(result.installationId);
    expect(installer.list()).toEqual([]);
  });
  test('failure and cancellation never leave a ready installation', async () => {
    const directory = root();
    const controller = new AbortController();
    const installer = createManagedMcpInstaller({
      stateDirectory: directory,
      fetcher: fixtureFetch,
      runner: async request => {
        await populate(request);
        controller.abort();
      },
    });
    await expect(installer.install(input, controller.signal)).rejects.toThrow();
    expect(installer.list()).toEqual([]);
    const failed = createManagedMcpInstaller({
      stateDirectory: directory,
      fetcher: fixtureFetch,
      runner: async () => {
        throw new Error('failed');
      },
    });
    await expect(failed.install(input)).rejects.toThrow('failed');
    expect(failed.list()).toEqual([]);
  });
  test('rejects dependency resolution, non-pinned versions and integrity mismatch before runner', async () => {
    let calls = 0;
    const installer = createManagedMcpInstaller({
      stateDirectory: root(),
      runner: async () => {
        calls++;
      },
      fetcher: (async () =>
        Response.json({...metadata, dependencies: {bad: 'git+https://example.com/repo'}})) as unknown as typeof fetch,
    });
    await expect(installer.install(input)).rejects.toThrow('dependency-free');
    await expect(installer.install({...input, version: 'latest'})).rejects.toThrow('Invalid pinned');
    const plain = createManagedMcpInstaller({
      stateDirectory: root(),
      runner: async () => {
        calls++;
      },
      fetcher: fixtureFetch,
    });
    await expect(
      plain.install({...input, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`}),
    ).rejects.toThrow('integrity mismatch');
    expect(calls).toBe(0);
  });
  test('complete lock path validates every dependency before invoking npm', async () => {
    const lock = {
      name: 'cosmew-managed-mcp',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {dependencies: {[input.packageName]: input.version}},
        'node_modules/@fixture/server': {
          version: input.version,
          resolved: metadata.dist.tarball,
          integrity: sri,
          dependencies: {dependency: '^1.0.0'},
        },
        'node_modules/dependency': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/dependency/-/dependency-1.0.0.tgz',
          integrity: sri,
        },
      },
    };
    let calls = 0;
    const installer = createManagedMcpInstaller({
      stateDirectory: root(),
      fetcher: (async () => {
        throw new Error('No metadata fetch with lock');
      }) as unknown as typeof fetch,
      runner: async request => {
        calls++;
        await populate(request);
      },
    });
    const result = await installer.install({...input, lockfile: JSON.stringify(lock)});
    expect(calls).toBe(1);
    installer.remove(result.installationId);
    lock.packages['node_modules/dependency'].resolved = 'https://127.0.0.1/steal.tgz';
    await expect(installer.install({...input, lockfile: JSON.stringify(lock)})).rejects.toThrow('integrity-pinned');
    expect(calls).toBe(1);
    lock.packages['node_modules/dependency'].resolved = 'https://registry.npmjs.org/dependency/-/dependency-1.0.0.tgz';
    lock.packages['node_modules/dependency'].integrity = 'sha1-untrusted';
    await expect(installer.install({...input, lockfile: JSON.stringify(lock)})).rejects.toThrow('integrity-pinned');
    expect(calls).toBe(1);
  });
  test('rejects symlink executable and package bin traversal without touching outside files', async () => {
    const outside = root();
    const marker = join(outside, 'outside.js');
    writeFileSync(marker, 'safe');
    const installer = createManagedMcpInstaller({
      stateDirectory: root(),
      fetcher: fixtureFetch,
      runner: async request => {
        await populate(request);
        const path = join(request.cwd, 'node_modules/@fixture/server/server.js');
        rmSync(path);
        symlinkSync(marker, path);
      },
    });
    await expect(installer.install(input)).rejects.toThrow('Unsafe installed');
    expect(readFileSync(marker, 'utf8')).toBe('safe');
    expect(installer.list()).toEqual([]);
  });
  test('uninstall refuses unowned/symlink directories and traversal IDs', () => {
    const directory = root();
    const outside = root();
    const store = new FileMcpInstallStore(directory);
    const record = store.begin({packageName: input.packageName, version: input.version, integrity: sri});
    rmSync(store.path(record.installationId), {recursive: true});
    symlinkSync(outside, store.path(record.installationId));
    expect(() => store.remove(record.installationId)).toThrow('Unowned');
    expect(() => store.remove('../../escape')).toThrow('Invalid');
    const linkedState = join(root(), 'state');
    symlinkSync(outside, linkedState);
    expect(() =>
      new FileMcpInstallStore(linkedState).begin({
        packageName: input.packageName,
        version: input.version,
        integrity: sri,
      }),
    ).toThrow('Unsafe');
  });
});
