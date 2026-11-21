import {lstatSync, readdirSync} from 'node:fs';
import {isAbsolute, join, relative, sep} from 'node:path';
import {z} from 'zod';
import {readDecision, type ToolDispatcherOptions} from '../context';
import {listWorkspaceFiles, type ResolvedPath, type WorkspaceRoot} from '@cosmew/workspace';
import {LIMITS, clipBytes} from '../limits';
import type {FileHits, GrepQuery} from './ripgrep';

export const globInput = z.strictObject({
  pattern: z.string().min(1).max(LIMITS.patternChars).optional(),
  path: z.string().min(1).max(1024).optional(),
});

export const globDescriptor = {
  name: 'glob',
  description:
    'List workspace files matching a glob pattern such as "**/*.ts" (default "**/*"), most recently modified first. Skips .git and files ignored by .gitignore. At most 100 paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {type: 'string', description: 'Glob pattern relative to path, e.g. "src/**/*.ts".'},
      path: {
        type: 'string',
        description:
          'Directory to search, relative to the workspace or an absolute path inside permissions.additionalDirectories (default ".").',
      },
    },
    additionalProperties: false,
  },
  capability: 'fs.read' as const,
  parallel: true,
};

export const grepInput = z.strictObject({
  pattern: z.string().min(1).max(LIMITS.patternChars),
  path: z.string().min(1).max(1024).optional(),
  glob: z.string().min(1).max(LIMITS.patternChars).optional(),
  type: z
    .string()
    .regex(/^[A-Za-z0-9_+-]{1,40}$/)
    .optional(),
  ignoreCase: z.boolean().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  context: z.number().int().min(0).max(LIMITS.grepContext).optional(),
  before: z.number().int().min(0).max(LIMITS.grepContext).optional(),
  after: z.number().int().min(0).max(LIMITS.grepContext).optional(),
  multiline: z.boolean().optional(),
  head_limit: z.number().int().min(1).max(LIMITS.grepEntries).optional(),
  offset: z.number().int().min(0).optional(),
});

export const grepDescriptor = {
  name: 'grep',
  description:
    'Search file contents with ripgrep (Rust regex syntax; escape literal braces/parentheses). Respects .gitignore and skips binary, secret-looking and protected files (read those explicitly). output_mode: "content" (default) prints matching lines as path:line:text with context lines as path-line-text; "files_with_matches" lists matching files; "count" prints path:count. Use glob ("**/*.ts") or type ("ts", "py", "rust") to narrow, context/before/after for surrounding lines, multiline for patterns spanning lines, and head_limit/offset to page through long results (default 100 entries).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {type: 'string', description: 'Regular expression to search for.'},
      path: {
        type: 'string',
        description:
          'Directory to search, relative to the workspace or an absolute path inside permissions.additionalDirectories (default ".").',
      },
      glob: {type: 'string', description: 'Only search files matching this glob, e.g. "**/*.ts" or "*.{ts,tsx}".'},
      type: {type: 'string', description: 'ripgrep file type, e.g. "ts", "js", "py", "rust", "go".'},
      ignoreCase: {type: 'boolean', description: 'Case-insensitive match.'},
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'What to return (default "content").',
      },
      context: {
        type: 'integer',
        minimum: 0,
        maximum: LIMITS.grepContext,
        description: 'Lines before and after each match.',
      },
      before: {type: 'integer', minimum: 0, maximum: LIMITS.grepContext, description: 'Lines before each match.'},
      after: {type: 'integer', minimum: 0, maximum: LIMITS.grepContext, description: 'Lines after each match.'},
      multiline: {type: 'boolean', description: 'Let the pattern span lines ("." also matches newlines).'},
      head_limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIMITS.grepEntries,
        description: 'Maximum lines/files/counts to return (default 100).',
      },
      offset: {type: 'integer', minimum: 0, description: 'Skip this many entries first (to page).'},
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  capability: 'fs.read' as const,
  parallel: true,
};

/** The grep input as a backend query. */
export function grepQuery(input: z.infer<typeof grepInput>): GrepQuery {
  return {
    pattern: input.pattern,
    glob: input.glob,
    type: input.type,
    ignoreCase: input.ignoreCase,
    multiline: input.multiline,
    mode: input.output_mode ?? 'content',
    before: input.before ?? input.context ?? 0,
    after: input.after ?? input.context ?? 0,
  };
}

