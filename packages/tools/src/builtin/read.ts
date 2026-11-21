import {readdirSync} from 'node:fs';
import {basename, dirname, extname, join} from 'node:path';
import {z} from 'zod';
import type {Attachment} from '@cosmew/contracts';
import {readDecision, type ToolDispatcherOptions} from '../context';
import {WorkspaceDenied, looksBinary, type ResolvedPath, type WorkspaceRoot} from '@cosmew/workspace';
import {LIMITS, clipBytes} from '../limits';
import {
  MAX_ATTACHMENT_BYTES,
  MEDIA_SNIFF_BYTES,
  containsRegisteredSecret,
  mediaSummary,
  sniffMedia,
  validMedia,
} from './read-media';
import {renderNotebook} from './read-notebook';

export const readInput = z.strictObject({
  path: z.string().min(1).max(1024),
  /** 1-based first line/entry; negative reads the last N lines (OpenCode). */
  offset: z
    .number()
    .int()
    .refine(n => n !== 0)
    .optional(),
  limit: z.number().int().min(1).max(LIMITS.readLines).optional(),
});

export const readDescriptor = {
  name: 'read',
  description:
    'Read a file or directory in the workspace. Text files return numbered lines (at most 2000 lines or 50 KiB per call; use offset/limit to page, a negative offset reads the last N lines). A directory returns its entries one per line, directories ending in "/", paged with offset/limit. Images (PNG, JPEG, GIF, WebP) and PDFs up to 20 MiB are attached for the model to view. Jupyter notebooks (.ipynb) return every cell with its outputs. Prefer one larger read over many small slices; use grep to find specific content first.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File or directory path relative to the workspace, or an absolute path inside permissions.additionalDirectories.',
      },
      offset: {
        type: 'integer',
        description: 'First line or entry to return (1-based). A negative value returns the last N lines.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIMITS.readLines,
        description: 'Maximum number of lines or entries.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  capability: 'fs.read' as const,
  parallel: true,
};

export type ReadOutcome =
  | {ok: true; content: string; truncated: boolean; bytes?: Uint8Array; attachments?: Attachment[]}
  | {ok: false; code: 'BINARY_FILE' | 'FILE_TOO_LARGE' | 'INVALID_INPUT' | 'SECRET_IN_MEDIA'; message?: string};

export function runRead(
  workspace: WorkspaceRoot,
  file: ResolvedPath,
  input: z.infer<typeof readInput>,
  stateDirectory?: string,
  redact: (text: string) => string = text => text,
  readPolicy?: ToolDispatcherOptions['readPolicy'],
): ReadOutcome {
  if (file.kind === 'directory') return listDirectory(workspace, file, input, stateDirectory, readPolicy);
  const head = workspace.readBytes(file, MEDIA_SNIFF_BYTES);
  const media = sniffMedia(head.bytes);
  if (media) {
    if (head.size > MAX_ATTACHMENT_BYTES)
      return {ok: false, code: 'FILE_TOO_LARGE', message: `${file.relative} is larger than 20 MiB and was not read.`};
    const {bytes} = workspace.readBytes(file, MAX_ATTACHMENT_BYTES);
    // The file may have changed between the two reads; the attachment is what was actually read.
    // A file that only starts like media is binary; media holding a registered secret is refused.
    if (sniffMedia(bytes) !== media || !validMedia(bytes, media)) return {ok: false, code: 'BINARY_FILE'};
    if (containsRegisteredSecret(bytes, redact))
      return {
        ok: false,
        code: 'SECRET_IN_MEDIA',
        message: `${file.relative} contains a registered secret and was not attached.`,
      };
    return {
      ok: true,
      content: mediaSummary(file.relative, media, bytes.byteLength),
      truncated: false,
      attachments: [
        {mime: media, data: Buffer.from(bytes).toString('base64'), name: redact(basename(file.relative)).slice(0, 256)},
      ],
    };
  }
  const {bytes, size} = workspace.readBytes(file, LIMITS.readFileBytes);
  if (size > LIMITS.readFileBytes) return {ok: false, code: 'FILE_TOO_LARGE'};
  if (looksBinary(bytes)) return {ok: false, code: 'BINARY_FILE'};
  const decoded = new TextDecoder().decode(bytes);
  if (extname(file.relative).toLowerCase() === '.ipynb') {
    const notebook = renderNotebook(decoded, file.relative, (data, mime) => {
      const raw = Buffer.from(data, 'base64');
      return validMedia(raw, mime) && !containsRegisteredSecret(raw, redact);
    });
    if (notebook.ok) {
      const page = pageLines(notebook.text, input);
      return {...page, bytes, ...(notebook.attachments.length ? {attachments: notebook.attachments} : {})};
    }
  }
  return {...pageLines(decoded, input), bytes};
}

function pageLines(text: string, input: z.infer<typeof readInput>): {ok: true; content: string; truncated: boolean} {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const limit = input.limit ?? LIMITS.readLines;
  // Negative offset: the last N lines (OpenCode); N also caps the page.
  const start =
    input.offset !== undefined && input.offset < 0 ? Math.max(0, lines.length + input.offset) : (input.offset ?? 1) - 1;
  const count = input.offset !== undefined && input.offset < 0 ? Math.min(limit, -input.offset) : limit;
  if (start >= lines.length)
    return {
      ok: true,
      content: `[file has ${lines.length} lines; offset ${start + 1} is past the end]`,
      truncated: false,
    };
  const width = String(Math.min(lines.length, start + count)).length;
  const shown = lines.slice(start, start + count).map((line, i) => {
    const text = line.length > LIMITS.lineChars ? line.slice(0, LIMITS.lineChars) + '… [line truncated]' : line;
    return `${String(start + i + 1).padStart(width)}\t${text}`;
  });
  const clipped = clipBytes(shown.join('\n'), LIMITS.readOutputBytes);
  const nextLine = start + clipped.text.split('\n').length + 1;
  const more = clipped.clipped || start + count < lines.length;
  const footer = more ? `\n\n[${lines.length} lines total; continue with offset ${nextLine}]` : '';
  return {ok: true, content: clipped.text + footer, truncated: more};
}

