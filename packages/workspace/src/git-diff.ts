import {execFile, spawnSync} from 'node:child_process';
import {lstatSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SecureFiles} from './secure-files';
import {workspaceDiffPaths} from './diff-baseline';
import {WorkspaceRoot} from './paths';
import {relative, resolve, isAbsolute} from 'node:path';
import type {
  WorkspaceDiffFile,
  WorkspaceDiffReport,
  WorkspaceDiffBase,
  WorkspaceDiffCapability,
} from '@cosmew/contracts';

/** Limits apply to the displayed report; totals always describe that report, never unseen data. */
const MAX_FILES = 200;
const MAX_LINES = 2000;
const MAX_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 2 * MAX_BYTES;
const displayPath = (path: string) => path.replace(/[\n\r\t]/g, char => JSON.stringify(char).slice(1, -1));
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
  PATH: '/usr/bin:/bin',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
});
const gitArgs = (request: GitRequest) => [
  '--no-pager',
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
  'protocol.allow=never',
  ...request.overrides,
  ...request.args,
];

/** Both sync compatibility consumers and asynchronous TUI refresh use this exact collection policy. */
function* collectDiff(root: string, options: GitDiffOptions): Generator<GitRequest, WorkspaceDiffReport, GitResult> {
  let overrides: string[] = [];
  const request = function* (args: string[]): Generator<GitRequest, GitResult, GitResult> {
    return yield {args, overrides};
  };
  const inside = yield* request(['rev-parse', '--is-inside-work-tree']);
  if (inside.error)
    return withoutGit(
      root,
      inside.error === 'ENOENT' ? 'git-unavailable' : inside.error === 'EACCES' ? 'denied' : 'error',
      'Git inspection could not start.',
      options,
    );
  if (inside.status !== 0 || inside.stdout.trim() !== 'true')
    return withoutGit(
      root,
      /not a git repository/i.test(inside.stderr) ? 'not-repository' : 'error',
      'Workspace is not a readable Git working tree.',
      options,
    );
  // Partial clone object reads may invoke a remote helper. Refuse before reading objects.
  const promisor = yield* request([
    'config',
    '--null',
    '--get-regexp',
    '^(extensions\\.partialclone|remote\\..*\\.promisor)$',
  ]);
  if (promisor.error || (promisor.status !== 0 && promisor.status !== 1) || promisor.stdout.trim())
    return emptyDiff(root, 'error', 'Partial-clone inspection is unavailable without network access.');
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
  const base = options.base ?? 'uncommitted';
  report.base = base;
  const branch = yield* request(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.error && branch.status === 0) report.branch = displayPath(branch.stdout.trim());
  else report.branch = 'detached HEAD';
  const branchBase = yield* request(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  let target: string | undefined;
  const candidates =
    branchBase.status === 0
      ? [branchBase.stdout.trim(), 'refs/heads/main', 'refs/heads/master']
      : ['refs/heads/main', 'refs/heads/master'];
  if (report.branch !== 'detached HEAD')
    for (const candidate of candidates) {
      const merge = yield* request(['merge-base', 'HEAD', candidate]);
      if (merge.status === 0 && /^[a-f0-9]{40,64}$/.test(merge.stdout.trim())) {
        target = merge.stdout.trim();
        break;
      }
    }
  const available = (yes: boolean, reason: string): WorkspaceDiffCapability =>
    yes ? {available: true} : {available: false, reason};
  report.capabilities = {
    session: available(
      !!options.sessionFiles && !options.sessionUnavailableReason,
      options.sessionUnavailableReason ?? 'Session change baseline unavailable.',
    ),
    uncommitted: {available: true},
    branch: available(
      !!target,
      report.branch === 'detached HEAD'
        ? 'Detached HEAD has no branch comparison.'
        : 'No local default branch or merge base. No network fetch is performed.',
    ),
  };
  if (base === 'session') return sessionDiff(root, options, report);
  if (base === 'branch' && !target) return {...report, state: 'error', message: report.capabilities.branch.reason};
  let workingBase: string | undefined = 'HEAD';
  if (base === 'uncommitted' && options.base) {
    const head = yield* request(['rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0) workingBase = undefined;
  }
  if (options.base === 'branch' || options.base === 'uncommitted')
    return yield* sealedDiff(root, options, report, base === 'branch' ? target! : workingBase, request);
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
      if (!canRead(root, oldPath, options) || !canRead(root, path, options)) continue;
      const file: WorkspaceDiffFile = {
        path: displayPath(path),
        ...(path !== oldPath ? {oldPath: displayPath(oldPath)} : {}),
        ...(base === 'branch' ? {} : {layer}),
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
      if (canRead(root, oldPath, options) && canRead(root, path, options)) report.files.push(file);
    }
  }
  const untracked = yield* request(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
  if (untracked.error || untracked.status !== 0)
    return emptyDiff(root, 'error', 'Untracked file listing failed or exceeded its bound.');
  for (const path of untracked.stdout.split('\0').filter(Boolean)) {
    if (!canRead(root, path, options)) continue;
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
    if (canRead(root, path, options)) report.files.push(file);
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
    const content = hunk ? rawLine : rawLine.slice(1);
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
export function computeWorkspaceGitDiff(workspaceRoot: string, options: GitDiffOptions = {}): WorkspaceDiffReport {
  const root = canonicalRoot(workspaceRoot),
    collector = collectDiff(root, options),
    deadline = Date.now() + 10000;
  let step = collector.next();
  while (!step.done) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return finish(emptyDiff(root, 'error', 'Git inspection exceeded its aggregate deadline.'), options);
    const result = spawnSync('/usr/bin/git', gitArgs(step.value), {
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
  return finish(step.value, options);
}

/** Nonblocking collection for the TUI. No Git invocation is performed by its render loop. */
export async function refreshWorkspaceGitDiff(
  workspaceRoot: string,
  options: GitDiffOptions = {},
): Promise<WorkspaceDiffReport> {
  const root = canonicalRoot(workspaceRoot),
    collector = collectDiff(root, options),
    deadline = Date.now() + 10000;
  let step = collector.next();
  while (!step.done) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return finish(emptyDiff(root, 'error', 'Git inspection exceeded its aggregate deadline.'), options);
    const request = step.value;
    const result = await new Promise<GitResult>(resolveResult => {
      execFile(
        '/usr/bin/git',
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
  return finish(step.value, options);
}

export interface GitDiffOptions {
  base?: WorkspaceDiffBase;
  /** Host policy, including deny/ask/secret rules; called before and after collection. */
  canRead?: (path: string) => boolean;
  redact?: (text: string) => string;
  /** Earliest retained preimage per path, supplied only by the session checkpoint store. */
  sessionFiles?: readonly {path: string; before: string | null}[];
  sessionUnavailableReason?: string;
  sessionWholeWorkspace?: boolean;
  /** Only filenames, never content, may be projected for policy-ask paths. */
  metadataOnly?: (path: string) => boolean;
}
function canRead(root: string, path: string, options: GitDiffOptions): boolean {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return false;
  if (rel.split('/').some(part => ['.git', '.cosmew', '.futryn', '.hannes'].includes(part))) return false;
  if (options.canRead && !options.canRead(path)) return false;
  try {
    const real = realpathSync(absolute),
      target = relative(root, real);
    if (isAbsolute(target) || target === '..' || target.startsWith('../')) return false;
    if (options.canRead && !options.canRead(target)) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  return true;
}
function finish(report: WorkspaceDiffReport, options: GitDiffOptions): WorkspaceDiffReport {
  report.base ??= options.base ?? 'uncommitted';
  report.capabilities ??= Object.fromEntries(
    ['session', 'uncommitted', 'branch'].map(base => [
      base,
      {available: false, reason: report.message ?? 'Git unavailable.'},
    ]),
  ) as WorkspaceDiffReport['capabilities'];
  const clean = (text: string) => (options.redact?.(text) ?? text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  report.workspace = clean(report.workspace);
  if (report.branch) report.branch = clean(report.branch);
  report.files = report.files.map(file => ({
    ...file,
    path: clean(displayPath(file.path)),
    ...(file.oldPath ? {oldPath: clean(displayPath(file.oldPath))} : {}),
    lines: file.lines.map(line => ({...line, content: clean(line.content)})),
  }));
  return report;
}
function sessionDiff(root: string, options: GitDiffOptions, report: WorkspaceDiffReport): WorkspaceDiffReport {
  if (!options.sessionFiles || options.sessionUnavailableReason) {
    report.state = 'error';
    report.message = options.sessionUnavailableReason ?? 'Session baseline unavailable.';
    report.capabilities!.session = {available: false, reason: report.message};
    return report;
  }
  const originals = new Map(options.sessionFiles.map(file => [file.path, file]));
  if (options.sessionWholeWorkspace) {
    const inventory = workspaceDiffPaths(root, path => canRead(root, path, options));
    if (inventory.reason) return {...report, state: 'error', message: inventory.reason, files: []};
    for (const path of inventory.paths) if (!originals.has(path)) originals.set(path, {path, before: null});
  }
  let bytes = 0;
  for (const original of originals.values()) {
    const entry = {...original, path: relative(root, resolve(root, original.path))};
    if (!canRead(root, original.path, options) || !canRead(root, entry.path, options)) continue;
    if (report.files.length >= MAX_FILES || bytes >= MAX_REPORT_BYTES) {
      report.truncated = true;
      break;
    }
    let after: string | null;
    try {
      after = readCurrent(root, entry.path)?.toString('utf8') ?? null;
    } catch {
      report.truncated = true;
      continue;
    }
    if (!canRead(root, entry.path, options) || after === entry.before) continue;
    const file: WorkspaceDiffFile = {
      path: entry.path,
      status: entry.before === null ? 'added' : after === null ? 'deleted' : 'modified',
      additions: 0,
      deletions: 0,
      lines: [],
    };
    bytes += Buffer.byteLength(entry.before ?? '') + Buffer.byteLength(after ?? '');
    textDiff(file, entry.before, after);
    report.files.push(file);
  }
  report.totalAdditions = report.files.reduce((sum, f) => sum + f.additions, 0);
  report.totalDeletions = report.files.reduce((sum, f) => sum + f.deletions, 0);
  report.truncated ||= report.files.some(file => file.truncated);
  return report;
}

function canonicalRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function withoutGit(
  root: string,
  state: NonNullable<WorkspaceDiffReport['state']>,
  message: string,
  options: GitDiffOptions,
): WorkspaceDiffReport {
  const report = emptyDiff(root, state, message);
  if (options.base !== 'session') return report;
  report.base = 'session';
  report.capabilities = {
    session: {
      available: !!options.sessionFiles && !options.sessionUnavailableReason,
      reason: options.sessionUnavailableReason,
    },
    uncommitted: {available: false, reason: message},
    branch: {available: false, reason: message},
  };
  const result = sessionDiff(root, options, report);
  if (result.capabilities?.session.available) result.state = 'ready';
  return result;
}

/** Descriptor-relative reads reject symlinks at every component, hardlinks, FIFOs and stale data. */
function readCurrentSnapshot(root: string, path: string): {bytes: Buffer; mode: number} | null {
  try {
    const workspace = new WorkspaceRoot(root);
    if (workspace.root !== root) throw new Error('Workspace root changed.');
    return new SecureFiles(workspace).executionBytes(path, MAX_BYTES);
  } catch (error) {
    try {
      lstatSync(resolve(root, path));
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null;
    }
    throw error;
  }
}
function readCurrent(root: string, path: string): Buffer | null {
  return readCurrentSnapshot(root, path)?.bytes ?? null;
}
function textDiff(file: WorkspaceDiffFile, before: string | null, after: string | null): void {
  const oldText = before ?? '',
    current = after ?? '';
  if (oldText.includes('\0') || current.includes('\0')) {
    file.binary = true;
    return;
  }
  const lines = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : []);
  const old = lines(oldText),
    next = lines(current);
  let prefix = 0,
    suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  if (oldText.endsWith('\n') !== current.endsWith('\n') && prefix === old.length && prefix === next.length)
    prefix = Math.max(0, prefix - 1);
  while (
    oldText.endsWith('\n') === current.endsWith('\n') &&
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  for (let i = prefix; i < old.length - suffix && file.lines.length < MAX_LINES; i++) {
    file.deletions++;
    file.lines.push({type: 'del', oldLine: i + 1, newLine: null, content: old[i]!});
  }
  for (let i = prefix; i < next.length - suffix && file.lines.length < MAX_LINES; i++) {
    file.additions++;
    file.lines.push({type: 'add', oldLine: null, newLine: i + 1, content: next[i]!});
  }
  file.truncated = old.length + next.length - 2 * prefix - 2 * suffix > file.lines.length;
}
function* sealedDiff(
  root: string,
  options: GitDiffOptions,
  report: WorkspaceDiffReport,
  reference: string | undefined,
  request: (args: string[]) => Generator<GitRequest, GitResult, GitResult>,
): Generator<GitRequest, WorkspaceDiffReport, GitResult> {
  const tree = reference
    ? yield* request(['ls-tree', '-r', '-z', reference, '--', '.'])
    : {status: 0, stdout: '', stderr: ''};
  const index = yield* request(['ls-files', '--cached', '-z', '--', '.']);
  const untracked = yield* request(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
  if ([tree, index, untracked].some(result => result.error || result.status !== 0))
    return emptyDiff(root, 'error', 'Git metadata listing failed or exceeded its bound.');
  const blobs = new Map<string, string>();
  const modes = new Map<string, number>();
  for (const item of tree.stdout.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]*)$/.exec(item);
    if (match) {
      blobs.set(match[3]!, match[2]!);
      modes.set(match[3]!, match[1] === '100755' ? 0o755 : 0o644);
    }
  }
  const others = new Set(untracked.stdout.split('\0').filter(Boolean));
  const paths = new Set([...blobs.keys(), ...index.stdout.split('\0').filter(Boolean), ...others]);
  let inspectedBytes = 0,
    displayedBytes = 0,
    inspectedFiles = 0;
  for (const path of paths) {
    if (
      ++inspectedFiles > 20000 ||
      inspectedBytes >= 64 * MAX_BYTES ||
      report.files.length >= MAX_FILES ||
      displayedBytes >= MAX_REPORT_BYTES
    ) {
      report.truncated = true;
      break;
    }
    if (!canRead(root, path, options)) {
      if (options.metadataOnly?.(path))
        report.files.push({
          path: displayPath(path),
          status: blobs.has(path) ? 'modified' : others.has(path) ? 'untracked' : 'added',
          additions: 0,
          deletions: 0,
          lines: [],
        });
      continue;
    }
    let current: Buffer | null;
    let currentMode: number | undefined;
    try {
      const snapshot = readCurrentSnapshot(root, path);
      current = snapshot?.bytes ?? null;
      currentMode = snapshot?.mode;
    } catch {
      report.truncated = true;
      continue;
    }
    if (!canRead(root, path, options)) continue;
    inspectedBytes += current?.length ?? 0;
    const oid = blobs.get(path);
    if (
      current &&
      oid &&
      modes.get(path) === currentMode &&
      createHash(oid.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${current.length}\0`)
        .update(current)
        .digest('hex') === oid
    )
      continue;
    if (!current && !oid) continue;
    let before: string | null = null;
    if (oid) {
      const blob = yield* request(['cat-file', 'blob', oid]);
      if (blob.error || blob.status !== 0) {
        report.truncated = true;
        continue;
      }
      before = blob.stdout;
    }
    if (!canRead(root, path, options)) continue;
    const after = current?.toString('utf8') ?? null;
    const file: WorkspaceDiffFile = {
      path: displayPath(path),
      status: !oid ? (others.has(path) ? 'untracked' : 'added') : current === null ? 'deleted' : 'modified',
      additions: 0,
      deletions: 0,
      lines: [],
      ...(others.has(path) ? {layer: 'untracked' as const} : {}),
    };
    textDiff(file, before, after);
    if (oid && current && currentMode !== modes.get(path))
      file.lines.push(
        {
          type: 'hunk',
          oldLine: null,
          newLine: null,
          content: `old mode ${modes.get(path) === 0o755 ? '100755' : '100644'}`,
        },
        {
          type: 'hunk',
          oldLine: null,
          newLine: null,
          content: `new mode ${currentMode === 0o755 ? '100755' : '100644'}`,
        },
      );
    displayedBytes += Buffer.byteLength(before ?? '') + (current?.length ?? 0);
    report.files.push(file);
  }
  report.totalAdditions = report.files.reduce((n, f) => n + f.additions, 0);
  report.totalDeletions = report.files.reduce((n, f) => n + f.deletions, 0);
  report.truncated ||= report.files.some(file => file.truncated);
  return report;
}
