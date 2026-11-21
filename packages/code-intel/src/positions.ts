/**
 * LSP positions are 0-based lines and UTF-16 code-unit columns; Cosmew's tool speaks 1-based lines
 * and 1-based code-point columns (what a model counts in the text it read). ADR 0043.
 */

/** 1-based code-point column on `line` → 0-based UTF-16 character offset. */
export function toUtf16Character(line: string, column: number): number {
  let units = 0;
  let points = 0;
  for (const ch of line) {
    if (points >= column - 1) break;
    units += ch.length;
    points++;
  }
  return units;
}

/** 0-based UTF-16 character offset on `line` → 1-based code-point column. */
export function toCodePointColumn(line: string, character: number): number {
  let units = 0;
  let points = 0;
  for (const ch of line) {
    if (units >= character) break;
    units += ch.length;
    points++;
  }
  return points + 1;
}

/** Offset into `text` of an LSP position (clamped). */
export function offsetAt(text: string, position: {line: number; character: number}): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(position.line, lines.length); i++) offset += lines[i]!.length + 1;
  const line = lines[Math.min(position.line, lines.length - 1)] ?? '';
  return Math.min(text.length, offset + Math.min(position.character, line.length));
}
