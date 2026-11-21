/** UTF-16 offsets for JS strings, with edits and terminal columns at grapheme boundaries. */
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
export const graphemes = (text: string) => [...segmenter.segment(text)];
export const textWidth = (text: string): number => Bun.stringWidth(text);

export function previousGrapheme(text: string, cursor: number): number {
  let previous = 0;
  for (const {index} of segmenter.segment(text)) {
    if (index >= cursor) break;
    previous = index;
  }
  return previous;
}

export function nextGrapheme(text: string, cursor: number): number {
  for (const {index, segment} of segmenter.segment(text)) {
    if (index >= cursor || index + segment.length > cursor) return index + segment.length;
  }
  return text.length;
}

/** Wrap whole words in terminal cells; only an over-wide single word splits at graphemes. */
export function wrapWords(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (line && textWidth(`${line} ${word}`) <= room) {
      line += ` ${word}`;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    for (const {segment} of graphemes(word)) {
      if (line && textWidth(line + segment) > room) {
        lines.push(line);
        line = '';
      }
      line += segment;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
