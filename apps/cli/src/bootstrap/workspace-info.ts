import {readdirSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';

/**
 * Read-only workspace views for the TUI: the `@file` picker list and the `/diff` report. Neither is a
 * tool and neither reaches the model; untrusted file names and contents are sanitized for display.
 */

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.cosmew',
  '.hannes',
  '.futryn',
  'dist',
  '.DS_Store',
  '.codegraph',
]);

/** Workspace files for the `@file` picker: bounded depth and count, common build/VCS folders skipped. */
export function scanWorkspaceFiles(workspaceRoot: string, query?: string, limit = 250): string[] {
  const root = resolve(workspaceRoot);
  const results: string[] = [];
  const q = query?.trim().toLowerCase() ?? '';

  const walk = (dir: string, depth: number) => {
    if (depth > 5 || results.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (!q || relPath.toLowerCase().includes(q)) {
          results.push(relPath);
        }
      }
    }
  };

  walk(root, 0);
  return results.sort();
}

export {computeWorkspaceGitDiff, refreshWorkspaceGitDiff} from '@cosmew/workspace';
