import {lstatSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {FutrynError, type CommandSandbox} from '@futryn/contracts';
import {SECRET_FILE_EXCEPTIONS, SECRET_FILE_RULES, evaluateRead} from '@futryn/security';
import {WorkspaceRoot, scanExecutionMasks, type MaskDecision} from '@futryn/workspace';

/** One bind mount, in the shape `docker inspect` reports it. */
export interface Mount {
  Source: string;
  Target: string;
  ReadOnly: boolean;
}

/** What the trusted PID1 re-checks inside the container while another write session runs. */
export interface MaskVerification {
  gitPinned: boolean;
  /** Workspace-relative paths that must be mountpoints. */
  hidden: string[];
  /** Secret file-name regexes (case-insensitive) and their exceptions. */
  secret: string[];
  except: string[];
}

export interface MountPlan {
  workspace: WorkspaceRoot;
  /** The exact mount set the created container must have. */
  expected: Mount[];
  /** `docker create` arguments for `expected`. */
  args: string[];
  /** uid/gid the command runs as. */
  uid: number;
  gid: number;
  /** The top-level `.git` is a read-only mountpoint (it cannot be renamed or replaced). */
  gitPinned: boolean;
  verify: MaskVerification;
}

export interface MountSources {
  stateDirectory?: string;
  /** Empty read-only file in Futryn's private control directory. */
  emptyFile: string;
  /** Empty read-only directory in Futryn's private control directory. */
  emptyDirectory: string;
  /** Private control directory; its path must also be expressible as a mount source. */
  control: string;
}

/** Characters that would break Docker's comma-separated `--mount` syntax. */
const UNSAFE_MOUNT_PATH = /[,"\n\r]/;

/**
 * Mount plan for one launch (ADR 0034). Masks are recomputed from the live tree for every launch,
 * so a protected file created since the previous command is masked too.
 *
 * Docker follows symlinks in bind *sources*: a workspace path used as a source could be swapped for
 * a symlink to a host directory between this scan and `docker create`. So the only workspace-sourced
 * bind besides the root is the top-level `.git`, lstat-verified as a real directory, and only while
 * no running write-capable session could swap it (`allowGitSource`). Every other mask is sourced from
 * Futryn's private control directory.
 */
export function planContainerMounts(root: string, sandbox: CommandSandbox, sources: MountSources, allowGitSource = true): MountPlan {
  if (UNSAFE_MOUNT_PATH.test(root) || UNSAFE_MOUNT_PATH.test(sources.control)) throw new FutrynError('POLICY');

  const workspace = new WorkspaceRoot(root);
  const masks = scanExecutionMasks(workspace, (path, directory) => classify(workspace, path, directory, sources.stateDirectory, allowGitSource));

  if (masks.readOnly.some(path => path !== '.git')) throw new FutrynError('POLICY');
  const gitPinned = masks.readOnly.length > 0;
  if (gitPinned) {
    assertRealDirectory(join(workspace.root, '.git'));
    // Remote URLs and credential helpers live in the repository config; git works with it empty.
    for (const file of ['.git/config', '.git/config.worktree']) {
      if (existsAsRegularFile(join(workspace.root, file))) masks.hiddenFiles.push(file);
    }
  }

  const expected: Mount[] = [
    {Source: workspace.root, Target: '/workspace', ReadOnly: sandbox.mode === 'read-only'},
    ...masks.readOnly.map(path => ({Source: join(workspace.root, path), Target: `/workspace/${path}`, ReadOnly: true})),
    ...masks.hiddenFiles.map(path => ({Source: sources.emptyFile, Target: `/workspace/${path}`, ReadOnly: true})),
    ...masks.hiddenDirectories.map(path => ({Source: sources.emptyDirectory, Target: `/workspace/${path}`, ReadOnly: true})),
  ];

  const {uid, gid} = commandIdentity(workspace.root, sandbox);
  const verify: MaskVerification = {
    gitPinned,
    hidden: [...masks.hiddenDirectories, ...masks.hiddenFiles].filter(path => !path.startsWith('.git/')),
    ...secretNamePatterns(),
  };
  const args = expected.flatMap(mount => ['--mount', `type=bind,src=${mount.Source},dst=${mount.Target}${mount.ReadOnly ? ',readonly' : ''}`]);

  return {workspace, expected, args, uid, gid, gitPinned, verify};
}

function classify(workspace: WorkspaceRoot, path: string, directory: boolean, stateDirectory: string | undefined, allowGitSource: boolean): MaskDecision {
  const name = path.toLowerCase().split('/').at(-1)!;
  if (name === '.git') return path === '.git' && directory && allowGitSource ? 'read-only' : 'hide';
  if (name === '.futryn' || name === '.hannes') return 'hide';
  if (name.startsWith('.futryn-patch-') || name.startsWith('.hannes-patch-')) return 'hide';

  const decision = evaluateRead(path, join(workspace.root, path), {stateDirectory});
  if (decision.effect === 'deny') return 'hide';
  if (decision.effect === 'ask' && !directory) return 'hide';
  return 'keep';
}

/**
 * Writes run as the workspace owner so host files keep their ownership; a root-owned workspace is
 * refused. Read-only commands run as `nobody` (65534).
 */
function commandIdentity(root: string, sandbox: CommandSandbox): {uid: number; gid: number} {
  if (sandbox.mode !== 'workspace-write') return {uid: 65534, gid: 65534};
  const owner = statSync(root);
  if (owner.uid === 0) throw new FutrynError('POLICY');
  return {uid: owner.uid, gid: owner.gid || 65534};
}

function assertRealDirectory(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new FutrynError('POLICY');
}

/** False when the file does not exist; a symlink or special file there is refused. */
function existsAsRegularFile(path: string): boolean {
  let entry;
  try { entry = lstatSync(path); } catch { return false; }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new FutrynError('POLICY');
  return true;
}

function secretNamePatterns(): {secret: string[]; except: string[]} {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const secret = SECRET_FILE_RULES.map(rule => {
    if (rule.match === 'exact') return `^${escape(rule.value)}$`;
    if (rule.match === 'prefix') return `^${escape(rule.value)}${rule.value.endsWith('.') ? '.+' : ''}`;
    return `${escape(rule.value)}$`;
  });
  return {secret, except: SECRET_FILE_EXCEPTIONS.map(name => `^${escape(name)}$`)};
}
