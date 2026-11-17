import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {WorkspaceRoot} from './paths';

export interface FileListing {
  /** Workspace-relative paths with `/` separators, sorted. */
  files: string[];
  /** True when the walk stopped at `maxEntries` or the deadline. */
  incomplete: boolean;
}

/**
 * Repository configuration is untrusted: `core.fsmonitor` names a program Git runs while listing
 * files, so an opened repository could execute code outside the sandbox. Listing therefore turns
 * off fsmonitor and hooks, refuses implicit bare repositories and ignores inherited GIT_* variables
 * (the same policy as the /diff collector, ADR 0037).
 */
const SAFE_GIT_OPTIONS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c',
  'safe.bareRepository=explicit',
];
const safeGitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
});

/** Dependency, build and VCS directories never treated as project scopes (W1.5 security review). */
export const VENDORED_DIRECTORIES: readonly string[] = [
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'target',
  '.venv',
];

/**
 * Whether a workspace-relative directory is third-party or ignored content: any segment is a
 * vendored directory, or Git (run with the hardened options above) reports it ignored. Repository
 * text there must never become project instructions. Git failing (not a repository, no git) leaves
 * only the vendored list.
 */
export function ignoredDirectory(workspace: WorkspaceRoot, relative: string): boolean {
  if (relative === '.' || !relative) return false;
  const segments = relative.split('/');
  if (segments.some(segment => VENDORED_DIRECTORIES.includes(segment.toLowerCase()))) return true;
  const git = Bun.spawnSync(['git', ...SAFE_GIT_OPTIONS, 'check-ignore', '-q', '--', `${relative}/`], {
    cwd: workspace.root,
    env: safeGitEnvironment(),
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return git.exitCode === 0;
}

/**
 * Files a tool may search: tracked and untracked-but-not-ignored files from Git when the root is
 * a repository, otherwise a walk that skips `.git` and never follows symlinked directories.
 */
export function listWorkspaceFiles(
  workspace: WorkspaceRoot,
  options: {maxEntries?: number; deadline?: number} = {},
): FileListing {
  const maxEntries = options.maxEntries ?? 50000;
  const deadline = options.deadline ?? Date.now() + 30000;
  const git = Bun.spawnSync(
    ['git', ...SAFE_GIT_OPTIONS, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: workspace.root,
      env: safeGitEnvironment(),
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
  if (git.exitCode === 0) {
    const all = Buffer.from(git.stdout).toString('utf8').split('\0').filter(Boolean);
    const files = [...new Set(all)].filter(path => !path.split('/').includes('.git')).sort();
    return {files: files.slice(0, maxEntries), incomplete: files.length > maxEntries};
  }
  const files: string[] = [];
  let incomplete = false;
  const walk = (dir: string, prefix: string) => {
    if (incomplete) return;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxEntries || Date.now() > deadline) {
        incomplete = true;
        return;
      }
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(workspace.root, '');
  return {files: files.sort(), incomplete};
}