/**
 * Directory listing (OpenCode `read` list page): directories first, then files, each sorted; `/`
 * marks directories. Entries policy denies (`.git`, Cosmew state) or symlinks pointing there or
 * outside the workspace are omitted.
 */
function listDirectory(
  workspace: WorkspaceRoot,
  file: ResolvedPath,
  input: z.infer<typeof readInput>,
  stateDirectory?: string,
  readPolicy?: ToolDispatcherOptions['readPolicy'],
): ReadOutcome {
  if (input.offset !== undefined && input.offset < 0)
    return {ok: false, code: 'INVALID_INPUT', message: 'A negative offset only works for files.'};
  let entries: {name: string; directory: boolean}[];
  try {
    entries = readdirSync(file.absolute, {withFileTypes: true}).flatMap(entry => {
      const relative = file.relative === '.' ? entry.name : `${file.relative}/${entry.name}`;
      let directory = entry.isDirectory();
      let targetRelative = relative;
      let targetAbsolute = join(file.absolute, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = workspace.resolve(relative, file.root === workspace.root ? [] : [file.root]);
          directory = resolved.kind === 'directory';
          targetRelative = resolved.relative;
          targetAbsolute = resolved.absolute;
        } catch {
          return [];
        }
      } else if (!directory && !entry.isFile()) return [];
      const suffix = directory ? '/' : '';
      const entryDecision = readDecision({stateDirectory, readPolicy}, relative + suffix, targetAbsolute);
      if (entryDecision.effect === 'deny') return [];
      if (targetRelative !== relative) {
        const targetDecision = readDecision({stateDirectory, readPolicy}, targetRelative + suffix, targetAbsolute);
        if (targetDecision.effect === 'deny') return [];
      }
      return [{name: entry.name, directory}];
    });
  } catch {
    throw new WorkspaceDenied('inaccessible');
  }
  entries.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1));
  const offset = input.offset ?? 1;
  const limit = input.limit ?? LIMITS.readLines;
  const selected = entries.slice(offset - 1, offset - 1 + limit).map(e => e.name + (e.directory ? '/' : ''));
  const header = selected.length
    ? `Directory ${file.relative}: entries ${offset}-${offset + selected.length - 1} of ${entries.length}`
    : `Directory ${file.relative}: ${entries.length} entries`;
  const clipped = clipBytes([header, ...selected].join('\n'), LIMITS.readOutputBytes);
  const shown = clipped.text.split('\n').length - 1;
  const more = clipped.clipped || offset - 1 + selected.length < entries.length;
  return {
    ok: true,
    content: clipped.text + (more ? `\n\n[continue with offset ${offset + shown}]` : ''),
    truncated: more,
  };
}

const stem = (name: string) => name.slice(0, name.length - extname(name).length) || name;
function editDistance(a: string, b: string): number {
  let previous = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * One readable path the model probably meant (OpenCode `read` did-you-mean): the same name in
 * another case or extension, a small typo, or an absolute path written from the wrong root whose
 * tail exists in the workspace. Only a path whose read policy is plain allow is suggested, so a
 * suggestion never names Git internals, Cosmew state or a secret file.
 */
export function suggestReadPath(
  workspace: WorkspaceRoot,
  input: string,
  stateDirectory?: string,
  readPolicy?: ToolDispatcherOptions['readPolicy'],
): string | null {
  const allowed = (relative: string): string | null => {
    try {
      const resolved = workspace.resolve(relative);
      if (resolved.kind !== 'file') return null;
      return readDecision({stateDirectory, readPolicy}, resolved.relative, resolved.absolute).effect === 'allow'
        ? resolved.relative
        : null;
    } catch {
      return null;
    }
  };
  const normalized = input.replace(/\\/g, '/');
  if (normalized.startsWith('/') && !(normalized + '/').startsWith(workspace.root + '/')) {
    const parts = normalized.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const found = allowed(parts.slice(i).join('/'));
      if (found) return found;
    }
    return null;
  }
  let parent: ResolvedPath;
  try {
    parent = workspace.resolve(dirname(normalized) || '.');
  } catch {
    return null;
  }
  if (parent.kind !== 'directory') return null;
  const wanted = basename(normalized).normalize('NFC').toLowerCase();
  let names: string[];
  try {
    names = readdirSync(parent.absolute);
  } catch {
    return null;
  }
  const tier = (candidate: string): number | undefined => {
    const name = candidate.normalize('NFC').toLowerCase();
    if (name === wanted) return 1;
    if (stem(name) === stem(wanted)) return 2;
    const typos = stem(wanted).length < 5 ? 1 : 2;
    if (stem(wanted).length >= 3 && editDistance(stem(name), stem(wanted)) <= typos) return 3;
    return undefined;
  };
  const ranked = names
    .filter(name => name !== basename(normalized))
    .flatMap(name => {
      const rank = tier(name);
      return rank === undefined ? [] : [{name, rank}];
    })
    .sort((a, b) => a.rank - b.rank);
  const best = ranked[0];
  // Exactly one candidate at the best rank, or no suggestion at all.
  if (!best || ranked.filter(r => r.rank === best.rank).length !== 1) return null;
  return allowed(parent.relative === '.' ? best.name : `${parent.relative}/${best.name}`);
}
