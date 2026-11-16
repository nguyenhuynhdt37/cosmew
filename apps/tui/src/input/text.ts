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

export function verticalCursor(text: string, cursor: number, direction: -1 | 1): number | null {
  const start = cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1;
  const endAt = text.indexOf('\n', cursor);
  const end = endAt < 0 ? text.length : endAt;
  if ((direction < 0 && start === 0) || (direction > 0 && end === text.length)) return null;
  const targetStart = direction < 0 ? (start <= 1 ? 0 : text.lastIndexOf('\n', start - 2) + 1) : end + 1;
  const targetEnd = direction < 0 ? start - 1 : text.indexOf('\n', targetStart);
  const line = text.slice(targetStart, targetEnd < 0 ? text.length : targetEnd);
  const column = textWidth(text.slice(start, cursor));
  let width = 0;
  let offset = 0;
  for (const {segment} of segmenter.segment(line)) {
    const next = textWidth(segment);
    if (width + next > column) break;
    width += next;
    offset += segment.length;
  }
  return targetStart + offset;
}
