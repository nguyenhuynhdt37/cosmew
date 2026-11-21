import {graphemes, previousGrapheme, nextGrapheme, textWidth} from '../../../input/text';
import {expandPastes, replaceRange, type PasteState} from '../paste';

export interface VisualRow {
  text: string;
  start: number;
}
/** Bounded view is sliced by the caller around the caret; offsets remain UTF-16. */
export function visualRows(value: string, width: number): VisualRow[] {
  const rows: VisualRow[] = [];
  let offset = 0;
  for (const line of value.split('\n')) {
    let text = '',
      start = offset,
      cells = 0;
    for (const {segment, index} of graphemes(line)) {
      const size = textWidth(segment);
      if (text && cells + size > Math.max(1, width)) {
        rows.push({text, start});
        text = '';
        start = offset + index;
        cells = 0;
      }
      text += segment;
      cells += size;
    }
    rows.push({text, start});
    if (cells >= Math.max(1, width)) rows.push({text: '', start: offset + line.length});
    offset += line.length + 1;
  }
  return rows;
}
export function moveCursor(state: PasteState, direction: -1 | 1, selecting = false): PasteState {
  const anchor = state.selectionAnchor;
  const selected = anchor !== undefined && anchor !== state.cursor;
  let cursor =
    selected && !selecting
      ? direction < 0
        ? Math.min(anchor, state.cursor)
        : Math.max(anchor, state.cursor)
      : direction < 0
        ? previousGrapheme(state.value, state.cursor)
        : nextGrapheme(state.value, state.cursor);
  for (const paste of state.pastes)
    if (cursor > paste.start && cursor < paste.end) cursor = direction < 0 ? paste.start : paste.end;
  return {...state, cursor, selectionAnchor: selecting ? (anchor ?? state.cursor) : undefined};
}
export type EditAction =
  | 'backspace'
  | 'delete'
  | 'start'
  | 'end'
  | 'killEnd'
  | 'killStart'
  | 'killWord'
  | 'killWordForward'
  | 'deleteWordBack';
