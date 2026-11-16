import {GENERATION_LIMITS} from '@futryn/contracts';
/** Codex patch grammar. Parsing never reads or writes the workspace. */
export interface Chunk {
  context?: string;
  old: string[];
  next: string[];
  keep: [number, number][];
  eof: boolean;
}
export type PatchOperation =
  | {kind: 'add'; path: string; content: string}
  | {kind: 'delete'; path: string}
  | {kind: 'update'; path: string; move?: string; chunks: Chunk[]};
export class PatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = () => new PatchError('INVALID_PATCH', 'Malformed or unsupported patch syntax.');
export function parsePatch(text: string): PatchOperation[] {
  if (Buffer.byteLength(text) > GENERATION_LIMITS.patchBytes || text.includes('\0')) throw invalid();
  let lines = text.trim().split(/\r?\n/);
  if (/^<<['"]?EOF['"]?$/.test(lines[0] ?? '') && lines.at(-1) === 'EOF') lines = lines.slice(1, -1);
  if (lines[0]?.trim() !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch') throw invalid();
  const operations: PatchOperation[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[i++]!);
    if (!header) throw invalid();
    const path = header[2]!;
    if (header[1] === 'Delete') {
      operations.push({kind: 'delete', path});
      continue;
    }
    if (header[1] === 'Add') {
      const body: string[] = [];
      while (i < lines.length - 1 && lines[i]!.startsWith('+')) body.push(lines[i++]!.slice(1));
      operations.push({kind: 'add', path, content: body.length ? body.join('\n') + '\n' : ''});
      continue;
    }
    let move: string | undefined;
    if (lines[i]?.startsWith('*** Move to: ')) move = lines[i++]!.slice(13);
    const chunks: Chunk[] = [];
    while (i < lines.length - 1 && !/^\*\*\* (Add|Delete|Update) File: /.test(lines[i]!)) {
      const chunk: Chunk = {old: [], next: [], keep: [], eof: false};
      if (lines[i] === '@@') i++;
      else if (lines[i]?.startsWith('@@ ')) chunk.context = lines[i++]!.slice(3);
      else if (chunks.length) throw invalid();
      let count = 0;
      while (i < lines.length - 1) {
        const line = lines[i]!;
        if (line === '*** End of File') {
          chunk.eof = true;
          i++;
          break;
        }
        if (line.startsWith('@@') || line.startsWith('*** ')) break;
        const sign = line[0],
          content = line.slice(1);
        if (sign === ' ' || line === '') {
          chunk.keep.push([chunk.old.length, chunk.next.length]);
          chunk.old.push(line === '' ? '' : content);
          chunk.next.push(line === '' ? '' : content);
        } else if (sign === '-') chunk.old.push(content);
        else if (sign === '+') chunk.next.push(content);
        else throw invalid();
        count++;
        i++;
      }
      if (!count) throw invalid();
      chunks.push(chunk);
      if (chunk.eof) break;
    }
    if (!chunks.length) throw invalid();
    operations.push({kind: 'update', path, move, chunks});
  }
  if (!operations.length || operations.length > 32) throw invalid();
  return operations;
}
const unicode = (s: string) =>
  s
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ');
function seek(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
  budget = {comparisons: 0, characters: 0},
): number {
  if (!pattern.length) return start;
  const from = eof ? Math.max(start, lines.length - pattern.length) : start;
  for (const normalize of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim(), unicode]) {
    for (let i = from; i <= lines.length - pattern.length; i++)
      if (
        pattern.every((line, j) => {
          budget.comparisons++;
          budget.characters += line.length + lines[i + j]!.length;
          if (budget.comparisons > 2000000 || budget.characters > 64 * 1024 * 1024)
            throw new PatchError('PATCH_TOO_COMPLEX', 'Patch matching exceeds the verification budget.');
          return normalize(line) === normalize(lines[i + j]!);
        })
      )
        return i;
  }
  return -1;
}
export function updateFile(content: string, chunks: Chunk[]): string {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = bom ? content.slice(1) : content;
  const original = [...source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]
    .filter(m => m[0] !== '')
    .map(m => ({text: m[1]!, eol: m[2]!}));
  const lines = original.map(l => l.text),
    eol = original.find(l => l.eol)?.eol ?? '\n';
  const budget = {comparisons: 0, characters: 0};
  const replacements: {at: number; count: number; lines: typeof original}[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const at = seek(lines, [chunk.context], cursor, false, budget);
      if (at < 0) throw new PatchError('PATCH_MISMATCH', 'Patch context was not found.');
      cursor = at + 1;
    }
    let old = chunk.old,
      next = chunk.next,
      at = old.length ? seek(lines, old, cursor, chunk.eof, budget) : lines.length;
    if (at < 0 && old.at(-1) === '') {
      old = old.slice(0, -1);
      if (next.at(-1) === '') next = next.slice(0, -1);
      at = seek(lines, old, cursor, chunk.eof, budget);
    }
    if (at < 0) throw new PatchError('PATCH_MISMATCH', 'Expected patch lines were not found.');
    const output = next.map(text => ({text, eol}));
    for (const [oi, ni] of chunk.keep) if (oi < old.length && ni < next.length) output[ni] = {...original[at + oi]!};
    replacements.push({at, count: old.length, lines: output});
    cursor = at + old.length;
  }
  const result = original.map(l => ({...l}));
  for (const r of replacements.toReversed()) result.splice(r.at, r.count, ...r.lines);
  for (let i = 0; i < result.length - 1; i++) if (!result[i]!.eol) result[i]!.eol = eol;
  if (content && !/[\r\n]$/.test(content) && result.length) result.at(-1)!.eol = '';
  return bom + result.map(l => l.text + l.eol).join('');
}
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const split = (s: string | null) =>
    s === null || s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const a = split(before),
    b = split(after);
  let start = 0,
    end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (end < Math.min(a.length, b.length) - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  if (before === after) return '';
  const from = Math.max(0, start - 3),
    tail = Math.min(end, 3);
  const body = [
    ...a.slice(from, start).map(l => ' ' + l),
    ...a.slice(start, a.length - end).map(l => '-' + l),
    ...b.slice(start, b.length - end).map(l => '+' + l),
    ...a.slice(a.length - end, a.length - end + tail).map(l => ' ' + l),
  ];
  const terminators = (s: string | null) =>
    JSON.stringify({
      crlf: (s?.match(/\r\n/g) ?? []).length,
      lf: (s?.match(/(?<!\r)\n/g) ?? []).length,
      finalNewline: Boolean(s && /[\r\n]$/.test(s)),
    });
  const note =
    before !== null && after !== null && terminators(before) !== terminators(after)
      ? `\\ Line terminators: ${terminators(before)} -> ${terminators(after)}\n`
      : '';
  return `--- ${before === null ? '/dev/null' : 'a/' + path}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n@@ -${a.length ? from + 1 : 0},${a.length - end - from + tail} +${b.length ? from + 1 : 0},${b.length - end - from + tail} @@\n${body.join('\n')}\n${note}`;
}
