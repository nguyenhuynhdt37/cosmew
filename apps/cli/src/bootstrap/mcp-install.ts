import {spawn} from 'node:child_process';
import {lstatSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {FileMcpInstallStore} from '@cosmew/persistence';
import {MCP_EXACT_VERSION, MCP_NPM_NAME, readBoundedMcpJson} from '@cosmew/mcp';

export interface ManagedMcpInstallInput {
  id: string;
  packageName: string;
  version: string;
  integrity?: string;
  /** Complete lock v3, including integrity for every transitive artifact. No lock generation executes. */
  lockfile?: string;
  bin?: string;
}
export interface ManagedMcpInstallation {
  installationId: string;
  packageName: string;
  version: string;
  spec: {transport: 'stdio'; command: string; args: string[]; env: Record<string, string>};
}
export type ManagedMcpInstallRunner = (request: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}) => Promise<void>;
export interface ManagedMcpInstallerOptions {
  stateDirectory: string;
  runner?: ManagedMcpInstallRunner;
  fetcher?: typeof fetch;
  nodeCommand?: string;
  npmCommand?: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const PACKAGE_PATH =
  /^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/;
function integrity(value: unknown): value is string {
  return typeof value === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value);
}
function validateLock(input: ManagedMcpInstallInput, raw: unknown): Record<string, unknown> {
  const lock = object(raw);
  const packages = object(lock.packages);
  const entries = Object.entries(packages);
  const root = object(packages['']);
  const deps = object(root.dependencies);
  if (
    lock.lockfileVersion !== 3 ||
    entries.length > 4096 ||
    entries.length < 2 ||
    Object.keys(deps).length !== 1 ||
    deps[input.packageName] !== input.version ||
    root.devDependencies ||
    root.optionalDependencies ||
    root.workspaces ||
    lock.dependencies
  )
    throw new Error('A complete pinned npm lock v3 is required.');
  for (const [path, value] of entries) {
    if (path === '') continue;
    const pkg = object(value);
    let url: URL;
    try {
      url = new URL(String(pkg.resolved));
    } catch {
      throw new Error('Invalid locked artifact.');
    }
    if (
      !PACKAGE_PATH.test(path) ||
      path.split('/').some(part => part === '.' || part === '..') ||
      pkg.link ||
      pkg.inBundle ||
      !MCP_EXACT_VERSION.test(String(pkg.version)) ||
      !integrity(pkg.integrity) ||
      url.origin !== 'https://registry.npmjs.org' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('.tgz')
    )
      throw new Error('Only integrity-pinned npm registry artifacts are supported.');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(object(pkg[field]))) {
        if (
          !MCP_NPM_NAME.test(name) ||
          typeof range !== 'string' ||
          !/^[~^<>=*\s0-9][~^<>=|*\s0-9A-Za-z.+-]*$/.test(range)
        )
          throw new Error('Non-registry dependencies are unsupported.');
      }
    }
  }
  const target = object(packages[`node_modules/${input.packageName}`]);
  if (target.version !== input.version || (input.integrity && target.integrity !== input.integrity))
    throw new Error('Pinned package identity or integrity mismatch.');
  return lock;
}

const defaultRunner: ManagedMcpInstallRunner = async request => {
  request.signal.throwIfAborted();
  await new Promise<void>((done, fail) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      signal: request.signal,
      stdio: 'ignore',
      shell: false,
    });
    let spawnFailed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      // Wait for close before deleting the owned directory: an abort error alone
      // does not prove the package manager has stopped writing to it.
      escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
      escalation.unref();
    };
    request.signal.addEventListener('abort', abort, {once: true});
    if (request.signal.aborted) abort();
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', code => {
      request.signal.removeEventListener('abort', abort);
      if (escalation) clearTimeout(escalation);
      if (code === 0 && !spawnFailed && !request.signal.aborted) done();
      else fail(new Error('Managed npm installation failed or was cancelled.'));
    });
  });
};