const WORD = /[\p{L}\p{N}]/u;
/** Start of the word before `cursor`: letters and digits make a word, punctuation and spaces separate (Alt+B). */
export function wordLeft(value: string, cursor: number): number {
  let at = cursor;
  while (at > 0 && !WORD.test(value[at - 1]!)) at--;
  while (at > 0 && WORD.test(value[at - 1]!)) at--;
  return at;
}
/** End of the word after `cursor` (Alt+F / Alt+D). */
export function wordRight(value: string, cursor: number): number {
  let at = cursor;
  while (at < value.length && !WORD.test(value[at]!)) at++;
  while (at < value.length && WORD.test(value[at]!)) at++;
  return at;
}
/** Span a deleting action removes, or undefined when it only moves the cursor or has nothing to remove. */
export function editSpan(state: PasteState, action: EditAction): [number, number] | undefined {
  const {value, cursor, selectionAnchor} = state;
  if ((action === 'backspace' || action === 'delete') && selectionAnchor !== undefined && selectionAnchor !== cursor)
    return [Math.min(cursor, selectionAnchor), Math.max(cursor, selectionAnchor)];
  const start = cursor === 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1;
  const at = value.indexOf('\n', cursor);
  const end = at < 0 ? value.length : at;
  let from = cursor;
  let to = cursor;
  switch (action) {
    case 'backspace':
      from = moveCursor(state, -1).cursor;
      break;
    case 'delete':
      to = moveCursor(state, 1).cursor;
      break;
    case 'killStart':
      // Repeating at the start of a line joins it to the previous one.
      from = cursor === start ? Math.max(0, cursor - 1) : start;
      break;
    case 'killEnd':
      to = cursor === end ? Math.min(value.length, end + 1) : end;
      break;
    case 'killWord':
      from = value.slice(0, cursor).replace(/\S+\s*$/, '').length;
      break;
    case 'killWordForward':
      to = wordRight(value, cursor);
      break;
    case 'deleteWordBack':
      from = wordLeft(value, cursor);
      break;
    default:
      return undefined;
  }
  for (const paste of state.pastes) {
    if (from > paste.start && from < paste.end) from = paste.start;
    if (to > paste.start && to < paste.end) to = paste.end;
  }
  return from === to ? undefined : [from, to];
}
export function edit(state: PasteState, action: EditAction): PasteState {
  if (action === 'start' || action === 'end') {
    const {value, cursor} = state;
    const start = cursor === 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1;
    const at = value.indexOf('\n', cursor);
    return {...state, cursor: action === 'start' ? start : at < 0 ? value.length : at, selectionAnchor: undefined};
  }
  const span = editSpan(state, action);
  return span ? replaceRange(state, span[0], span[1], '') : state;
}
/** Move the caret to `cursor`; with `selecting` the original position stays as the selection anchor. */
export function moveTo(state: PasteState, cursor: number, selecting = false): PasteState {
  let at = cursor;
  for (const paste of state.pastes)
    if (at > paste.start && at < paste.end) at = cursor < state.cursor ? paste.start : paste.end;
  return {...state, cursor: at, selectionAnchor: selecting ? (state.selectionAnchor ?? state.cursor) : undefined};
}
/** Logical line edges (not wrapped rows) for Shift+Home / Shift+End. */
export function lineEdge(state: PasteState, edge: 'start' | 'end'): number {
  const {value, cursor} = state;
  if (edge === 'start') return cursor === 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1;
  const at = value.indexOf('\n', cursor);
  return at < 0 ? value.length : at;
}
export function insertText(state: PasteState, text: string): PasteState {
  return replaceRange(state, state.cursor, state.selectionAnchor ?? state.cursor, text);
}
export function verticalMove(state: PasteState, direction: -1 | 1, width: number): PasteState | null {
  const rows = visualRows(state.value, width);
  const row = rows.findLastIndex(item => item.start <= state.cursor);
  const target = rows[row + direction];
  if (!target) return null;
  const column = textWidth(state.value.slice(rows[row]!.start, state.cursor));
  let cells = 0,
    cursor = target.start;
  for (const {segment} of graphemes(target.text)) {
    cells += textWidth(segment);
    if (cells > column) break;
    cursor += segment.length;
  }
  for (const paste of state.pastes)
    if (cursor > paste.start && cursor < paste.end) cursor = direction < 0 ? paste.start : paste.end;
  return {...state, cursor, selectionAnchor: undefined};
}
/** Text of a span with collapsed paste markers expanded (what a kill puts on the ring). */
export function spanText(state: PasteState, from: number, to: number): string {
  const pastes = state.pastes
    .filter(paste => paste.start >= from && paste.end <= to)
    .map(paste => ({...paste, start: paste.start - from, end: paste.end - from}));
  return expandPastes({...state, value: state.value.slice(from, to), pastes, cursor: 0, selectionAnchor: undefined});
}
/** `:name:` shortcodes the prompt turns into emoji (a small fixed table; unknown names stay literal). */
export const EMOJI: Readonly<Record<string, string>> = {
  smile: '😄',
  grin: '😁',
  joy: '😂',
  wink: '😉',
  blush: '😊',
  heart: '❤️',
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  fire: '🔥',
  rocket: '🚀',
  tada: '🎉',
  eyes: '👀',
  thinking: '🤔',
  warning: '⚠️',
  white_check_mark: '✅',
  x: '❌',
  bug: '🐛',
  sparkles: '✨',
  wave: '👋',
  pray: '🙏',
  clap: '👏',
  '100': '💯',
  bulb: '💡',
  memo: '📝',
  lock: '🔒',
  key: '🔑',
  zap: '⚡',
  star: '⭐',
  coffee: '☕',
  pizza: '🍕',
  sob: '😭',
  cry: '😢',
  sunglasses: '😎',
  muscle: '💪',
  ok_hand: '👌',
  hammer: '🔨',
  wrench: '🔧',
  package: '📦',
};
/** `:name:` just completed before `cursor`: the span to replace and its emoji, or undefined. */
export function emojiShortcode(value: string, cursor: number): {from: number; emoji: string} | undefined {
  const match = /(?:^|\s):([a-z0-9_+-]{1,32}):$/.exec(value.slice(0, cursor));
  const emoji = match ? EMOJI[match[1]!] : undefined;
  return match && emoji ? {from: cursor - match[1]!.length - 2, emoji} : undefined;
}
