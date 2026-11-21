import {existsSync, statSync} from 'node:fs';
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

/**
 * Linux bubblewrap sandbox (ADR 0035), modelled on Codex `sandboxing/src/bwrap.rs`: read-only
 * root, writable workspace bind (workspace-write) plus `additionalDirectories`, read-only `.git` with
 * an empty config, the default sensitive home directories hidden, masked Cosmew state, private /tmp,
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
    const masks = scanExecutionMasks(workspace, (path, directory) => this.classify(workspace, path, directory));
    const inWorkspace = (path: string) => join(workspace.root, path);

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
      '--tmpfs',
      '/tmp',
      ...this.sensitiveHome(home),
      '--bind',
      join(scratch, 'home'),
      join(scratch, 'home'),
      '--bind',
      join(scratch, 'tmp'),
      join(scratch, 'tmp'),
      sandbox.mode === 'workspace-write' ? '--bind' : '--ro-bind',
      workspace.root,
      workspace.root,
      ...(sandbox.mode === 'workspace-write'
        ? (sandbox.writableRoots ?? []).filter(root => existsSync(root)).flatMap(root => ['--bind', root, root])
        : []),
      ...masks.readOnly.flatMap(path => ['--ro-bind', inWorkspace(path), inWorkspace(path)]),
      // Git works with an empty repository config; credentials stay hidden.
      ...masks.readOnly.flatMap(path =>
        ['config', 'config.worktree']
          .filter(file => existsSync(join(inWorkspace(path), file)))
          .flatMap(file => ['--ro-bind', '/dev/null', join(inWorkspace(path), file)]),
      ),
      ...masks.hiddenFiles.flatMap(path => ['--ro-bind', '/dev/null', inWorkspace(path)]),
      ...masks.hiddenDirectories.flatMap(path => ['--tmpfs', inWorkspace(path), '--remount-ro', inWorkspace(path)]),
      ...this.stateOutsideWorkspace(workspace),
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
    if (name === '.futryn' || name === '.hannes') return 'hide';
    if (name.startsWith('.futryn-patch-') || name.startsWith('.hannes-patch-')) return 'hide';

    const decision = evaluateRead(path, join(workspace.root, path), {stateDirectory: this.options.state});
    if (decision.effect === 'deny') return 'hide';
    if (this.options.hideSecrets && decision.effect === 'ask' && !directory) return 'hide';
    return 'keep';
  }

  private stateOutsideWorkspace(workspace: WorkspaceRoot): string[] {
    const {state} = this.options;
    return state && !state.startsWith(workspace.root + '/') ? ['--tmpfs', state] : [];
  }
}
