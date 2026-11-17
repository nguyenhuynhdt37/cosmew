import {isAbsolute, relative} from 'node:path';
import {readDecision, type ToolDispatcherOptions} from '../context';
import type {ResolvedPath, WorkspaceRoot} from '@futryn/workspace';
import {FutrynError} from '@futryn/contracts';
import {LIMITS} from '../limits';

/**
 * ripgrep backend for the grep tool (ADR 0038). rg only lists matches; Futryn still decides what
 * the model sees: every reported path is re-resolved inside the workspace and judged by the read
 * policy, so secret, Git and Futryn-state files never reach the model and symlink escapes are
 * dropped. rg runs without a config file, without following symlinks and with an empty environment.
 */

export type GrepMode = 'content' | 'files_with_matches' | 'count';

export interface GrepQuery {
  pattern: string;
  glob?: string;
  type?: string;
  ignoreCase?: boolean;
  multiline?: boolean;
  mode: GrepMode;
  before: number;
  after: number;
}

/** One file's results in rg order: match and context lines, or a match count. */
export interface FileHits {
  path: string;
  lines: {line: number; text: string; match: boolean}[];
  count: number;
}

/** Bytes of rg output read before stopping it; results beyond are reported as cut short. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * A usable rg executable: absolute and outside the workspace, so a repository cannot plant its own
 * `rg` through a relative or project-local PATH entry. `null` means use the built-in search.
 */
export function locateRipgrep(workspaceRoot: string, candidate = Bun.which('rg')): string | null {
  if (!candidate || !isAbsolute(candidate)) return null;
  const inside = relative(workspaceRoot, candidate);
  if (!inside.startsWith('..') && !isAbsolute(inside)) return null;
  return candidate;
}

function argsFor(query: GrepQuery, base: ResolvedPath): string[] {
  const args = ['--no-config', '--hidden', '--glob', '!.git', '--max-filesize', '1M', '--color', 'never'];
  args.push('--no-messages');
  if (query.ignoreCase) args.push('--ignore-case');
  if (query.multiline) args.push('--multiline', '--multiline-dotall');
  // A --glob include overrides .gitignore in rg, so the user's glob is applied in visibleHits.
  if (query.type) args.push('--type', query.type);
  if (query.mode === 'files_with_matches') args.push('--files-with-matches', '--null');
  else if (query.mode === 'count') args.push('--count-matches', '--null', '--with-filename');
  else {
    args.push('--json');
    if (query.before) args.push('--before-context', String(query.before));
    if (query.after) args.push('--after-context', String(query.after));
  }
  args.push('--regexp', query.pattern);
  if (base.relative !== '.') args.push('--', base.relative);
  return args;
}

