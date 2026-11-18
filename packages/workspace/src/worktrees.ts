import {existsSync, lstatSync, mkdirSync, realpathSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {FutrynError} from '@futryn/contracts';

/**
 * Isolated Git worktrees for subagents (`isolation: "worktree"`, Wave 2 S5c). Every Git invocation runs with
 * the same hardening as the listing and /diff collectors (ADR 0037): no fsmonitor, no hooks, explicit bare
 * repositories only, inherited `GIT_*` variables dropped, repository clean/process filter drivers disabled.
 * `.git` is only ever written here, by the host (`git worktree add/remove`), never by the child.
 */
const SAFE_GIT_ARGS = [
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'core.quotePath=false',
  '-c',
  'commit.gpgsign=false',
];
const gitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
});

export type WorktreeRefusal = 'not-a-repository' | 'git-unavailable' | 'no-commit' | 'create-failed';

export class WorktreeError extends FutrynError {
  constructor(readonly reason: WorktreeRefusal) {
    super(reason === 'create-failed' ? 'STORAGE' : 'UNSUPPORTED');
  }
}

export interface WorktreeInfo {
  /** Canonical absolute path of the worktree directory (the child's workspace and only writable root). */
  path: string;
  branch: string;
  baseCommit: string;
  /** Common Git directory of the main repository; commands may read it (never write it). */
  gitCommonDir: string;
  repositoryRoot: string;
}

export interface WorktreeFinish {
  /** True when the worktree holds uncommitted changes or commits beyond the base. */
  changed: boolean;
  /** True when the (unchanged) worktree and its branch were deleted. */
  removed: boolean;
}

export interface GitWorktreesOptions {
  workspaceRoot: string;
  /**
   * Parent of the per-repository worktree directories. The host passes a directory under Futryn's per-user
   * state (`~/.futryn-worktrees`, a sibling of the state directory because policy denies the state directory to children); the fallback is a per-user directory in the OS temp directory, never a
   * shared fixed path. Every component created or used must be a real directory owned by the current user
   * with mode 0700 (symlinks and other owners are refused).
   */
  baseDirectory?: string;
}

export class GitWorktrees {
  private readonly workspaceRoot: string;
  private readonly baseDirectory: string;

  constructor(options: GitWorktreesOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.baseDirectory = resolve(
      options.baseDirectory ?? join(tmpdir(), `futryn-worktrees-${process.getuid?.() ?? 'user'}`),
    );
  }

