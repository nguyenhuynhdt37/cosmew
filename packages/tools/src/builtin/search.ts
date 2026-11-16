import {z} from 'zod';
import {evaluateRead} from '@futryn/security';
import {listWorkspaceFiles, type ResolvedPath, type WorkspaceRoot} from '@futryn/workspace';
import {LIMITS} from '../limits';

export const globInput = z.strictObject({
  pattern: z.string().min(1).max(LIMITS.patternChars).optional(),
  path: z.string().min(1).max(1024).optional(),
});

export const globDescriptor = {
  name: 'glob',
  description:
    'List workspace files matching a glob pattern such as "**/*.ts" (default "**/*"). Skips .git and files ignored by .gitignore. At most 100 paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {type: 'string', description: 'Glob pattern relative to path, e.g. "src/**/*.ts".'},
      path: {type: 'string', description: 'Directory to search in, relative to the workspace root (default ".").'},
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
  ignoreCase: z.boolean().optional(),
});

export const grepDescriptor = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. Returns "path:line: text" for up to 100 matching lines. Skips binary, ignored and secret-looking files (read those explicitly).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {type: 'string', description: 'Regular expression to search for.'},
      path: {type: 'string', description: 'Directory to search in, relative to the workspace root (default ".").'},
      glob: {type: 'string', description: 'Only search files matching this glob, e.g. "**/*.ts".'},
      ignoreCase: {type: 'boolean', description: 'Case-insensitive match.'},
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  capability: 'fs.read' as const,
  parallel: true,
};

/** Files under `base` (a resolved directory) that match `pattern`, as workspace-relative paths. */
export function candidateFiles(
  workspace: WorkspaceRoot,
  base: ResolvedPath,
  pattern: string | undefined,
  deadline: number,
): {files: string[]; incomplete: boolean} {
  const listing = listWorkspaceFiles(workspace, {deadline});
  const prefix = base.relative === '.' ? '' : base.relative + '/';
  const glob = pattern ? new Bun.Glob(pattern) : null;
  const files = listing.files.filter(
    path => path.startsWith(prefix) && (!glob || glob.match(path.slice(prefix.length))),
  );
  return {files, incomplete: listing.incomplete};
}

export function runGlob(
  workspace: WorkspaceRoot,
  base: ResolvedPath,
  input: z.infer<typeof globInput>,
  stateDirectory?: string,
): {content: string; truncated: boolean} {
  const {files, incomplete} = candidateFiles(workspace, base, input.pattern ?? '**/*', Date.now() + LIMITS.deadlineMs);
  const visible = files.filter(
    path => evaluateRead(path, `${workspace.root}/${path}`, {stateDirectory}).effect !== 'deny',
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

/** Validate a user/model regex before it reaches the search worker. */
export function compilePattern(pattern: string, ignoreCase?: boolean): RegExp | null {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    return null;
  }
}
