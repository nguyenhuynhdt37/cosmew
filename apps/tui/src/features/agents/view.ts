import type {ThemeFrame} from '../../core/feature';
import {Modal} from '../../ui/modal';
import {listRows} from './logic';
import type {AgentsState} from './types';

export function renderAgents(state: AgentsState, size: {width: number; height: number}, theme: ThemeFrame) {
  const modal = new Modal({...size, tokens: theme.tokens, borderStyle: theme.borderStyle, minInner: 1}).top(
    state.detail.length ? ` Subagent ${state.detailTitle} ` : ' Agents ',
  );
  const width = Math.max(1, modal.innerWidth - 2);
  let source: string[];
  let focus = 0;
  if (state.detail.length) {
    source = state.detail;
    focus = state.offset;
  } else {
    const warnings = [...state.report.errors, ...state.report.warnings].map(
      d => `${d.code}${d.path ? ` ${d.path}` : ''}`,
    );
    const list = listRows(state.report.types, warnings, state.children, state.index);
    source = list.rows;
    focus = list.childRowIndex[state.index] ?? 0;
  }
  const rows = source.flatMap(row => {
    const lines: string[] = [];
    for (let n = 0; n < row.length; n += width) lines.push(row.slice(n, n + width));
    return lines.length ? lines : [''];
  });
  const room = Math.max(1, size.height - 4);
  const wanted = state.detail.length ? state.offset : Math.max(0, focus - Math.floor(room / 2));
  const offset = Math.min(Math.max(0, wanted), Math.max(0, rows.length - room));
  for (const row of rows.slice(offset, offset + room)) modal.text(' ' + row);
  if (state.message && modal.lines.length < size.height - 1) modal.text(state.message);
  return modal
    .fill()
    .bottom(
      state.detail.length ? ' ↑↓ Scroll · Esc Back ' : ' ↑↓ Move · Enter Transcript · X Stop · R Refresh · Esc Close ',
    ).lines;
}
