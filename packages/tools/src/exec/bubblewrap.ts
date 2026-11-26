import {existsSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {join} from 'node:path';
import type {CommandSandbox} from '@cosmew/contracts';
import {evaluateRead, SENSITIVE_HOME_PATHS} from '@cosmew/security';
import {WorkspaceRoot, scanExecutionMasks, type MaskDecision} from '@cosmew/workspace';
import type {NativeSandbox} from './native-sandbox';

export interface BubblewrapOptions {
  /** Absolute path of the `bwrap` executable. */
  bwrap: string;
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
      if (++visited > MAX_GLOB_ENTRIES) return;
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

function resolveSandboxTargets(patterns: readonly string[] | undefined): ResolvedTarget[] {
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
  return [...targets.values()].sort((a, b) => a.path.length - b.path.length);
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

    const denyReadTargets = resolveSandboxTargets(sandbox.denyRead);
    const denyWriteTargets = writeMode ? resolveSandboxTargets(sandbox.denyWrite) : [];

    return [
      bwrap,
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-ipc',
      // No network namespace member can reach the host's loopback proxy: on Linux a sandboxed
      // command has no network at all (ADR 0061; a socket bridge to the proxy is Needs verification).
      '--unshare-net',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      ...this.sensitiveHome(home),
      '--bind',
      join(scratch, 'home'),
      join(scratch, 'home'),
      '--bind',
      join(scratch, 'tmp'),
      join(scratch, 'tmp'),
      writeMode ? '--bind' : '--ro-bind',
      workspace.root,
      workspace.root,
      ...extraRoots.flatMap(root => ['--bind', root.root, root.root]),
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
      ...argv,
    ];
  }

  /** Credential directories under the real home are hidden; the rest of the filesystem stays readable (ADR 0061). */
  private sensitiveHome(home: string): string[] {
    return SENSITIVE_HOME_PATHS.map(path => join(home, path))
      .filter(
        path => existsSync(path) && !(this.options.workspace === path || this.options.workspace.startsWith(path + '/')),
      )
      .flatMap(path => (statSync(path).isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path]));
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
