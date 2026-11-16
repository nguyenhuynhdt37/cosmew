import {execFile, spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import type {WorkspaceDiffFile, WorkspaceDiffReport} from '@futryn/contracts';
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

/** Limits apply to the displayed report; totals always describe that report, never unseen data. */
const MAX_FILES = 200;
const MAX_LINES = 2000;
const MAX_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 2 * MAX_BYTES;
const displayPath = (path: string) =>
  terminalText(path).replace(/[\n\r\t]/g, char => JSON.stringify(char).slice(1, -1));
interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}
interface GitRequest {
  args: string[];
  overrides: string[];
}
const emptyDiff = (
  workspace: string,
  state: NonNullable<WorkspaceDiffReport['state']>,
  message?: string,
): WorkspaceDiffReport => ({
  workspace,
  gitAvailable: state === 'ready',
  state,
  message,
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
});
const gitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
});
const gitArgs = (request: GitRequest) => [
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'core.quotePath=false',
  ...request.overrides,
  ...request.args,
];

/** Both sync compatibility consumers and asynchronous TUI refresh use this exact collection policy. */
function* collectDiff(root: string): Generator<GitRequest, WorkspaceDiffReport, GitResult> {
  let overrides: string[] = [];
  const request = function* (args: string[]): Generator<GitRequest, GitResult, GitResult> {
    return yield {args, overrides};
  };
  const inside = yield* request(['rev-parse', '--is-inside-work-tree']);
  if (inside.error)
    return emptyDiff(
      root,
      inside.error === 'ENOENT' ? 'git-unavailable' : inside.error === 'EACCES' ? 'denied' : 'error',
      'Git inspection could not start.',
    );
  if (inside.status !== 0 || inside.stdout.trim() !== 'true')
    return emptyDiff(
      root,
      /not a git repository/i.test(inside.stderr) ? 'not-repository' : 'error',
      'Workspace is not a readable Git working tree.',
    );
  const config = yield* request(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']);
  if (config.error || (config.status !== 0 && config.status !== 1))
    return emptyDiff(root, 'error', 'Cannot safely inspect Git filter configuration.');
  const drivers = new Set(
    config.stdout
      .split('\0')
      .filter(Boolean)
      .map(key => key.replace(/\.(clean|process)$/, '')),
  );
  overrides = [...drivers].flatMap(driver => [
    '-c',
    `${driver}.clean=`,
    '-c',
    `${driver}.process=`,
    '-c',
    `${driver}.required=false`,
  ]);
  const report = emptyDiff(root, 'ready');
  const branch = yield* request(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.error && branch.status === 0) report.branch = displayPath(branch.stdout.trim());
  else report.branch = 'detached HEAD';
  let reportBytes = 0;
  const flags = [
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=dirty',
    '--no-renames',
  ];
  // NUL-separated metadata supplies exact file boundaries even for quotes/newlines in paths.
  for (const layer of ['staged', 'unstaged'] as const) {
    const cached = layer === 'staged' ? ['--cached'] : [];
    const listing = yield* request([
      'diff',
      ...flags,
      ...cached,
      '--find-renames',
      '--name-status',
      '-z',
      '--relative',
      '--',
      '.',
    ]);
    if (listing.error || listing.status !== 0)
      return emptyDiff(root, 'error', 'Git change listing failed or exceeded its bound.');
    const fields = listing.stdout.split('\0');
    for (let index = 0; index < fields.length - 1;) {
      const kind = fields[index++]!;
      const oldPath = fields[index++]!;
      const path = /^[RC]/.test(kind) ? fields[index++]! : oldPath;
      if (report.files.length >= MAX_FILES || reportBytes >= MAX_REPORT_BYTES) {
        report.truncated = true;
        break;
      }
      const file: WorkspaceDiffFile = {
        path: displayPath(path),
        ...(path !== oldPath ? {oldPath: displayPath(oldPath)} : {}),
        layer,
        status: kind.startsWith('R') ? 'renamed' : kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified',
        additions: 0,
        deletions: 0,
        lines: [],
      };
      const patch = yield* request([
        'diff',
        ...flags,
        ...cached,
        '--find-renames',
        '--unified=3',
        '--relative',
        '--',
        ...new Set([oldPath, path]),
      ]);
      if (patch.error || (patch.status !== 0 && patch.status !== 1)) {
        file.truncated = true;
        report.truncated = true;
        file.lines.push({
          type: 'hunk',
          oldLine: null,
          newLine: null,
          content: 'Diff unavailable: command failed or exceeded the output/time bound.',
        });
      } else {
        parsePatch(file, patch.stdout);
        reportBytes += Buffer.byteLength(patch.stdout);
      }
      report.files.push(file);
    }
  }
  const untracked = yield* request(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
  if (untracked.error || untracked.status !== 0)
    return emptyDiff(root, 'error', 'Untracked file listing failed or exceeded its bound.');
  for (const path of untracked.stdout.split('\0').filter(Boolean)) {
    if (report.files.length >= MAX_FILES || reportBytes >= MAX_REPORT_BYTES) {
      report.truncated = true;
      break;
    }
    const file: WorkspaceDiffFile = {
      path: displayPath(path),
      layer: 'untracked',
      status: 'untracked',
      additions: 0,
      deletions: 0,
      lines: [],
    };
    // Git --no-index treats symlinks as link data, never follows them to outside content.
    const patch = yield* request([
      'diff',
      ...flags,
      '--no-index',
      '--unified=3',
      '--',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
      path,
    ]);
    if (patch.error || (patch.status !== 0 && patch.status !== 1)) {
      file.truncated = true;
      report.truncated = true;
      file.lines.push({
        type: 'hunk',
        oldLine: null,
        newLine: null,
        content: 'Diff unavailable: command failed or exceeded the output/time bound.',
      });
    } else {
      parsePatch(file, patch.stdout);
      reportBytes += Buffer.byteLength(patch.stdout);
    }
    report.files.push(file);
  }
  report.totalAdditions = report.files.reduce((sum, file) => sum + file.additions, 0);
  report.totalDeletions = report.files.reduce((sum, file) => sum + file.deletions, 0);
  report.truncated ||= report.files.some(file => file.truncated);
  return report;
}

function parsePatch(file: WorkspaceDiffFile, raw: string): void {
  let oldLine = 1,
    newLine = 1,
    inHunk = false;
  file.binary = raw.includes('Binary files ') || raw.includes('GIT binary patch');
  for (const rawLine of raw.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      oldLine = +hunk[1]!;
      newLine = +hunk[2]!;
      inHunk = true;
    } else if (!inHunk || !/^[ +\-]/.test(rawLine)) continue;
    if (file.lines.length >= MAX_LINES) {
      file.truncated = true;
      break;
    }
    const content = terminalText(hunk ? rawLine : rawLine.slice(1));
    if (hunk) file.lines.push({type: 'hunk', oldLine: null, newLine: null, content});
    else if (rawLine[0] === '+') {
      file.additions++;
      file.lines.push({type: 'add', oldLine: null, newLine: newLine++, content});
    } else if (rawLine[0] === '-') {
      file.deletions++;
      file.lines.push({type: 'del', oldLine: oldLine++, newLine: null, content});
    } else file.lines.push({type: 'context', oldLine: oldLine++, newLine: newLine++, content});
  }
}

/** Compatibility entry for non-rendering callers; aggregate wall-clock budget is 10 seconds. */
export function computeWorkspaceGitDiff(workspaceRoot: string): WorkspaceDiffReport {
  const root = resolve(workspaceRoot),
    collector = collectDiff(root),
    deadline = Date.now() + 10000;
  let step = collector.next();
  while (!step.done) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return emptyDiff(root, 'error', 'Git inspection exceeded its aggregate deadline.');
    const result = spawnSync('git', gitArgs(step.value), {
      cwd: root,
      env: gitEnvironment(),
      encoding: 'utf8',
      timeout: Math.min(2500, remaining),
      maxBuffer: MAX_BYTES,
    });
    step = collector.next({
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error ? ('code' in result.error ? String(result.error.code) : 'ERROR') : undefined,
    });
  }
  return step.value;
}

/** Nonblocking collection for the TUI. No Git invocation is performed by its render loop. */
export async function refreshWorkspaceGitDiff(workspaceRoot: string): Promise<WorkspaceDiffReport> {
  const root = resolve(workspaceRoot),
    collector = collectDiff(root),
    deadline = Date.now() + 10000;
  let step = collector.next();
  while (!step.done) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return emptyDiff(root, 'error', 'Git inspection exceeded its aggregate deadline.');
    const request = step.value;
    const result = await new Promise<GitResult>(resolveResult => {
      execFile(
        'git',
        gitArgs(request),
        {cwd: root, env: gitEnvironment(), encoding: 'utf8', timeout: Math.min(2500, remaining), maxBuffer: MAX_BYTES},
        (error, stdout, stderr) => {
          resolveResult({
            status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
            stdout,
            stderr,
            error: error && typeof error.code !== 'number' ? String(error.code ?? 'ERROR') : undefined,
          });
        },
      );
    });
    step = collector.next(result);
  }
  return step.value;
}
