import {graphemes, previousGrapheme, nextGrapheme, textWidth} from '../../../input/text';
import {replaceRange, type PasteState} from '../paste';

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
export function edit(
  state: PasteState,
  action: 'backspace' | 'delete' | 'start' | 'end' | 'killEnd' | 'killStart' | 'killWord',
): PasteState {
  const {value, cursor, selectionAnchor} = state;
  if ((action === 'backspace' || action === 'delete') && selectionAnchor !== undefined && selectionAnchor !== cursor)
    return replaceRange(state, cursor, selectionAnchor, '');
  const start = cursor === 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1;
  const at = value.indexOf('\n', cursor);
  const end = at < 0 ? value.length : at;
  if (action === 'start' || action === 'end')
    return {...state, cursor: action === 'start' ? start : end, selectionAnchor: undefined};
  const from =
    action === 'backspace'
      ? moveCursor(state, -1).cursor
      : action === 'killStart'
        ? start
        : action === 'killWord'
          ? value.slice(0, cursor).replace(/\S+\s*$/, '').length
          : cursor;
  const to =
    action === 'delete'
      ? moveCursor(state, 1).cursor
      : action === 'killEnd'
        ? cursor === end
          ? Math.min(value.length, end + 1)
          : end
        : cursor;
  return replaceRange(state, from, to, '');
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
