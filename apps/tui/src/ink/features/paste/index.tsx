/** @jsxImportSource react */
import {useState} from 'react';
import {TextLine, safeText} from '../../ui';

export interface PasteEntry {
  id: number;
  start: number;
  end: number;
  content: string;
}
export interface PasteState {
  value: string;
  cursor: number;
  pastes: PasteEntry[];
  nextPasteId: number;
  selectionAnchor?: number;
}
export const createPasteState = (value = ''): PasteState => ({value, cursor: value.length, pastes: [], nextPasteId: 1});
export function pasteLabel(id: number, content: string): string {
  return `[Pasted text #${id} +${content.split('\n').length - 1} lines]`;
}
/** Range metadata, rather than string replacement, keeps literal marker text literal. */
export function expandPastes(state: PasteState): string {
  let text = state.value;
  for (const paste of [...state.pastes].reverse())
    text = text.slice(0, paste.start) + paste.content + text.slice(paste.end);
  return text;
}
export function replaceRange(state: PasteState, from: number, to: number, text: string): PasteState {
  let start = Math.max(0, Math.min(state.value.length, Math.min(from, to)));
  let end = Math.max(start, Math.min(state.value.length, Math.max(from, to)));
  for (const paste of state.pastes) {
    if (start > paste.start && start < paste.end) start = paste.start;
    if (end > paste.start && end < paste.end) end = paste.end;
  }
  const shift = text.length - (end - start);
  return {
    ...state,
    value: state.value.slice(0, start) + text + state.value.slice(end),
    cursor: start + text.length,
    selectionAnchor: undefined,
    pastes: state.pastes.flatMap(paste =>
      paste.end <= start
        ? [paste]
        : paste.start >= end
          ? [{...paste, start: paste.start + shift, end: paste.end + shift}]
          : [],
    ),
  };
}
export function insertPaste(state: PasteState, input: string): PasteState {
  const content = safeText(input.replace(/\r\n?/g, '\n'));
  const from = Math.min(state.cursor, state.selectionAnchor ?? state.cursor);
  const to = Math.max(state.cursor, state.selectionAnchor ?? state.cursor);
  if (content.length < 1000 && content.split('\n').length < 5) return replaceRange(state, from, to, content);
  const id = state.nextPasteId;
  const marker = pasteLabel(id, content);
  const next = replaceRange(state, from, to, marker);
  return {
    ...next,
    nextPasteId: id + 1,
    pastes: [...next.pastes, {id, start: next.cursor - marker.length, end: next.cursor, content}].sort(
      (a, b) => a.start - b.start,
    ),
  };
}
export function usePasteState(initialValue = '') {
  const [state, setState] = useState(() => createPasteState(initialValue));
  return {
    state,
    setState,
    insert: (text: string) => setState(previous => insertPaste(previous, text)),
    content: expandPastes(state),
  };
}
export interface PasteProps {
  id: number;
  content: string;
  width?: number;
}
export function Paste({id, content, width}: PasteProps) {
  return (
    <TextLine width={width} dimColor>
      {pasteLabel(id, content)}
    </TextLine>
  );
}
