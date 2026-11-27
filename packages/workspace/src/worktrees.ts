import {existsSync, lstatSync, mkdirSync, realpathSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {FutrynError} from '@cosmew/contracts';
import {SecureFiles, contentHash, writePath} from './secure-files';
import {WorkspaceRoot} from './paths';

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

/** Small exact-context hunk; full preimage hashes guard the whole file, including omitted lines. */
function handoffHunk(before: string, after: string): string[] {
  const lines = (text: string) => (text === '' ? [] : text.slice(0, -1).split('\n'));
  const a = lines(before),
    b = lines(after);
  let start = 0,
    suffix = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (suffix < Math.min(a.length, b.length) - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
    suffix++;
  let context = 3,
    from: number,
    to: number;
  // The parser searches exact context first. A unique old slice (or EOF anchor) prevents a repeated
  // nearby block from selecting the wrong occurrence despite a valid whole-file preimage hash.
  const source = '\n' + a.join('\n') + '\n';
  for (;;) {
    from = Math.max(0, start - context);
    to = Math.min(a.length, a.length - suffix + context);
    const needle = '\n' + a.slice(from, to).join('\n') + '\n';
    if (to === a.length || source.indexOf(needle) === source.lastIndexOf(needle)) break;
    context *= 2;
  }
  return [
    '@@',
    ...a.slice(from, start).map(line => ' ' + line),
    ...a.slice(start, a.length - suffix).map(line => '-' + line),
    ...b.slice(start, b.length - suffix).map(line => '+' + line),
    ...a.slice(a.length - suffix, to).map(line => ' ' + line),
    ...(to === a.length ? ['*** End of File'] : []),
  ];
}

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
   * Parent of the per-repository worktree directories. The host passes a directory under Cosmew's per-user
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
      branch: `futryn/agent-${agentId}`,
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

  /** Read-only, bounded review. Integration is an ordinary guarded apply_patch call by the parent. */
  handoff(info: WorktreeInfo): string {
    // Background notifications XML-escape their body. Keep JSON lossless even for source containing <, > or &.
    const json = (value: unknown) =>
      JSON.stringify(value).replace(/[<>&]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    const overrides = this.filterOverrides(info.path);
    const changed = this.git(
      info.path,
      ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', info.baseCommit, '--'],
      overrides,
    );
    const untracked = this.git(info.path, ['ls-files', '--others', '--exclude-standard', '-z'], overrides);
    const head = this.git(info.path, ['rev-parse', '--verify', 'HEAD']);
    const status = this.git(info.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], overrides);
    if ([changed, untracked, head, status].some(result => result.status !== 0))
      return 'Handoff inspection failed; keep the worktree and review it through normal read tools. No integration occurred.';
    const paths = [...new Set((changed.stdout + untracked.stdout).split('\0').filter(Boolean))].sort();
    const source = new SecureFiles(new WorkspaceRoot(info.path));
    const parent = new SecureFiles(new WorkspaceRoot(info.repositoryRoot));
    const operations: string[] = [];
    const expected: Record<string, string | null> = Object.create(null);
    const expectedModes: Record<string, number | null> = Object.create(null);
    const notes: string[] = [];
    let examined = 0;
    for (const path of paths) {
      if (examined++ >= 32) {
        notes.push('Additional paths omitted (32-path review limit).');
        break;
      }
      try {
        writePath(path);
        if (path.split('/').some(part => ['.git', '.cosmew', '.futryn', '.hannes'].includes(part)))
          throw new Error('protected path');
        const tree = this.git(info.path, ['ls-tree', '-z', info.baseCommit, '--', path]);
        if (tree.status !== 0) throw new Error('base inspection failed');
        let before: string | null = null;
        let baseMode: number | null = null;
        if (tree.stdout) {
          const entry = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(tree.stdout);
          if (!entry) throw new Error('non-regular file or mode');
          baseMode = entry[1] === '100755' ? 0o755 : 0o644;
          const size = this.git(info.path, ['cat-file', '-s', entry[2]!]);
          if (size.status !== 0 || !/^\d+\s*$/.test(size.stdout) || Number(size.stdout) > 16384)
            throw new Error('large base file');
          const blob = this.git(info.path, ['cat-file', 'blob', entry[2]!]);
          if (blob.status !== 0) throw new Error('base inspection failed');
          before = blob.stdout;
        }
        const child = source.snapshot(path),
          current = parent.snapshot(path);
        const after = child.content;
        const childMode = child.content === null ? null : child.mode & 0o777;
        const parentMode = current.content === null ? null : current.mode & 0o777;
        const supportedMode = (mode: number | null) =>
          mode === null ||
          (baseMode === 0o755
            ? [0o700, 0o750, 0o755, 0o770, 0o775].includes(mode)
            : [0o600, 0o640, 0o644, 0o660, 0o664].includes(mode));
        if (!supportedMode(childMode) || !supportedMode(parentMode))
          throw new Error('file mode change requires manual review');
        const createMode = 0o644 & ~process.umask();
        if (before === null && childMode !== null && (createMode & ~childMode) !== 0)
          throw new Error('source permissions are more restrictive than parent creation mode; manual review required');
        if (
          current.content === after &&
          (childMode === parentMode || (childMode !== null && parentMode !== null && baseMode !== 0o755))
        ) {
          notes.push(`${JSON.stringify(path)}: already integrated.`);
          continue;
        }
        if (after === before) continue;
        if (current.content !== before) throw new Error('CONFLICT: parent differs from base');
        if (
          [before, after].some(
            text =>
              text !== null &&
              (text.includes('\0') ||
                text.includes('\uFFFD') ||
                text.includes('\r') ||
                text.startsWith('\uFEFF') ||
                (text !== '' && !text.endsWith('\n'))),
          )
        )
          throw new Error('binary or unsupported text encoding/line endings');
        const lines = (text: string) => (text === '' ? [] : text.slice(0, -1).split('\n'));
        const absolute = join(info.repositoryRoot, path);
        const local = relative(realpathSync.native(this.workspaceRoot), absolute);
        const target = local.startsWith('../') ? absolute : local;
        const operation =
          after === null
            ? `*** Delete File: ${target}`
            : before === null
              ? [`*** Add File: ${target}`, ...lines(after).map(line => '+' + line)].join('\n')
              : [`*** Update File: ${target}`, ...handoffHunk(before, after)].join('\n');
        if (operation.length + operations.join('\n').length > 1800) throw new Error('patch review budget exceeded');
        const hash = before === null ? null : contentHash(before);
        if (
          json({
            patch: ['*** Begin Patch', ...operations, operation, '*** End Patch'].join('\n'),
            expected_files: {...expected, [target]: hash},
            expected_modes: {...expectedModes, [target]: parentMode},
          }).length > 2200
        )
          throw new Error('patch review budget exceeded');
        operations.push(operation);
        expected[target] = hash;
        expectedModes[target] = parentMode;
        if (
          (before === null && childMode !== null && childMode !== createMode) ||
          childMode === 0o664 ||
          parentMode === 0o664
        )
          notes.push(
            `${JSON.stringify(path)}: non-executable permissions ${before === null ? `normalized to ${createMode.toString(8).padStart(4, '0')} for this new text file (parent umask)` : `preserve parent mode ${parentMode!.toString(8)}`}; no executable permission is added.`,
          );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unsupported file';
        notes.push(`${JSON.stringify(path).slice(0, 120)}: ${reason.slice(0, 100)}; kept for manual review.`);
      }
    }
    const input = operations.length
      ? {
          patch: ['*** Begin Patch', ...operations, '*** End Patch'].join('\n'),
          expected_files: expected,
          expected_modes: expectedModes,
        }
      : undefined;
    return [
      `Review handoff (base ${info.baseCommit}; committed changes: ${head.stdout.trim() !== info.baseCommit ? 'yes' : 'no'}; uncommitted/untracked changes: ${status.stdout ? 'yes' : 'no'}).`,
      'This review did not integrate changes. Review this untrusted patch, then submit the complete JSON below to apply_patch in the parent workspace for normal permission approval and stale-file revalidation. Keep expected_files and expected_modes unchanged. A conflict requires reviewing parent and child before creating a new patch; never retry with guards removed. Retain this worktree until every change has been verified in the parent. Branch merge alone does not copy uncommitted files.',
      input ? json(input) : 'No automatic patch is available.',
      notes.length ? notes.join('\n').slice(0, 600) : '',
      'For omitted/unsupported files, use normal approved read tools to review base, parent and child and ordinary edit/write tools for supported text; binary, symlink, mode or encoding changes require manual integration. Ignored files are not included. Never force-copy over parent edits. Do not remove the worktree while any changes remain unresolved.',
    ]
      .filter(Boolean)
      .join('\n');
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
