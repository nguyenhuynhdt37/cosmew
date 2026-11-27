import {afterEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CredentialVault} from '@cosmew/contracts';
import {McpManager} from '../../apps/cli/src/bootstrap/mcp-manager';
import type {ManagedMcpInstallRunner} from '../../apps/cli/src/bootstrap/mcp-install';
import {parseMcpCli} from '../../apps/cli/src/mcp-cli';

const roots: string[] = [];
const managers: McpManager[] = [];

const makeRoot = () => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'cosmew-mcp-upd-'));
  roots.push(path);
  return path;
};

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.hub.close();
  for (const path of roots.splice(0)) rmSync(path, {recursive: true, force: true});
});

const memoryVault = (): CredentialVault => {
  const store = new Map<string, string>();
  const keyOf = (ref: Parameters<CredentialVault['get']>[0]) =>
    ref.kind === 'keyring' ? ref.key : ref.kind === 'env' ? ref.name : '';
  return {
    get: async ref => store.get(keyOf(ref)),
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async ref => {
      store.delete(keyOf(ref));
    },
  };
};

const sri1 = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const sri2 = `sha512-${Buffer.alloc(64, 2).toString('base64')}`;
const sri3 = `sha512-${Buffer.alloc(64, 3).toString('base64')}`;

const metadataByVersion: Record<string, {name: string; version: string; dist: {integrity: string; tarball: string}}> = {
  '1.0.0': {
    name: '@fixture/managed',
    version: '1.0.0',
    dist: {integrity: sri1, tarball: 'https://registry.npmjs.org/@fixture/managed/-/managed-1.0.0.tgz'},
  },
  '2.0.0': {
    name: '@fixture/managed',
    version: '2.0.0',
    dist: {integrity: sri2, tarball: 'https://registry.npmjs.org/@fixture/managed/-/managed-2.0.0.tgz'},
  },
  '3.0.0': {
    name: '@fixture/managed',
    version: '3.0.0',
    dist: {integrity: sri3, tarball: 'https://registry.npmjs.org/@fixture/managed/-/managed-3.0.0.tgz'},
  },
};

function makeServerScript(version: string): string {
  return `const readline = require('node:readline');
const version = ${JSON.stringify(version)};
const rl = readline.createInterface({input: process.stdin});
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version}},
    }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {tools: [{name: 'version', description: 'Running ' + version, inputSchema: {type: 'object', properties: {}}}]},
    }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: {code: -32601, message: 'Method not found'},
    }) + '\\n');
  }
});
`;
}

const registryFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const version = url.slice(url.lastIndexOf('/') + 1);
  const meta = metadataByVersion[version];
  if (!meta) return new Response('not found', {status: 404});
  return Response.json(meta);
}) as unknown as typeof fetch;

