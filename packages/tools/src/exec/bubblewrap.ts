import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {CommandSandbox} from '@futryn/contracts';
import {evaluateRead} from '@futryn/security';
import {WorkspaceRoot, scanExecutionMasks, type MaskDecision} from '@futryn/workspace';
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
 * root, writable workspace bind (workspace-write), read-only `.git` with an empty config, home
 * hidden behind tmpfs, masked Futryn state, private /tmp, a PID namespace that dies with the
 * command, and no network namespace unless approved.
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
      '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc',
      ...(sandbox.network ? [] : ['--unshare-net']),
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--tmpfs', home,
      '--bind', join(scratch, 'home'), join(scratch, 'home'),
      '--bind', join(scratch, 'tmp'), join(scratch, 'tmp'),
      sandbox.mode === 'workspace-write' ? '--bind' : '--ro-bind', workspace.root, workspace.root,
      ...masks.readOnly.flatMap(path => ['--ro-bind', inWorkspace(path), inWorkspace(path)]),
      // Same as the Docker mask: git works with an empty repository config; credentials stay hidden.
      ...masks.readOnly.flatMap(path => ['config', 'config.worktree']
        .filter(file => existsSync(join(inWorkspace(path), file)))
        .flatMap(file => ['--ro-bind', '/dev/null', join(inWorkspace(path), file)])),
      ...masks.hiddenFiles.flatMap(path => ['--ro-bind', '/dev/null', inWorkspace(path)]),
      ...masks.hiddenDirectories.flatMap(path => ['--tmpfs', inWorkspace(path), '--remount-ro', inWorkspace(path)]),
      ...this.stateOutsideWorkspace(workspace),
      '--chdir', cwd,
      '--', ...argv,
    ];
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
