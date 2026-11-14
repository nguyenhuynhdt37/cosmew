import type { BorderStyle, ThemeTokens, WorkspaceDiffReport } from '@hannes/contracts';
import { getBorderGlyphs } from '../theme/theme';
import type { RenderedBoxLine } from './editor';

export interface DiffViewState {
  selectedFileIndex: number;
  scrollOffset: number;
}

export function createInitialDiffViewState(): DiffViewState {
  return {
    selectedFileIndex: 0,
    scrollOffset: 0,
  };
}

export function renderDiffViewerOverlay(options: {
  width: number;
  height: number;
  report: WorkspaceDiffReport;
  state: DiffViewState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, report, state, tokens, borderStyle } = options;
  const innerWidth = Math.max(20, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const title = ' WORKSPACE DIFF VIEWER (/diff) ';
  const summaryStr =
    report.files.length === 0
      ? 'Clean working tree'
      : `${report.files.length} files (+${report.totalAdditions}/-${report.totalDeletions})`;
  const summaryRight = ` ${summaryStr} · Esc Close `;
  const topFill = Math.max(0, innerWidth - title.length - summaryRight.length);

  lines.push({
    spans: [
      { text: glyphs.topLeft, fg: tokens.borderFocused, bg },
      { text: title, fg: tokens.accent, bg, bold: true },
      { text: glyphs.horizontal.repeat(topFill), fg: tokens.borderFocused, bg },
      { text: summaryRight.slice(0, Math.max(0, innerWidth - title.length)), fg: tokens.foregroundMuted, bg },
      { text: glyphs.topRight, fg: tokens.borderFocused, bg },
    ],
  });

  if (report.files.length === 0) {
    const emptyMsg = ' Working tree is clean — no modified files detected in workspace.';
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: emptyMsg.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.success, bg, bold: true },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
    const bodyRows = Math.max(2, height - 4);
    for (let i = 1; i < bodyRows; i++) {
      lines.push({
        spans: [
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
          { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        ],
      });
    }
  } else {
    const fileIdx = Math.max(0, Math.min(report.files.length - 1, state.selectedFileIndex));
    const activeFile = report.files[fileIdx]!;

    // File tabs bar
    const fileBadges = report.files
      .map((f, idx) => {
        const prefix = idx === fileIdx ? '▸' : ' ';
        return `${prefix}${f.path} (+${f.additions}/-${f.deletions})`;
      })
      .join('  │  ');
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: ` ${fileBadges}`.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.info, bg: tokens.backgroundElevated, bold: true },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });

    const allDiffLines: { text: string; kind: 'hunk' | 'add' | 'del' | 'context' }[] =
      activeFile.lines.length > 0
        ? activeFile.lines.map(l => ({
            text:
              l.type === 'add'
                ? `+${l.content}`
                : l.type === 'del'
                  ? `-${l.content}`
                  : l.type === 'hunk'
                    ? l.content
                    : ` ${l.content}`,
            kind: l.type,
          }))
        : [{ text: ` (${activeFile.status}) Binary or empty diff content`, kind: 'context' }];

    const availableRows = Math.max(3, height - 4);
    const maxOffset = Math.max(0, allDiffLines.length - availableRows);
    const offset = Math.max(0, Math.min(maxOffset, state.scrollOffset));
    const visible = allDiffLines.slice(offset, offset + availableRows);

    for (let i = 0; i < availableRows; i++) {
      const item = visible[i];
      if (!item) {
        lines.push({
          spans: [
            { text: glyphs.vertical, fg: tokens.borderFocused, bg },
            { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
            { text: glyphs.vertical, fg: tokens.borderFocused, bg },
          ],
        });
        continue;
      }
      const fg =
        item.kind === 'add'
          ? tokens.diffAdded
          : item.kind === 'del'
            ? tokens.diffRemoved
            : item.kind === 'hunk'
              ? tokens.info
              : tokens.diffContext;
      const rowText = ` ${item.text}`.slice(0, innerWidth).padEnd(innerWidth, ' ');
      lines.push({
        spans: [
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
          { text: rowText, fg, bg, bold: item.kind === 'hunk' },
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        ],
      });
    }
  }

  const footer = ' ←/→ Switch File · ↑/↓ Scroll Hunks · Esc Return to Chat ';
  const footerFill = Math.max(0, innerWidth - footer.length);
  lines.push({
    spans: [
      { text: glyphs.bottomLeft, fg: tokens.borderFocused, bg },
      { text: footer.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg },
      { text: glyphs.horizontal.repeat(footerFill), fg: tokens.borderFocused, bg },
      { text: glyphs.bottomRight, fg: tokens.borderFocused, bg },
    ],
  });

  return lines;
}
