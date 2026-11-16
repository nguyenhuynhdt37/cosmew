import { z } from 'zod';
import { looksBinary, type ResolvedPath, type WorkspaceRoot } from '@futryn/workspace';
import { LIMITS, clipBytes } from '../limits';

export const readInput = z.strictObject({
  path: z.string().min(1).max(1024),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(LIMITS.readLines).optional(),
});

export const readDescriptor = {
  name: 'read',
  description: 'Read a UTF-8 text file in the workspace. Returns numbered lines. Use offset/limit to page through long files (at most 2000 lines or 50 KiB per call).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
      limit: { type: 'integer', minimum: 1, maximum: LIMITS.readLines, description: 'Maximum number of lines.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  capability: 'fs.read' as const,
};

export type ReadOutcome = { ok: true; content: string; truncated: boolean } | { ok: false; code: 'IS_DIRECTORY' | 'BINARY_FILE' | 'FILE_TOO_LARGE' };

export function runRead(workspace: WorkspaceRoot, file: ResolvedPath, input: z.infer<typeof readInput>): ReadOutcome {
  if (file.kind === 'directory') return { ok: false, code: 'IS_DIRECTORY' };
  const { bytes, size } = workspace.readBytes(file, LIMITS.readFileBytes);
  if (size > LIMITS.readFileBytes) return { ok: false, code: 'FILE_TOO_LARGE' };
  if (looksBinary(bytes)) return { ok: false, code: 'BINARY_FILE' };
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const start = (input.offset ?? 1) - 1;
  const limit = input.limit ?? LIMITS.readLines;
  const width = String(Math.min(lines.length, start + limit)).length;
  const shown = lines.slice(start, start + limit).map((line, i) => {
    const text = line.length > LIMITS.lineChars ? line.slice(0, LIMITS.lineChars) + '… [line truncated]' : line;
    return `${String(start + i + 1).padStart(width)}\t${text}`;
  });
  const clipped = clipBytes(shown.join('\n'), LIMITS.readOutputBytes);
  const nextLine = start + clipped.text.split('\n').length + 1;
  const more = clipped.clipped || start + limit < lines.length;
  const footer = more ? `\n\n[${lines.length} lines total; continue with offset ${nextLine}]` : '';
  if (start >= lines.length) return { ok: true, content: `[file has ${lines.length} lines; offset ${start + 1} is past the end]`, truncated: false };
  return { ok: true, content: clipped.text + footer, truncated: more };
}
