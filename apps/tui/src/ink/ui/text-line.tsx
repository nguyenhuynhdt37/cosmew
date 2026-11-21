/** @jsxImportSource react */
import type {ReactNode} from 'react';
import {Box, Text, type TextProps} from 'ink';
import {useTheme} from '../theme';
/** Strip terminal commands and control bytes before they reach Ink. Preserve text newlines. */
export function safeText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\t/g, '    ');
}
export interface TextLineProps extends Omit<TextProps, 'children'> {
  children: string;
  width?: number;
}
/** Ink owns grapheme/cell measurement and ANSI-aware wrapping (string-width/wrap-ansi). */
export function TextLine({children, width, ...props}: TextLineProps) {
  return (
    <Box width={width === undefined ? undefined : Math.max(1, width)} minWidth={0}>
      <Text {...props} wrap={props.wrap ?? 'wrap'}>
        {safeText(children)}
      </Text>
    </Box>
  );
}

/** Terminal cell width of one code point (wide CJK/emoji = 2, combining/joiners = 0). */
export function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x1f3fb && code <= 0x1f3ff)
  )
    return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2;
  return 1;
}
export function stringCells(text: string): number {
  let total = 0;
  for (const char of text) total += cellWidth(char);
  return total;
}
export interface WrapRun {
  text: string;
  /** Presentation flag carried through wrapping (inline code in a user message). */
  code?: boolean;
}
/**
 * Greedy word wrap of styled runs to `width` cells; `\n` always breaks. Words longer than a line are cut.
 * The output keeps every character (trailing spaces at a soft break are dropped).
 */
export function wrapRuns(runs: readonly WrapRun[], width: number): WrapRun[][] {
  const limit = Math.max(1, Math.floor(width));
  const lines: WrapRun[][] = [];
  let line: {ch: string; code: boolean}[] = [];
  let used = 0;
  const flush = () => {
    const merged: WrapRun[] = [];
    for (const cell of line) {
      const last = merged.at(-1);
      if (last && !!last.code === cell.code) last.text += cell.ch;
      else merged.push({text: cell.ch, ...(cell.code ? {code: true} : {})});
    }
    lines.push(merged);
    line = [];
    used = 0;
  };
  const cells = runs.flatMap(run => Array.from(run.text).map(ch => ({ch, code: !!run.code})));
  let at = 0;
  while (at < cells.length) {
    const cell = cells[at]!;
    if (cell.ch === '\n') {
      flush();
      at++;
      continue;
    }
    if (cell.ch === ' ') {
      if (used + 1 <= limit) {
        line.push(cell);
        used++;
      }
      at++;
      continue;
    }
    let end = at;
    let size = 0;
    while (end < cells.length && cells[end]!.ch !== ' ' && cells[end]!.ch !== '\n') size += cellWidth(cells[end++]!.ch);
    if (used + size > limit && used > 0) {
      while (line.at(-1)?.ch === ' ') line.pop();
      flush();
    }
    for (let index = at; index < end; index++) {
      const width = cellWidth(cells[index]!.ch);
      if (used + width > limit && used > 0) flush();
      line.push(cells[index]!);
      used += width;
    }
    at = end;
  }
  if (line.length || !lines.length) flush();
  return lines;
}
/** Plain-text wrap used for gutters and result lines. */
export function wrapText(text: string, width: number): string[] {
  return wrapRuns([{text}], width).map(line => line.map(run => run.text).join(''));
}
/** The `⎿` connector of a tool result: two spaces, the glyph, two spaces (5 cells). */
export const RESULT_PREFIX = '  ⎿  ';
export const RESULT_INDENT = 5;
/** Splits digits out of a summary so the numbers can be bold, as in the reference. */
export function emphasizeDigits(text: string): {text: string; bold: boolean}[] {
  return text
    .split(/(\d+)/)
    .filter(part => part !== '')
    .map(part => ({text: part, bold: /^\d+$/.test(part)}));
}

export interface ResultLineProps {
  children: ReactNode;
  width?: number;
}
/** `  ⎿  ` connector with a hanging body: wrapped lines stay aligned under the first character. */
export function ResultLine({children, width}: ResultLineProps) {
  const {color} = useTheme();
  return (
    <Box width={width} minWidth={0}>
      <Text color={color('foregroundMuted')}>{RESULT_PREFIX}</Text>
      <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