/** Collect rg stdout up to the byte budget; stops rg on deadline, cancellation or overflow. */
async function runRg(
  rg: string,
  args: string[],
  cwd: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<{stdout: string; stderr: string; exitCode: number; cut: boolean}> {
  const child = Bun.spawn([rg, ...args], {cwd, env: {}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  let timedOut = false;
  const kill = () => child.kill('SIGKILL');
  const timer = setTimeout(
    () => {
      timedOut = true;
      kill();
    },
    Math.max(1, deadline - Date.now()),
  );
  signal?.addEventListener('abort', kill, {once: true});
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  try {
    for await (const chunk of child.stdout) {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= MAX_OUTPUT_BYTES) {
        cut = true;
        kill();
        break;
      }
    }
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    if (timedOut) throw new FutrynError('TIMEOUT');
    const stdout = new TextDecoder().decode(Buffer.concat(chunks));
    // A cut stream may end in the middle of a record; drop the incomplete tail.
    return {stdout: cut ? stdout.slice(0, stdout.lastIndexOf('\n') + 1) : stdout, stderr, exitCode, cut};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
}

type RgJson =
  | {type: 'match' | 'context'; data: {path: {text?: string}; lines: {text?: string}; line_number: number | null}}
  | {type: 'begin' | 'end' | 'summary'; data: unknown};

function parseHits(stdout: string, mode: GrepMode): FileHits[] {
  const files = new Map<string, FileHits>();
  const entry = (path: string) => {
    let hits = files.get(path);
    if (!hits) files.set(path, (hits = {path, lines: [], count: 0}));
    return hits;
  };
  if (mode === 'files_with_matches') {
    for (const path of stdout.split('\0')) if (path.trim()) entry(path.replace(/^\n/, '')).count = 1;
  } else if (mode === 'count') {
    for (const record of stdout.split('\n')) {
      const at = record.indexOf('\0');
      if (at > 0) entry(record.slice(0, at)).count = Number(record.slice(at + 1)) || 0;
    }
  } else {
    for (const record of stdout.split('\n')) {
      if (!record) continue;
      let event: RgJson;
      try {
        event = JSON.parse(record);
      } catch {
        continue;
      }
      if (event.type !== 'match' && event.type !== 'context') continue;
      // Non-UTF-8 paths or lines arrive as base64 `bytes`; they are skipped, never decoded loosely.
      const {path, lines, line_number: first} = event.data;
      if (path.text === undefined || lines.text === undefined || first === null) continue;
      const hits = entry(path.text);
      const texts = lines.text.replace(/\r?\n$/, '').split(/\r?\n/);
      texts.forEach((text, i) => hits.lines.push({line: first + i, text, match: event.type === 'match'}));
      if (event.type === 'match') hits.count++;
    }
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Keep only files the read policy allows without approval; count the secret-looking ones skipped. */
export function visibleHits(
  workspace: WorkspaceRoot,
  hits: FileHits[],
  stateDirectory: string | undefined,
  filter?: {glob: string; base: string},
  readPolicy?: ToolDispatcherOptions['readPolicy'],
): {files: FileHits[]; skippedSecret: number} {
  const files: FileHits[] = [];
  const glob = filter ? new Bun.Glob(filter.glob) : null;
  const prefix = !filter || filter.base === '.' ? '' : filter.base + '/';
  let skippedSecret = 0;
  for (const hit of hits) {
    // Same meaning as the built-in search: the glob is relative to the searched directory.
    if (glob && !(hit.path.startsWith(prefix) && glob.match(hit.path.slice(prefix.length)))) continue;
    let file: ResolvedPath;
    try {
      file = workspace.resolve(hit.path);
    } catch {
      continue;
    }
    if (file.kind !== 'file') continue;
    const decision = readDecision({stateDirectory, readPolicy}, file.relative, file.absolute);
    if (decision.effect === 'ask') skippedSecret++;
    if (decision.effect !== 'allow') continue;
    files.push({...hit, path: file.relative});
  }
  return {files, skippedSecret};
}

export async function ripgrepSearch(options: {
  rg: string;
  workspace: WorkspaceRoot;
  base: ResolvedPath;
  query: GrepQuery;
  stateDirectory?: string;
  readPolicy?: ToolDispatcherOptions['readPolicy'];
  deadline: number;
  signal?: AbortSignal;
}): Promise<{files: FileHits[]; skippedSecret: number; cut: boolean} | {error: string}> {
  const {stdout, stderr, exitCode, cut} = await runRg(
    options.rg,
    argsFor(options.query, options.base),
    options.workspace.root,
    options.deadline,
    options.signal,
  );
  // 0 = matches, 1 = none, 2 = error (with --no-messages only fatal ones such as a bad pattern).
  if (exitCode === 2 && !stdout.trim() && !cut)
    return {error: (stderr.trim().split('\n').slice(0, 6).join('\n') || 'ripgrep failed').slice(0, LIMITS.lineChars)};
  const {files, skippedSecret} = visibleHits(
    options.workspace,
    parseHits(stdout, options.query.mode),
    options.stateDirectory,
    options.query.glob && options.base.kind !== 'file'
      ? {glob: options.query.glob, base: options.base.relative}
      : undefined,
    options.readPolicy,
  );
  return {files, skippedSecret, cut};
}
