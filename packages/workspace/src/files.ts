import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceRoot } from './paths';

export interface FileListing {
  /** Workspace-relative paths with `/` separators, sorted. */
  files: string[];
  /** True when the walk stopped at `maxEntries` or the deadline. */
  incomplete: boolean;
}

/**
 * Files a tool may search: tracked and untracked-but-not-ignored files from Git when the root is
 * a repository, otherwise a walk that skips `.git` and never follows symlinked directories.
 */
export function listWorkspaceFiles(workspace: WorkspaceRoot, options: { maxEntries?: number; deadline?: number } = {}): FileListing {
  const maxEntries = options.maxEntries ?? 50000;
  const deadline = options.deadline ?? Date.now() + 30000;
  const git = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: workspace.root, stdout: 'pipe', stderr: 'ignore' });
  if (git.exitCode === 0) {
    const all = Buffer.from(git.stdout).toString('utf8').split('\0').filter(Boolean);
    const files = [...new Set(all)].filter(path => !path.split('/').includes('.git')).sort();
    return { files: files.slice(0, maxEntries), incomplete: files.length > maxEntries };
  }
  const files: string[] = [];
  let incomplete = false;
  const walk = (dir: string, prefix: string) => {
    if (incomplete) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxEntries || Date.now() > deadline) { incomplete = true; return; }
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(workspace.root, '');
  return { files: files.sort(), incomplete };
}