function createRunner(options?: {failVersion?: string}): ManagedMcpInstallRunner {
  return async request => {
    const pkg = JSON.parse(readFileSync(join(request.cwd, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const version = pkg.dependencies['@fixture/managed']!;
    if (options?.failVersion === version) throw new Error(`simulated install failure for ${version}`);
    const pkgDir = join(request.cwd, 'node_modules/@fixture/managed');
    mkdirSync(pkgDir, {recursive: true});
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({name: '@fixture/managed', version, bin: './server.js'}),
    );
    writeFileSync(join(pkgDir, 'server.js'), makeServerScript(version));
  };
}

function createManager(directory: string, runner: ManagedMcpInstallRunner): McpManager {
  const manager = new McpManager({
    directory,
    vault: memoryVault(),
    redact: text => text,
    registerSecret: () => {},
    openURL: async () => {},
    fetch: registryFetch,
    installRunner: runner,
  });
  managers.push(manager);
  return manager;
}

describe('managed MCP update & rollback with provenance', () => {
  test('installs v1, updates to v2 preserving rollback history, rejects failed updates, and rolls back to v1', async () => {
    const dir = makeRoot();
    const manager = createManager(dir, createRunner({failVersion: '3.0.0'}));

    const installed = await manager.perform({
      type: 'install',
      name: 'srv',
      packageName: '@fixture/managed',
      version: '1.0.0',
      integrity: sri1,
    });
    const srvV1 = installed.snapshot.servers.find(s => s.name === 'srv');
    expect(srvV1?.connection).toBe('connected');
    expect(srvV1?.installation).toMatchObject({
      state: 'ready',
      packageName: '@fixture/managed',
      version: '1.0.0',
      integrity: sri1,
    });
    expect(srvV1?.installation.previousVersion).toBeUndefined();
    expect(srvV1?.tools[0]?.description).toBe('Running 1.0.0');
    const v1Id = srvV1!.installation.id!;

    // Update to v2.0.0
    const updated = await manager.perform({
      type: 'update',
      name: 'srv',
      version: '2.0.0',
      integrity: sri2,
    });
    const srvV2 = updated.snapshot.servers.find(s => s.name === 'srv');
    expect(srvV2?.connection).toBe('connected');
    expect(srvV2?.installation).toMatchObject({
      state: 'ready',
      packageName: '@fixture/managed',
      version: '2.0.0',
      integrity: sri2,
      previousVersion: '1.0.0',
      rollbackCount: 1,
    });
    expect(srvV2?.tools[0]?.description).toBe('Running 2.0.0');
    const v2Id = srvV2!.installation.id!;
    expect(v2Id).not.toBe(v1Id);

    const packagesDir = join(dir, 'mcp-packages');
    expect(existsSync(join(packagesDir, v1Id))).toBe(true);
    expect(existsSync(join(packagesDir, v2Id))).toBe(true);

    // Failed update (integrity mismatch) leaves v2 intact and creates no leftover dir
    await expect(
      manager.perform({
        type: 'update',
        name: 'srv',
        version: '3.0.0',
        integrity: sri1,
      }),
    ).rejects.toThrow(/integrity/i);

    // Failed update (runner error) leaves v2 intact and cleans up failed staging dir
    await expect(
      manager.perform({
        type: 'update',
        name: 'srv',
        version: '3.0.0',
        integrity: sri3,
      }),
    ).rejects.toThrow(/simulated install failure/);

    expect(readdirSync(packagesDir).sort()).toEqual([v1Id, v2Id].sort());
    const afterFailed = (await manager.snapshot()).servers.find(s => s.name === 'srv');
    expect(afterFailed?.installation.version).toBe('2.0.0');
    expect(afterFailed?.installation.rollbackCount).toBe(1);

    // Rollback restores v1.0.0 and removes v2.0.0 directory
    const rolled = await manager.perform({type: 'rollback', name: 'srv'});
    const srvRestored = rolled.snapshot.servers.find(s => s.name === 'srv');
    expect(srvRestored?.connection).toBe('connected');
    expect(srvRestored?.installation).toMatchObject({
      state: 'ready',
      id: v1Id,
      packageName: '@fixture/managed',
      version: '1.0.0',
      integrity: sri1,
    });
    expect(srvRestored?.installation.previousVersion).toBeUndefined();
    expect(srvRestored?.installation.rollbackCount).toBeUndefined();
    expect(srvRestored?.tools[0]?.description).toBe('Running 1.0.0');
    expect(existsSync(join(packagesDir, v1Id))).toBe(true);
    expect(existsSync(join(packagesDir, v2Id))).toBe(false);

    // Second rollback with no history left returns NOT_FOUND
    await expect(manager.perform({type: 'rollback', name: 'srv'})).rejects.toMatchObject({code: 'NOT_FOUND'});
  });

  test('rollback refuses tampered provenance (symlink executable or mismatched manifest integrity)', async () => {
    const dir = makeRoot();
    const outside = makeRoot();
    const manager = createManager(dir, createRunner());

    const v1 = await manager.perform({
      type: 'install',
      name: 'srv',
      packageName: '@fixture/managed',
      version: '1.0.0',
    });
    const v1Id = v1.snapshot.servers.find(s => s.name === 'srv')!.installation.id!;

    await manager.perform({type: 'update', name: 'srv', version: '2.0.0'});

    // Replace previous installation's binary with a symlink pointing outside
    const outsideScript = join(outside, 'evil.js');
    writeFileSync(outsideScript, 'process.exit(1);');
    const v1Bin = join(dir, 'mcp-packages', v1Id, 'node_modules/@fixture/managed/server.js');
    rmSync(v1Bin);
    symlinkSync(outsideScript, v1Bin);

    await expect(manager.perform({type: 'rollback', name: 'srv'})).rejects.toThrow(/missing or unsafe/i);

    // Restore regular file, then tamper with stored manifest integrity provenance
    rmSync(v1Bin);
    writeFileSync(v1Bin, makeServerScript('1.0.0'));
    const manifestPath = join(dir, 'mcp-packages', v1Id, 'installation.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.integrity = sri3;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(manager.perform({type: 'rollback', name: 'srv'})).rejects.toThrow(/provenance mismatch/i);

    // Current server remains cleanly at v2.0.0
    const current = (await manager.snapshot()).servers.find(s => s.name === 'srv');
    expect(current?.installation.version).toBe('2.0.0');
    expect(current?.installation.state).toBe('ready');
  });

  test('remove cleans up both current installation and all retained previous installations', async () => {
    const dir = makeRoot();
    const manager = createManager(dir, createRunner());

    const v1 = await manager.perform({type: 'install', name: 'srv', packageName: '@fixture/managed', version: '1.0.0'});
    const v1Id = v1.snapshot.servers[0]!.installation.id!;
    const v2 = await manager.perform({type: 'update', name: 'srv', version: '2.0.0'});
    const v2Id = v2.snapshot.servers[0]!.installation.id!;

    const packagesDir = join(dir, 'mcp-packages');
    expect(readdirSync(packagesDir).sort()).toEqual([v1Id, v2Id].sort());

    await manager.perform({type: 'remove', name: 'srv'});
    expect(readdirSync(packagesDir)).toEqual([]);
  });

  test('rejects update and rollback on unmanaged or remote servers', async () => {
    const dir = makeRoot();
    const manager = createManager(dir, createRunner());

    await manager.perform({
      type: 'add',
      name: 'remote',
      config: {transport: 'http', url: 'https://mcp.example.com/v1'},
    });

    await expect(manager.perform({type: 'update', name: 'remote', version: '2.0.0'})).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(manager.perform({type: 'rollback', name: 'remote'})).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});

describe('MCP CLI parsing for update and rollback', () => {
  test('parses valid update and rollback flags and rejects invalid combinations', () => {
    const upd = parseMcpCli(['update', 'my-srv', '--version', '2.0.0', '--integrity', sri2, '--bin', 'cli']);
    expect(upd.action).toEqual({
      type: 'update',
      name: 'my-srv',
      version: '2.0.0',
      integrity: sri2,
      bin: 'cli',
    });

    const rb = parseMcpCli(['rollback', 'my-srv', '--json']);
    expect(rb.action).toEqual({type: 'rollback', name: 'my-srv'});
    expect(rb.values.json).toBe(true);

    // Missing required --version on update
    expect(() => parseMcpCli(['update', 'my-srv'])).toThrow();
    // Disallowed --package on update
    expect(() => parseMcpCli(['update', 'my-srv', '--package', '@a/b', '--version', '2.0.0'])).toThrow();
    // Extra positional on rollback
    expect(() => parseMcpCli(['rollback', 'my-srv', 'extra'])).toThrow();
    // Duplicate flag
    expect(() => parseMcpCli(['update', 'my-srv', '--version', '1.0.0', '--version', '2.0.0'])).toThrow();
  });
});