/** Human manager composition only. Never registered as a model tool or called during discovery. */
export function createManagedMcpInstaller(options: ManagedMcpInstallerOptions) {
  const store = new FileMcpInstallStore(options.stateDirectory);
  const fetcher = options.fetcher ?? fetch;
  return {
    async install(input: ManagedMcpInstallInput, signal?: AbortSignal): Promise<ManagedMcpInstallation> {
      if (
        !input.id ||
        input.id.length > 256 ||
        !MCP_NPM_NAME.test(input.packageName) ||
        input.packageName.length > 214 ||
        !MCP_EXACT_VERSION.test(input.version) ||
        (input.integrity !== undefined && !integrity(input.integrity))
      )
        throw new Error('Invalid pinned npm package.');
      const bounded = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
      bounded.throwIfAborted();
      let lock: Record<string, unknown>;
      if (input.lockfile !== undefined) {
        if (input.lockfile.length > 512 * 1024) throw new Error('Lock exceeds size limit.');
        lock = validateLock(input, JSON.parse(input.lockfile));
      } else {
        // Fetch exact-version data only; never invoke npm dependency resolution (which can spawn git).
        const endpoint = new URL(
          `/${encodeURIComponent(input.packageName)}/${encodeURIComponent(input.version)}`,
          'https://registry.npmjs.org',
        );
        const metadata = object(
          await readBoundedMcpJson(
            await fetcher(endpoint, {
              redirect: 'error',
              signal: bounded,
              headers: {Accept: 'application/json'},
            }),
            bounded,
          ),
        );
        if (metadata.name !== input.packageName || metadata.version !== input.version)
          throw new Error('Package identity mismatch.');
        if (
          ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
            key => Object.keys(object(metadata[key])).length,
          ) ||
          metadata.bundleDependencies ||
          metadata.bundledDependencies
        )
          throw new Error(
            'Automatic install supports dependency-free packages only; supply a complete integrity-pinned npm lock for dependencies.',
          );
        const dist = object(metadata.dist);
        if (!integrity(dist.integrity)) throw new Error('Package has no supported SHA-512 integrity.');
        lock = validateLock(input, {
          name: 'cosmew-managed-mcp',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': {name: 'cosmew-managed-mcp', version: '1.0.0', dependencies: {[input.packageName]: input.version}},
            [`node_modules/${input.packageName}`]: {
              version: input.version,
              resolved: dist.tarball,
              integrity: dist.integrity,
            },
          },
        });
      }
      bounded.throwIfAborted();
      const target = object(object(lock.packages)[`node_modules/${input.packageName}`]);
      const record = store.begin({
        packageName: input.packageName,
        version: input.version,
        integrity: String(target.integrity),
      });
      const directory = store.path(record.installationId);
      try {
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({
            name: 'cosmew-managed-mcp',
            version: '1.0.0',
            private: true,
            dependencies: {[input.packageName]: input.version},
          }),
          {mode: 0o600, flag: 'wx'},
        );
        writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock), {mode: 0o600, flag: 'wx'});
        await (options.runner ?? defaultRunner)({
          command: options.npmCommand ?? 'npm',
          args: [
            'ci',
            '--ignore-scripts',
            '--bin-links=false',
            '--no-audit',
            '--no-fund',
            '--registry=https://registry.npmjs.org',
            '--userconfig=/dev/null',
            '--globalconfig=/dev/null',
          ],
          cwd: directory,
          signal: bounded,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: directory,
            npm_config_cache: join(directory, '.npm-cache'),
            npm_config_ignore_scripts: 'true',
            npm_config_bin_links: 'false',
          },
        });
        bounded.throwIfAborted();
        // npm's archive handling is followed by independent filesystem and executable validation.
        let remaining = 100_000;
        const inspect = (path: string): void => {
          if (--remaining < 0) throw new Error('Installed package exceeds file limit.');
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
            throw new Error('Unsafe installed package path.');
          if (stat.isDirectory()) for (const entry of readdirSync(path)) inspect(join(path, entry));
        };
        inspect(join(directory, 'node_modules'));
        const packageDirectory = join(directory, 'node_modules', input.packageName);
        const metadataPath = join(packageDirectory, 'package.json');
        if (lstatSync(metadataPath).size > 512 * 1024) throw new Error('Package manifest exceeds size limit.');
        const metadata = object(JSON.parse(readFileSync(metadataPath, 'utf8')));
        if (metadata.name !== input.packageName || metadata.version !== input.version)
          throw new Error('Installed package identity mismatch.');
        const bins =
          typeof metadata.bin === 'string'
            ? {[input.packageName.split('/').at(-1)!]: metadata.bin}
            : object(metadata.bin);
        const bin = input.bin ? bins[input.bin] : Object.values(bins).length === 1 ? Object.values(bins)[0] : undefined;
        if (
          typeof bin !== 'string' ||
          bin.length > 1024 ||
          isAbsolute(bin) ||
          bin.includes('\\') ||
          /[\r\n\0]/.test(bin)
        )
          throw new Error('Package needs one explicit JavaScript bin.');
        const executable = resolve(packageDirectory, bin);
        const rel = relative(packageDirectory, executable);
        if (
          !rel ||
          rel.startsWith(`..${sep}`) ||
          rel === '..' ||
          !/\.(?:js|mjs|cjs)$/.test(executable) ||
          !lstatSync(executable).isFile()
        )
          throw new Error('Unsafe or unsupported server executable.');
        bounded.throwIfAborted();
        store.ready(record.installationId, rel);
        return {
          installationId: record.installationId,
          packageName: input.packageName,
          version: input.version,
          spec: {transport: 'stdio', command: options.nodeCommand ?? 'node', args: [executable], env: {}},
        };
      } catch (error) {
        store.remove(record.installationId);
        signal?.throwIfAborted();
        throw error;
      }
    },
    remove(installationId: string): void {
      store.remove(installationId);
    },
    list() {
      return store.list();
    },
  };
}