/** Render backend hits as model text, paged by head_limit/offset and bounded in bytes. */
export function formatGrep(
  hits: FileHits[],
  input: z.infer<typeof grepInput>,
  base: string,
  notes: string[],
): {status: 'ok'; content: string; target: string; truncated?: true} {
  const mode = input.output_mode ?? 'content';
  const entries: string[] = [];
  if (mode === 'files_with_matches') for (const hit of hits) entries.push(hit.path);
  else if (mode === 'count') for (const hit of hits) entries.push(`${hit.path}:${hit.count}`);
  else
    for (const hit of hits) {
      let previous = -1;
      for (const line of hit.lines) {
        if (entries.length && previous !== -1 && line.line > previous + 1) entries.push('--');
        else if (entries.length && previous === -1) entries.push('--');
        const text =
          line.text.length > LIMITS.lineChars ? line.text.slice(0, LIMITS.lineChars) + '… [line truncated]' : line.text;
        entries.push(`${hit.path}${line.match ? ':' : '-'}${line.line}${line.match ? ':' : '-'}${text}`);
        previous = line.line;
      }
    }
  const offset = input.offset ?? 0;
  const limit = input.head_limit ?? LIMITS.results;
  const page = entries.slice(offset, offset + limit);
  const clipped = clipBytes(page.join('\n'), LIMITS.readOutputBytes);
  const shown = clipped.clipped ? clipped.text.split('\n').length - 1 : page.length;
  const more = offset + shown < entries.length;
  const all = [
    ...(more
      ? [`showing entries ${offset + 1}-${offset + shown} of ${entries.length}; continue with offset ${offset + shown}`]
      : []),
    ...notes,
  ];
  const body = !entries.length
    ? mode === 'files_with_matches'
      ? 'No files matched.'
      : 'No matches.'
    : !page.length
      ? `[offset ${offset} is past the ${entries.length} entries]`
      : clipped.clipped
        ? clipped.text.slice(0, clipped.text.lastIndexOf('\n'))
        : clipped.text;
  return {
    status: 'ok',
    content: body + (all.length ? `\n\n[${all.join('; ')}]` : ''),
    target: base,
    ...(more || notes.some(n => n.includes('cut short')) ? {truncated: true as const} : {}),
  };
}

/** Files under a granted directory. Skips `.git` and does not follow symlinks. Paths are absolute. */
function listGrantedFiles(root: string, deadline: number): {files: string[]; incomplete: boolean} {
  const files: string[] = [];
  let incomplete = false;
  const walk = (dir: string) => {
    if (Date.now() > deadline || files.length >= 50000) {
      incomplete = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute.split(sep).join('/'));
      if (incomplete) return;
    }
  };
  walk(root);
  return {files, incomplete};
}

/** Files under `base` (a resolved directory or file) that match `pattern`. Project paths stay relative; granted paths are absolute. */
export function candidateFiles(
  workspace: WorkspaceRoot,
  base: ResolvedPath,
  pattern: string | undefined,
  deadline: number,
): {files: string[]; incomplete: boolean} {
  const gitInternal = (path: string) => path === '.git' || path.startsWith('.git/') || path.split('/').includes('.git');
  // A single file is its own candidate list (the glob is relative to a directory and does not apply).
  if (base.kind === 'file') return {files: gitInternal(base.relative) ? [] : [base.relative], incomplete: false};
  if (base.root !== workspace.root) {
    const listing = listGrantedFiles(base.absolute, deadline);
    const glob = pattern ? new Bun.Glob(pattern) : null;
    const files = listing.files.filter(absolute => {
      const rel = relative(base.absolute, absolute).split(sep).join('/');
      return !gitInternal(rel) && (!glob || glob.match(rel));
    });
    return {files, incomplete: listing.incomplete};
  }
  const listing = listWorkspaceFiles(workspace, {deadline});
  const prefix = base.relative === '.' ? '' : base.relative + '/';
  const glob = pattern ? new Bun.Glob(pattern) : null;
  const files = listing.files.filter(
    path => path.startsWith(prefix) && !gitInternal(path) && (!glob || glob.match(path.slice(prefix.length))),
  );
  return {files, incomplete: listing.incomplete};
}

export function runGlob(
  workspace: WorkspaceRoot,
  base: ResolvedPath,
  input: z.infer<typeof globInput>,
  stateDirectory?: string,
  readPolicy?: ToolDispatcherOptions['readPolicy'],
): {content: string; truncated: boolean} {
  const {files, incomplete} = candidateFiles(workspace, base, input.pattern ?? '**/*', Date.now() + LIMITS.deadlineMs);
  const visible = newestFirst(
    workspace.root,
    files.filter(path => {
      const absolute = isAbsolute(path) ? path : join(workspace.root, path);
      return readDecision({stateDirectory, readPolicy}, path, absolute).effect !== 'deny';
    }),
  );
  const shown = visible.slice(0, LIMITS.results);
  const truncated = visible.length > shown.length || incomplete;
  if (!shown.length) return {content: 'No files matched.', truncated: false};
  return {
    content:
      shown.join('\n') +
      (truncated
        ? `\n\n[showing ${shown.length} of ${visible.length}${incomplete ? '+' : ''} files; narrow the pattern or path]`
        : ''),
    truncated,
  };
}

/** Most recently modified first (Claude Code Glob), so files being worked on surface early; ties by path. */
function newestFirst(root: string, paths: string[]): string[] {
  const modified = new Map<string, number>();
  for (const path of paths) {
    try {
      modified.set(path, lstatSync(join(root, path)).mtimeMs);
    } catch {
      modified.set(path, 0);
    }
  }
  return [...paths].sort((a, b) => modified.get(b)! - modified.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
}

/** Validate a user/model regex before it reaches the search worker. */
export function compilePattern(pattern: string, ignoreCase?: boolean): RegExp | null {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    return null;
  }
}
