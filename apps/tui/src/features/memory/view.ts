import type {ThemeFrame} from '../../core/feature';
import {Modal} from '../../ui/modal';
import {memoryRows} from './logic';
import type {MemoryState} from './types';
export function renderMemory(state: MemoryState, size: {width: number; height: number}, theme: ThemeFrame) {
  const modal = new Modal({...size, tokens: theme.tokens, borderStyle: theme.borderStyle, minInner: 1}).top(
    ' Memories ',
  );
  const width = Math.max(1, modal.innerWidth - 2);
  const rows = memoryRows(state).flatMap(row => {
    const lines: string[] = [];
    for (let n = 0; n < row.length; n += width) lines.push(row.slice(n, n + width));
    return lines.length ? lines : [''];
  });
  const room = Math.max(1, size.height - 4);
  const offset = Math.min(Math.max(0, state.offset), Math.max(0, rows.length - room));
  for (const row of rows.slice(offset, offset + room)) modal.text(' ' + row);
  if (state.message && modal.lines.length < size.height - 1) modal.text(state.message);
  return modal.fill().bottom(' ↑↓ Move · Enter Read · D Delete · O Folder · Esc Back ').lines;
}