  /** Creates `directory` (and missing parents) as 0700 and verifies each created/own component with lstat. */
  private ensurePrivateDirectory(directory: string, ownedFrom: string): void {
    const chain: string[] = [];
    for (let current = directory; ; current = dirname(current)) {
      chain.unshift(current);
      if (current === ownedFrom || dirname(current) === current) break;
    }
    mkdirSync(dirname(chain[0]!), {recursive: true, mode: 0o700});
    const uid = process.getuid?.();
    for (const part of chain) {
      let info = lstatSync(part, {throwIfNoEntry: false});
      if (!info) {
        mkdirSync(part, {mode: 0o700});
        info = lstatSync(part);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorktreeError('create-failed');
      if (process.platform === 'win32') continue;
      if (uid !== undefined && info.uid !== uid) throw new WorktreeError('create-failed');
      if ((info.mode & 0o077) !== 0) throw new WorktreeError('create-failed');
    }
  }

  private git(cwd: string, args: string[], overrides: string[] = []) {
    try {
      const result = Bun.spawnSync(['git', ...SAFE_GIT_ARGS, ...overrides, ...args], {
        cwd,
        env: gitEnvironment(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        status: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        error: undefined as string | undefined,
      };
    } catch {
      return {status: null, stdout: '', stderr: '', error: 'git-unavailable'};
    }
  }

  /** Disables repository-configured clean/process filter drivers (they would execute repository commands). */
  private filterOverrides(cwd: string): string[] {
    const config = this.git(cwd, [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process)$',
    ]);
    const drivers = new Set(
      config.stdout
        .split('\0')
        .filter(Boolean)
        .map(key => key.replace(/\.(clean|smudge|process)$/, '')),
    );
    return [...drivers].flatMap(driver => [
      '-c',
      `${driver}.clean=`,
      '-c',
      `${driver}.smudge=`,
      '-c',
      `${driver}.process=`,
      '-c',
      `${driver}.required=false`,
    ]);
  }

  private locate(agentId: string) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(agentId)) throw new WorktreeError('create-failed');
    const inside = this.git(this.workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
    if (inside.error) throw new WorktreeError('git-unavailable');
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') throw new WorktreeError('not-a-repository');
    const top = this.git(this.workspaceRoot, ['rev-parse', '--show-toplevel']);
    const common = this.git(this.workspaceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (top.status !== 0 || common.status !== 0) throw new WorktreeError('create-failed');
    const repositoryRoot = realpathSync.native(top.stdout.trim());
    const gitCommonDir = realpathSync.native(common.stdout.trim());
    const repoKey = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 12);
    const parent = join(this.baseDirectory, repoKey);
    return {
      repositoryRoot,
      gitCommonDir,
      parent,
      branch: `futryn/agent-${agentId.slice(0, 8)}`,
      path: join(parent, agentId),
    };
  }

  /** Creates a worktree on a fresh branch at the current HEAD; refuses anything that is not a Git working tree. */
  create(agentId: string): WorktreeInfo {
    const where = this.locate(agentId);
    const head = this.git(this.workspaceRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.status !== 0) throw new WorktreeError('no-commit');
    const base = head.stdout.trim();
    this.ensurePrivateDirectory(where.parent, this.baseDirectory);
    // `worktree add` checks files out, which would run repository smudge/process filters: disable every
    // configured driver (plus the clean side) for the checkout.
    const added = this.git(
      where.repositoryRoot,
      ['worktree', 'add', '--quiet', '-b', where.branch, where.path, base],
      this.filterOverrides(where.repositoryRoot),
    );
    if (added.status !== 0) throw new WorktreeError('create-failed');
    return {
      path: realpathSync.native(where.path),
      branch: where.branch,
      baseCommit: base,
      gitCommonDir: where.gitCommonDir,
      repositoryRoot: where.repositoryRoot,
    };
  }

  /** Reopens a worktree that a previous call kept (e.g. before a restart); undefined when it is gone. */
  open(agentId: string): WorktreeInfo | undefined {
    const where = this.locate(agentId);
    if (!existsSync(where.path)) return undefined;
    const path = realpathSync.native(where.path);
    const head = this.git(path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const main = this.git(this.workspaceRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.status !== 0 || main.status !== 0) return undefined;
    const base = this.git(path, ['merge-base', head.stdout.trim(), main.stdout.trim()]);
    return {
      path,
      branch: where.branch,
      baseCommit: base.status === 0 ? base.stdout.trim() : head.stdout.trim(),
      gitCommonDir: where.gitCommonDir,
      repositoryRoot: where.repositoryRoot,
    };
  }

  exists(info: Pick<WorktreeInfo, 'path'>): boolean {
    return existsSync(info.path);
  }

  /** Whether the worktree differs from its base: uncommitted/untracked files or new commits. */
  hasChanges(info: WorktreeInfo): boolean {
    if (!existsSync(info.path)) return false;
    const overrides = this.filterOverrides(info.path);
    const status = this.git(info.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], overrides);
    // An inspection failure is treated as "changed": never delete work we could not examine.
    if (status.status !== 0 || status.stdout.length > 0) return true;
    const head = this.git(info.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return head.status !== 0 || head.stdout.trim() !== info.baseCommit;
  }

  /** Deletes an unchanged worktree and its branch; keeps (and reports) one that holds changes. */
  finish(info: WorktreeInfo): WorktreeFinish {
    if (this.hasChanges(info)) return {changed: true, removed: false};
    this.remove(info);
    return {changed: false, removed: true};
  }

  remove(info: WorktreeInfo): void {
    this.git(info.repositoryRoot, ['worktree', 'remove', '--force', info.path]);
    if (existsSync(info.path)) rmSync(info.path, {recursive: true, force: true});
    this.git(info.repositoryRoot, ['worktree', 'prune']);
    this.git(info.repositoryRoot, ['branch', '-D', info.branch]);
  }
}
