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

export const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
/** Width of a terminal string, including joined emoji and combining sequences. */
export function stringCells(text: string): number {
  return Bun.stringWidth(text);
}
export interface WrapRun<Style = 'code' | 'command'> {
  text: string;
  /** Presentation carried through wrapping in user messages. */
  style?: Style;
}
/** Name of a slash command at the beginning of a draft, excluding its arguments. */
export function leadingSlashCommand(text: string): RegExpExecArray | null {
  return /^(\s*)(\/[^\s/]*)/.exec(text);
}
/**
 * Greedy word wrap of styled runs to `width` cells; `\n` always breaks. Words longer than a line are cut.
 * The output keeps every character (trailing spaces at a soft break are dropped).
 */
export function wrapRuns<Style>(runs: readonly WrapRun<Style>[], width: number): WrapRun<Style>[][] {
  const limit = Math.max(1, Math.floor(width));
  const lines: WrapRun<Style>[][] = [];
  const cells = runs.flatMap(({text, style}) =>
    Array.from(graphemes.segment(text), ({segment}) => ({ch: segment, width: stringCells(segment), style})),
  );
  let line: typeof cells = [];
  let used = 0;
  const flush = () => {
    const merged: WrapRun<Style>[] = [];
    for (const cell of line) {
      const last = merged.at(-1);
      if (last && last.style === cell.style) last.text += cell.ch;
      else merged.push(cell.style !== undefined ? {text: cell.ch, style: cell.style} : {text: cell.ch});
    }
    lines.push(merged);
    line = [];
    used = 0;
  };
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
    while (end < cells.length && cells[end]!.ch !== ' ' && cells[end]!.ch !== '\n') size += cells[end++]!.width;
    if (used + size > limit && used > 0) {
      while (line.at(-1)?.ch === ' ') line.pop();
      if (line.length) flush();
      else used = 0;
    }
    for (let index = at; index < end; index++) {
      const width = cells[index]!.width;
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
