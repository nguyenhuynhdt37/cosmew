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
  let line: WrapRun<Style>[] = [];
  let used = 0;
  let word: {text: string; width: number; style?: Style}[] = [];
  let wordWidth = 0;
  const append = (text: string, style?: Style) => {
    if (!text) return;
    const last = line.at(-1);
    if (last && last.style === style) last.text += text;
    else line.push(style !== undefined ? {text, style} : {text});
  };
  const flush = () => {
    lines.push(line);
    line = [];
    used = 0;
  };
  const flushWord = () => {
    if (!word.length) return;
    if (used + wordWidth > limit && used > 0) {
      // Only soft-break spaces disappear. Keep styling attached to the remaining text.
      while (line.length) {
        const last = line.at(-1)!;
        last.text = last.text.replace(/ +$/, '');
        if (last.text) break;
        line.pop();
      }
      if (line.length) flush();
      else used = 0;
    }
    for (const part of word) {
      if (used + part.width <= limit) {
        append(part.text, part.style);
        used += part.width;
      } else if (!/[^\x20-\x7e]/.test(part.text)) {
        // ASCII spans have one cell per code unit. Slice only at row boundaries;
        // do not build a million grapheme/cell objects for a large pasted prompt.
        for (let at = 0; at < part.text.length;) {
          if (used >= limit) flush();
          const end = Math.min(part.text.length, at + limit - used);
          append(part.text.slice(at, end), part.style);
          used += end - at;
          at = end;
        }
      } else {
        // Unicode words that fit took the fast path above. Segment only oversized
        // words, keeping joined emoji, combining marks and zero-width graphemes intact.
        for (const {segment} of graphemes.segment(part.text)) {
          const size = stringCells(segment);
          if (used + size > limit && used > 0) flush();
          append(segment, part.style);
          used += size;
        }
      }
    }
    word = [];
    wordWidth = 0;
  };
  for (const {text, style} of runs) {
    // Words may cross style/run boundaries, so keep their total width until a
    // space/newline arrives instead of treating each styled span as a new word.
    for (const match of text.matchAll(/[^ \r\n]+|\r\n|\r| +|\n/g)) {
      const part = match[0];
      if (part === '\n') {
        flushWord();
        flush();
      } else if (part[0] === ' ') {
        flushWord();
        const count = Math.max(0, Math.min(part.length, limit - used));
        append(part.slice(0, count), style);
        used += count;
      } else {
        const size = stringCells(part);
        word.push(style !== undefined ? {text: part, width: size, style} : {text: part, width: size});
        wordWidth += size;
      }
    }
  }
  flushWord();
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
