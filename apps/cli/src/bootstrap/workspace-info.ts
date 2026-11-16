import {readdirSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import type {DiffLine, WorkspaceDiffFile, WorkspaceDiffReport} from '@futryn/contracts';
import {terminalText} from '@futryn/security';

/**
 * Read-only workspace views for the TUI: the `@file` picker list and the `/diff` report. Neither is a
 * tool and neither reaches the model; untrusted file names and contents are sanitized for display.
 */

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.hannes', '.futryn', 'dist', '.DS_Store', '.codegraph']);

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

const emptyDiff = (workspace: string, gitAvailable: boolean): WorkspaceDiffReport => ({
  workspace,
  gitAvailable,
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
});

/** `git diff` of the workspace as structured lines (bounded to 2000 lines per file). */
export function computeWorkspaceGitDiff(workspaceRoot: string): WorkspaceDiffReport {
  const root = resolve(workspaceRoot);
  try {
    const proc = Bun.spawnSync(['git', 'diff', '--no-color', '--unified=3'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      return emptyDiff(root, false);
    }

    // File names and contents are untrusted: strip terminal control bytes before they reach any UI.
    const raw = terminalText(Buffer.from(proc.stdout).toString('utf8'));
    if (!raw.trim()) {
      return emptyDiff(root, true);
    }

    const files: WorkspaceDiffFile[] = [];
    let currentFile: WorkspaceDiffFile | null = null;
    let oldLine = 1;
    let newLine = 1;
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of raw.split('\n')) {
      if (line.startsWith('diff --git ')) {
        if (currentFile) files.push(currentFile);
        const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        const path = match?.[2] ?? line.slice('diff --git '.length);
        currentFile = {
          path,
          status: 'modified',
          additions: 0,
          deletions: 0,
          lines: [],
        };
        continue;
      }
      if (!currentFile) continue;
      if (line.startsWith('new file mode')) {
        currentFile.status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        currentFile.status = 'deleted';
        continue;
      }
      if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
        currentFile.status = 'renamed';
        continue;
      }
      if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        continue;
      }
      if (line.startsWith('@@')) {
        const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        oldLine = hunkMatch ? Number(hunkMatch[1]) : 1;
        newLine = hunkMatch ? Number(hunkMatch[2]) : 1;
        currentFile.lines.push({
          type: 'hunk',
          oldLine: null,
          newLine: null,
          content: line,
        });
        continue;
      }
      if (currentFile.lines.length >= 2000) continue;

      if (line.startsWith('+')) {
        currentFile.additions++;
        totalAdditions++;
        currentFile.lines.push({
          type: 'add',
          oldLine: null,
          newLine: newLine++,
          content: line.slice(1),
        });
      } else if (line.startsWith('-')) {
        currentFile.deletions++;
        totalDeletions++;
        currentFile.lines.push({
          type: 'del',
          oldLine: oldLine++,
          newLine: null,
          content: line.slice(1),
        });
      } else if (line.startsWith(' ')) {
        const dl: DiffLine = {
          type: 'context',
          oldLine: oldLine++,
          newLine: newLine++,
          content: line.slice(1),
        };
        currentFile.lines.push(dl);
      }
    }

    if (currentFile) files.push(currentFile);
    return {
      workspace: root,
      gitAvailable: true,
      files,
      totalAdditions,
      totalDeletions,
    };
  } catch {
    return emptyDiff(root, false);
  }
}
