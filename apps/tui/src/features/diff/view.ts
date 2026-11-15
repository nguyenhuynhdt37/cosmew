import type { BorderStyle, ThemeTokens, WorkspaceDiffReport } from '@hannes/contracts';
import { Modal, clampIndex, type RenderedBoxLine } from '../../ui';
import type { DiffViewState } from './types';

export function renderDiffViewerOverlay(options: {
  width: number;
  height: number;
  report: WorkspaceDiffReport;
  state: DiffViewState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, report, state, tokens, borderStyle } = options;
  const modal = new Modal({ width, height, tokens, borderStyle, minInner: 20 });
  const summary = report.files.length === 0
    ? 'Clean working tree'
    : `${report.files.length} files (+${report.totalAdditions}/-${report.totalDeletions})`;
  modal.top(' WORKSPACE DIFF VIEWER (/diff) ', ` ${summary} · Esc Close `);

  if (report.files.length === 0) {
    modal.text(' Working tree is clean — no modified files detected in workspace.', { fg: tokens.success, bold: true });
    modal.fillTo(1 + Math.max(2, height - 4));
  } else {
    const fileIndex = clampIndex(state.selectedFileIndex, report.files.length);
    const activeFile = report.files[fileIndex]!;
    const badges = report.files
      .map((f, idx) => `${idx === fileIndex ? '▸' : ' '}${f.path} (+${f.additions}/-${f.deletions})`)
      .join('  │  ');
    modal.text(` ${badges}`, { fg: tokens.info, bg: tokens.backgroundElevated, bold: true });

    const diffLines: { text: string; kind: 'hunk' | 'add' | 'del' | 'context' }[] = activeFile.lines.length > 0
      ? activeFile.lines.map(l => ({
          text: l.type === 'add' ? `+${l.content}` : l.type === 'del' ? `-${l.content}` : l.type === 'hunk' ? l.content : ` ${l.content}`,
          kind: l.type,
        }))
      : [{ text: ` (${activeFile.status}) Binary or empty diff content`, kind: 'context' }];

    const available = Math.max(3, height - 4);
    const offset = Math.max(0, Math.min(Math.max(0, diffLines.length - available), state.scrollOffset));
    for (let i = 0; i < available; i++) {
      const item = diffLines[offset + i];
      if (!item) { modal.blank(); continue; }
      const fg = item.kind === 'add' ? tokens.diffAdded : item.kind === 'del' ? tokens.diffRemoved : item.kind === 'hunk' ? tokens.info : tokens.diffContext;
      modal.text(` ${item.text}`, { fg, bold: item.kind === 'hunk' });
    }
  }

  return modal.bottom(' ←/→ Switch File · ↑/↓ Scroll Hunks · Esc Return to Chat ').lines;
}
