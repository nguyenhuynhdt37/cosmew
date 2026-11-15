import type { FrameCell } from '../types';
import type { RenderedBoxLine, StyledSpan } from './types';

/**
 * Every cell is written to the terminal verbatim, so a control byte (ESC, BEL, CR, C1…) from any
 * source — diff contents, model text, file names — could inject escape sequences. Render it as a space.
 */
const printable = (ch: string): string => {
  const code = ch.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch;
};

/** Character grid every screen paints into before it is diffed and sent to the terminal. */
export class Canvas {
  readonly cells: FrameCell[][];

  constructor(readonly cols: number, readonly rows: number, fg: string, bg: string) {
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: ' ', fg, bg, bold: false })));
  }

  /** Blank every cell, e.g. behind a modal dialog. */
  clear(fg: string, bg: string): void {
    for (const row of this.cells) for (const cell of row) { cell.ch = ' '; cell.fg = fg; cell.bg = bg; cell.bold = false; }
  }

  /** Paint spans left to right from (`row`, `startCol`), clipped to `maxWidth` and the grid. */
  spans(row: number, startCol: number, spans: StyledSpan[], maxWidth?: number): void {
    if (row < 0 || row >= this.rows) return;
    let col = startCol;
    const limit = maxWidth !== undefined ? Math.min(this.cols, startCol + maxWidth) : this.cols;
    for (const span of spans) {
      for (let i = 0; i < span.text.length; i++) {
        if (col >= limit) return;
        if (col >= 0) {
          this.cells[row]![col] = { ch: printable(span.text[i]!), fg: span.fg, bg: span.bg ?? this.cells[row]![col]!.bg, bold: Boolean(span.bold), ...(span.italic ? { italic: true } : {}) };
        }
        col++;
      }
    }
  }

  /** Paint pre-rendered lines starting at (`startRow`, `startCol`). */
  block(startRow: number, startCol: number, lines: RenderedBoxLine[], maxWidth?: number): void {
    lines.forEach((line, idx) => { if (line.spans.length > 0) this.spans(startRow + idx, startCol, line.spans, maxWidth); });
  }
}
