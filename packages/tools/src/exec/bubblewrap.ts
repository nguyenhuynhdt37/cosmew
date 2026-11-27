import {existsSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import type {CommandSandbox} from '@cosmew/contracts';
import {evaluateRead, SENSITIVE_HOME_PATHS} from '@cosmew/security';
import {WorkspaceRoot, scanExecutionMasks, type MaskDecision} from '@cosmew/workspace';
import type {NativeSandbox} from './native-sandbox';

export const BWRAP_PROXY_PORT = 3128;
export const BWRAP_PROXY_PORT_HEX = BWRAP_PROXY_PORT.toString(16).toUpperCase().padStart(4, '0');
export const BWRAP_PROXY_URL = `http://127.0.0.1:${BWRAP_PROXY_PORT}`;
export const BWRAP_PROXY_SOCKET_GUEST = '/tmp/cosmew-proxy.sock';

/**
 * Fixed shell trampoline run inside `bwrap --unshare-net` when a host proxy Unix socket and
 * `socat` are both available (ADR 0123). All dynamic values pass via positional parameters
 * (`$1..$4` and `"$@"`) — never interpolated into shell syntax. Because `bwrap` runs with
 * `--unshare-pid --die-with-parent`, the background `socat` terminates cleanly with the command.
 */
const BWRAP_PROXY_TRAMPOLINE = [
  'socat="$1"; sock="$2"; port="$3"; hex="$4"; shift 4',
  '"$socat" "TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:${sock}" >/dev/null 2>&1 &',
  'i=0',
  'while [ "$i" -lt 50 ]; do',
  '  if [ -r /proc/net/tcp ] && grep -q ":${hex} " /proc/net/tcp 2>/dev/null; then break; fi',
  '  i=$((i + 1))',
  '  sleep 0.01 2>/dev/null || break',
  'done',
  'exec "$@"',
].join('\n');

export interface BubblewrapOptions {
  /** Absolute path of the `bwrap` executable. */
  bwrap: string;
  /** Optional absolute path of `socat` used to bridge the host Unix proxy socket into `--unshare-net`. */
  socat?: string;
  workspace: string;
  state?: string;
  /** Private per-runtime directory holding the command's HOME and TMPDIR. */
  scratch: string;
  home: string;
  hideSecrets: boolean;
}

interface ResolvedTarget {
  path: string;
  directory: boolean;
}

const GLOB_META = /[*?]/;
const MAX_GLOB_ENTRIES = 10_000;

function statTarget(path: string): ResolvedTarget | null {
  try {
    const canonical = realpathSync.native(path);
    return {path: canonical, directory: statSync(canonical).isDirectory()};
  } catch {
    return null;
  }
}

function globToRegex(glob: string): RegExp {
  const body = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map(part =>
      part === '**/'
        ? '(.*/)?'
        : part === '**'
          ? '.*'
          : part === '*'
            ? '[^/]*'
            : part === '?'
              ? '[^/]'
              : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}(/.*)?$`);
}

function collectGlobMatches(pattern: string, out: Map<string, ResolvedTarget>): void {
  const segments = pattern.split('/');
  const globIdx = segments.findIndex(segment => GLOB_META.test(segment));
  if (globIdx <= 0) return;
  const base = segments.slice(0, globIdx).join('/') || '/';
  if (base === '/') return;
  const baseTarget = statTarget(base);
  if (!baseTarget?.directory) return;

  const canonicalPattern = join(baseTarget.path, ...segments.slice(globIdx)).replace(/\/+$/, '');
  const regex = globToRegex(canonicalPattern);
  let visited = 0;
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > MAX_GLOB_ENTRIES) {
        throw new Error(
          `Sandbox deny pattern exceeded ${MAX_GLOB_ENTRIES} scanned entries; refusing fail-open launch.`,
        );
      }
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const directory = entry.isDirectory();
      if (regex.test(full)) {
        out.set(full, {path: full, directory});
        continue;
      }
      if (directory) visit(full);
    }
  };
  visit(baseTarget.path);
}

function resolveSandboxTargets(
  patterns: readonly string[] | undefined,
  pruneNestedUnderDirs = false,
): ResolvedTarget[] {
  if (!patterns?.length) return [];
  const targets = new Map<string, ResolvedTarget>();
  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
    const basePattern = normalized.replace(/\/\*\*?$/, '') || '/';
    if (basePattern === '/') continue;
    if (!GLOB_META.test(basePattern)) {
      const target = statTarget(basePattern);
      if (target) targets.set(target.path, target);
      continue;
    }
    collectGlobMatches(normalized, targets);
  }
  const sorted = [...targets.values()].sort((a, b) => a.path.length - b.path.length);
  if (!pruneNestedUnderDirs) return sorted;
  const maskedDirs: string[] = [];
  const pruned: ResolvedTarget[] = [];
  for (const target of sorted) {
    if (maskedDirs.some(dir => target.path.startsWith(dir + '/'))) continue;
    pruned.push(target);
    if (target.directory) maskedDirs.push(target.path);
  }
  return pruned;
}

/**
 * Linux bubblewrap sandbox (ADR 0035), modelled on Codex `sandboxing/src/bwrap.rs`: read-only
 * root, writable workspace bind (workspace-write) plus `additionalDirectories`, read-only `.git` with
 * an empty config, the default sensitive home directories hidden, masked Cosmew state, private TMPDIR,
 * a PID namespace that dies with the command, and no network.
 *
 * IMPLEMENTED — NOT TESTED on a Linux host.
 */
export class BubblewrapSandbox implements NativeSandbox {
  readonly name = 'linux-bubblewrap' as const;
  readonly containsDescendants = true;

  constructor(private readonly options: BubblewrapOptions) {}

  wrap(argv: string[], sandbox: CommandSandbox, cwd: string): string[] {
    const {bwrap, scratch, home} = this.options;
    const workspace = new WorkspaceRoot(this.options.workspace);
    const writeMode = sandbox.mode === 'workspace-write';
    const extraRoots: WorkspaceRoot[] = [];
    if (writeMode) {
      const seenRoots = new Set<string>([workspace.root]);
      for (const root of sandbox.writableRoots ?? []) {
        try {
          if (!statSync(root).isDirectory()) continue;
          const extra = new WorkspaceRoot(root);
          if (seenRoots.has(extra.root)) continue;
          seenRoots.add(extra.root);
          extraRoots.push(extra);
        } catch {
          /* ignore missing or inaccessible roots */
        }
      }
    }

    const readOnly: string[] = [];
    const readOnlyGitConfigs: string[] = [];
    const hiddenFiles: string[] = [];
    const hiddenDirectories: string[] = [];
    const seenMasked = new Set<string>();

    for (const root of [workspace, ...extraRoots]) {
      const masks = scanExecutionMasks(root, (path, directory) => this.classify(root, path, directory));
      for (const path of masks.readOnly) {
        const abs = join(root.root, path);
        if (seenMasked.has(abs)) continue;
        seenMasked.add(abs);
        readOnly.push(abs);
        for (const file of ['config', 'config.worktree']) {
          const configFile = join(abs, file);
          if (existsSync(configFile)) readOnlyGitConfigs.push(configFile);
        }
      }
      for (const path of masks.hiddenFiles) {
        const abs = join(root.root, path);
        if (seenMasked.has(abs)) continue;
        seenMasked.add(abs);
        hiddenFiles.push(abs);
      }
      for (const path of masks.hiddenDirectories) {
        const abs = join(root.root, path);
        if (seenMasked.has(abs)) continue;
        seenMasked.add(abs);
        hiddenDirectories.push(abs);
      }
    }

    const denyReadTargets = resolveSandboxTargets(sandbox.denyRead, true);
    const denyWriteTargets = writeMode ? resolveSandboxTargets(sandbox.denyWrite) : [];

    const proxySocket =
      this.options.socat &&
      sandbox.proxySocketPath &&
      isAbsolute(sandbox.proxySocketPath) &&
      !/[\x00-\x1f\x7f]/.test(sandbox.proxySocketPath)
        ? sandbox.proxySocketPath
        : undefined;
    const finalArgv = proxySocket
      ? [
          '/bin/sh',
          '-c',
          BWRAP_PROXY_TRAMPOLINE,
          'cosmew-bwrap-proxy',
          this.options.socat!,
          BWRAP_PROXY_SOCKET_GUEST,
          String(BWRAP_PROXY_PORT),
          BWRAP_PROXY_PORT_HEX,
          ...argv,
        ]
      : argv;

    return [
      bwrap,
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-ipc',
      // Always unshare the network namespace. When the host proxy Unix socket and socat are both
      // available (ADR 0123), the socket is bind-mounted read-write and bridged to 127.0.0.1:3128
      // inside this isolated namespace; otherwise the sandbox stays completely offline.
      '--unshare-net',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--bind',
      join(scratch, 'home'),
      join(scratch, 'home'),
      '--bind',
      join(scratch, 'tmp'),
      join(scratch, 'tmp'),
      ...(proxySocket ? ['--bind', proxySocket, BWRAP_PROXY_SOCKET_GUEST] : []),
      writeMode ? '--bind' : '--ro-bind',
      workspace.root,
      workspace.root,
      ...extraRoots.flatMap(root => ['--bind', root.root, root.root]),
      // Mount sensitive home paths AFTER workspace/extraRoots binds so workspace === home or an
      // extraRoot containing home can never expose ~/.ssh, ~/.aws, ~/.gnupg, ~/.cosmew, etc.
      ...this.sensitiveHome(home, [workspace, ...extraRoots]),
      ...denyWriteTargets.flatMap(target => ['--ro-bind', target.path, target.path]),
      ...readOnly.flatMap(abs => ['--ro-bind', abs, abs]),
      // Git works with an empty repository config; credentials stay hidden.
      ...readOnlyGitConfigs.flatMap(abs => ['--ro-bind', '/dev/null', abs]),
      ...hiddenFiles.flatMap(abs => ['--ro-bind', '/dev/null', abs]),
      ...hiddenDirectories.flatMap(abs => ['--tmpfs', abs, '--remount-ro', abs]),
      ...this.stateOutsideRoots([workspace, ...extraRoots]),
      ...denyReadTargets.flatMap(target =>
        target.directory
          ? ['--tmpfs', target.path, '--remount-ro', target.path]
          : ['--ro-bind', '/dev/null', target.path],
      ),
      '--chdir',
      cwd,
      '--',
      ...finalArgv,
    ];
  }

  /** Credential directories under the real home are hidden; the rest of the filesystem stays readable (ADR 0061). */
  private sensitiveHome(home: string, roots: readonly WorkspaceRoot[]): string[] {
    let canonicalHome = home;
    try {
      canonicalHome = realpathSync.native(home);
    } catch {
      /* keep raw home when non-existent */
    }
    const candidates = new Set<string>();
    for (const rel of SENSITIVE_HOME_PATHS) {
      const candidate = join(canonicalHome, rel);
      if (!existsSync(candidate)) continue;
      let resolved = candidate;
      try {
        resolved = realpathSync.native(candidate);
      } catch {
        /* keep candidate */
      }
      if (roots.some(root => root.root === resolved || root.root.startsWith(resolved + '/'))) continue;
      candidates.add(resolved);
    }
    const sorted = [...candidates].sort((a, b) => a.length - b.length);
    const maskedDirs: string[] = [];
    const out: string[] = [];
    for (const path of sorted) {
      if (maskedDirs.some(dir => path.startsWith(dir + '/'))) continue;
      try {
        if (statSync(path).isDirectory()) {
          maskedDirs.push(path);
          out.push('--tmpfs', path, '--remount-ro', path);
        } else {
          out.push('--ro-bind', '/dev/null', path);
        }
      } catch {
        /* skip vanishing path */
      }
    }
    return out;
  }

  private classify(workspace: WorkspaceRoot, path: string, directory: boolean): MaskDecision {
    const name = path.toLowerCase().split('/').at(-1)!;
    if (name === '.git') return path === '.git' && directory ? 'read-only' : 'hide';
    if (name === '.cosmew' || name === '.futryn' || name === '.hannes') return 'hide';
    if (name.startsWith('.cosmew-patch-') || name.startsWith('.futryn-patch-') || name.startsWith('.hannes-patch-'))
      return 'hide';

    const decision = evaluateRead(path, join(workspace.root, path), {stateDirectory: this.options.state});
    if (decision.effect === 'deny') return 'hide';
    if (this.options.hideSecrets && decision.effect === 'ask' && !directory) return 'hide';
    return 'keep';
  }

  private stateOutsideRoots(roots: WorkspaceRoot[]): string[] {
    const {state} = this.options;
    if (!state) return [];
    const insideRoot = roots.some(root => state === root.root || state.startsWith(root.root + '/'));
    return insideRoot ? [] : ['--tmpfs', state];
  }
}
