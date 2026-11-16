import type {BorderStyle, ThemeTokens, WorkspaceDiffReport} from '@futryn/contracts';
import {Modal, clampIndex, type RenderedBoxLine} from '../../ui';
import type {DiffViewState} from './types';
import {renderDiffCodeLine} from './code-lines';

export function renderDiffViewerOverlay(options: {
  width: number;
  height: number;
  report: WorkspaceDiffReport;
  state: DiffViewState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, report, state, tokens, borderStyle} = options;
  const modal = new Modal({width, height, tokens, borderStyle, minInner: 1});
  modal.top(' /diff ', ` ${report.files.length} files +${report.totalAdditions} -${report.totalDeletions} `);
  const rows = Math.max(0, height - 2);
  if (!report.files.length) {
    modal.text(report.gitAvailable ? ' Clean working tree' : ' Workspace diff unavailable', {
      fg: report.gitAvailable ? tokens.success : tokens.foregroundMuted,
    });
    modal.fill();
  } else {
    const selected = clampIndex(state.selectedFileIndex, report.files.length),
      active = report.files[selected]!;
    const listWidth = width >= 80 ? Math.min(32, Math.floor(modal.innerWidth * 0.3)) : 0;
    const codeWidth = modal.innerWidth - (listWidth ? listWidth + 1 : 0);
    const codeRows = active.lines.flatMap(line => renderDiffCodeLine(line, codeWidth, tokens));
    if (!codeRows.length)
      codeRows.push({
        spans: [
          {
            text: ` (${active.status}) Binary or empty diff`.slice(0, codeWidth).padEnd(codeWidth),
            fg: tokens.foregroundMuted,
            bg: modal.bg,
          },
        ],
      });
    const available = Math.max(0, rows - 1);
    const offset = Math.min(Math.max(0, codeRows.length - available), Math.max(0, state.scrollOffset));
    state.scrollOffset = offset;
    const firstFile = Math.max(0, Math.min(report.files.length - rows, selected - Math.floor(rows / 2)));
    for (let row = 0; row < rows; row++) {
      const spans = [];
      if (listWidth) {
        const index = firstFile + row,
          file = report.files[index];
        const text = file ? `${index === selected ? '▸' : ' '} ${file.path} +${file.additions} -${file.deletions}` : '';
        spans.push({
          text: text.slice(0, listWidth).padEnd(listWidth),
          fg: index === selected ? tokens.selectionForeground : tokens.foregroundMuted,
          bg: index === selected ? tokens.selection : modal.bg,
          bold: index === selected,
        });
        spans.push({text: '│', fg: tokens.border, bg: modal.bg});
      }
      if (row === 0)
        spans.push({
          text: ` ${active.path}  +${active.additions} -${active.deletions}`.slice(0, codeWidth).padEnd(codeWidth),
          fg: tokens.foreground,
          bg: tokens.backgroundElevated,
          bold: true,
        });
      else
        spans.push(
          ...(codeRows[offset + row - 1]?.spans ?? [
            {text: ' '.repeat(codeWidth), fg: tokens.foreground, bg: modal.bg},
          ]),
        );
      modal.spans(spans);
    }
  }
  return modal.bottom(' ←/→ File · ↑/↓ Line · PgUp/PgDn Page · Esc Close ').lines;
}
