import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';

export type BinaryTargetKey = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'windows-x64';

export type BunCompileTarget =
  'bun-darwin-arm64' | 'bun-darwin-x64' | 'bun-linux-x64' | 'bun-linux-arm64' | 'bun-windows-x64';

export interface BinaryTargetSpec {
  key: BinaryTargetKey;
  bunTarget: BunCompileTarget;
  filename: string;
  platform: NodeJS.Platform;
  arch: string;
}

export const BINARY_TARGETS: Record<BinaryTargetKey, BinaryTargetSpec> = {
  'darwin-arm64': {
    key: 'darwin-arm64',
    bunTarget: 'bun-darwin-arm64',
    filename: 'cosmew-darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
  },
  'darwin-x64': {
    key: 'darwin-x64',
    bunTarget: 'bun-darwin-x64',
    filename: 'cosmew-darwin-x64',
    platform: 'darwin',
    arch: 'x64',
  },
  'linux-x64': {
    key: 'linux-x64',
    bunTarget: 'bun-linux-x64',
    filename: 'cosmew-linux-x64',
    platform: 'linux',
    arch: 'x64',
  },
  'linux-arm64': {
    key: 'linux-arm64',
    bunTarget: 'bun-linux-arm64',
    filename: 'cosmew-linux-arm64',
    platform: 'linux',
    arch: 'arm64',
  },
  'windows-x64': {
    key: 'windows-x64',
    bunTarget: 'bun-windows-x64',
    filename: 'cosmew-windows-x64.exe',
    platform: 'win32',
    arch: 'x64',
  },
};

export function hostTargetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BinaryTargetKey | undefined {
  const os = platform === 'win32' ? 'windows' : platform;
  const candidate = `${os}-${arch}` as BinaryTargetKey;
  return candidate in BINARY_TARGETS ? candidate : undefined;
}

export function resolveTargets(options: {
  target?: string;
  all?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}): BinaryTargetSpec[] {
  if (options.all) return Object.values(BINARY_TARGETS);
  const requested = options.target ?? 'host';
  if (requested === 'host') {
    const key = hostTargetKey(options.platform, options.arch);
    if (!key)
      throw new Error(
        `Unsupported host target: ${options.platform ?? process.platform}-${options.arch ?? process.arch}`,
      );
    return [BINARY_TARGETS[key]];
  }
  const normalized = requested.replace(/^bun-/, '') as BinaryTargetKey;
  const spec = BINARY_TARGETS[normalized];
  if (!spec) {
    throw new Error(
      `Unknown binary target "${requested}". Valid targets: host, ${Object.keys(BINARY_TARGETS).join(', ')}`,
    );
  }
  return [spec];
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface BuildBinaryResult {
  target: BinaryTargetSpec;
  outfile: string;
  bytes: number;
  sha256: string;
  crossCompiled: boolean;
  smokePassed?: boolean;
}

const REPO_ROOT = resolve(dirname(import.meta.path), '..');
const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'src', 'index.ts');

/**
 * Compile one standalone Cosmew CLI binary using `Bun.build(..., {compile})`.
 * Optional dev-only `react-devtools-core` imports from Ink are stubbed safely at bundle time.
 */
export async function buildBinary(options: {
  target: BinaryTargetSpec;
  outDir: string;
  smoke?: boolean;
  minify?: boolean;
}): Promise<BuildBinaryResult> {
  mkdirSync(options.outDir, {recursive: true});
  const outfile = resolve(options.outDir, options.target.filename);
  const host = hostTargetKey();
  const crossCompiled = host !== options.target.key;

  const built = await Bun.build({
    entrypoints: [CLI_ENTRY],
    compile: {
      target: options.target.bunTarget,
      outfile,
    },
    minify: options.minify ?? true,
    sourcemap: 'none',
    plugins: [
      {
        name: 'stub-optional-devtools',
        setup(build) {
          build.onResolve({filter: /^react-devtools-core$/}, () => ({
            path: 'react-devtools-core',
            namespace: 'cosmew-stub',
          }));
          build.onLoad({filter: /.*/, namespace: 'cosmew-stub'}, () => ({
            contents: 'export default { connectToDevTools() {} };',
            loader: 'js',
          }));
        },
      },
    ],
  });

  if (!built.success) {
    const details = built.logs.map(log => log.message).join('\n') || 'unknown Bun.build failure';
    throw new Error(`Failed to compile ${options.target.key}: ${details}`);
  }

  const stat = statSync(outfile);
  const sha256 = sha256File(outfile);
  let smokePassed: boolean | undefined;

  if (options.smoke && !crossCompiled) {
    const ver = spawnSync(outfile, ['--version'], {encoding: 'utf8', timeout: 10_000});
    const help = spawnSync(outfile, ['--help'], {encoding: 'utf8', timeout: 10_000});
    if (ver.status !== 0 || help.status !== 0 || !help.stdout.includes('Cosmew')) {
      throw new Error(
        `Compiled binary smoke test failed for ${options.target.key} (version=${ver.status}, help=${help.status}): ${ver.stderr || help.stderr}`,
      );
    }
    smokePassed = true;
  }

  return {target: options.target, outfile, bytes: stat.size, sha256, crossCompiled, smokePassed};
}

if (import.meta.main) {
  const {values} = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      target: {type: 'string'},
      all: {type: 'boolean', default: false},
      outdir: {type: 'string', default: join(REPO_ROOT, 'dist', 'bin')},
      smoke: {type: 'boolean', default: false},
      checksum: {type: 'boolean', default: true},
      minify: {type: 'boolean', default: true},
      help: {type: 'boolean', default: false},
    },
  });

  if (values.help) {
    process.stdout.write(
      `Usage: bun scripts/build-binary.ts [--target host|${Object.keys(BINARY_TARGETS).join('|')}] [--all] [--outdir dist/bin] [--smoke] [--no-checksum]\n`,
    );
    process.exit(0);
  }

  const targets = resolveTargets({target: values.target, all: values.all});
  const results: BuildBinaryResult[] = [];
  for (const target of targets) {
    if (hostTargetKey() !== target.key) {
      process.stderr.write(
        `Notice: cross-compiling ${target.key} from ${process.platform}-${process.arch}; native @napi-rs/keyring binaries require building on the target OS/arch for OS keyring access (env-var credentials still work).\n`,
      );
    }
    const result = await buildBinary({
      target,
      outDir: resolve(values.outdir!),
      smoke: values.smoke,
      minify: values.minify,
    });
    results.push(result);
    process.stdout.write(
      `Built ${result.target.key}: ${result.outfile} (${(result.bytes / (1024 * 1024)).toFixed(2)} MiB, sha256=${result.sha256.slice(0, 12)}…${result.smokePassed ? ', smoke=PASS' : ''})\n`,
    );
  }

  if (values.checksum) {
    const checksumPath = join(resolve(values.outdir!), 'SHA256SUMS.txt');
    const lines = results.map(r => `${r.sha256}  ${r.target.filename}`).join('\n') + '\n';
    writeFileSync(checksumPath, lines, 'utf8');
    process.stdout.write(`Wrote checksums: ${checksumPath}\n`);
  }
}
