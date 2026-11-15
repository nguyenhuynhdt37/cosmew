import type { ThemeTokens } from '@hannes/contracts';
import type { FrameSnapshot } from '../../types';
export interface CellPoint { row: number; col: number }
/** Select only already rendered, redacted cells. Streaming continues behind the
 * frozen view so repainting cannot replace the text the user is copying. */
export class TextSelection {
  frame: FrameSnapshot | null = null;
  private anchor: CellPoint = {row:0,col:0};
  private end: CellPoint = {row:0,col:0};
  private dragging = false;
  private copied = false;
  private tooLarge = false;
  private clamp(point: CellPoint): CellPoint {
    return {row: Math.max(0, Math.min(this.frame!.rows - 2, point.row)), col: Math.max(0, Math.min(this.frame!.cols - 1, point.col))};
  }
  begin(frame: FrameSnapshot, point: CellPoint): void {
    this.frame = frame; this.anchor = this.end = this.clamp(point); this.dragging = true; this.copied = false; this.tooLarge = false;
  }
  move(point: CellPoint): void { if (this.frame && this.dragging) this.end = this.clamp(point); }
  release(point: CellPoint): void { this.move(point); this.dragging = false; if (!this.active()) this.clear(); }
  active(): boolean { return !!this.frame && (this.anchor.row !== this.end.row || this.anchor.col !== this.end.col); }
  clear(): void { this.frame = null; this.dragging = false; this.copied = false; this.tooLarge = false; }
  private bounds(): [CellPoint, CellPoint] {
    return this.anchor.row < this.end.row || (this.anchor.row === this.end.row && this.anchor.col <= this.end.col) ? [this.anchor, this.end] : [this.end, this.anchor];
  }
  text(): string {
    if (!this.active()) return '';
    const [start, end] = this.bounds(); const rows: string[] = [];
    for (let y = start.row; y <= end.row; y++) {
      const from = y === start.row ? start.col : 0;
      const to = y === end.row ? end.col + 1 : this.frame!.cols;
      rows.push(this.frame!.plainLines[y]!.slice(from, to).replace(/\s+$/g, ''));
    }
    return rows.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  }
  copySequence(): string | null {
    const text = this.text(); if (!text) return null;
    if (Buffer.byteLength(text) > 65536) { this.tooLarge = true; return null; }
    this.copied = true;
    return `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
  }
  view(tokens: ThemeTokens): FrameSnapshot {
    const base = this.frame!;
    const cells = base.cells.map(row => row.map(cell => ({...cell})));
    if (this.active()) {
      const [start, end] = this.bounds();
      for (let y = start.row; y <= end.row; y++) {
        const from = y === start.row ? start.col : 0; const to = y === end.row ? end.col + 1 : base.cols;
        for (let x = from; x < to; x++) cells[y]![x] = {...cells[y]![x]!, fg: tokens.selectionForeground, bg: tokens.selection, selected: true};
      }
      const hint = this.tooLarge ? 'Selection too large · select fewer lines' : this.copied ? 'Copy sent · Esc Clear' : base.cols < 36 ? 'Ctrl+C Copy · Esc' : 'Ctrl+C Copy · Esc Clear';
      cells[base.rows - 1] = Array.from({length:base.cols}, (_, x) => ({ch: hint[x] ?? ' ', fg: tokens.foregroundMuted, bg: tokens.background, bold:false}));
    }
    const plainLines = cells.map(row => row.map(cell => cell.ch).join(''));
    return {...base, cells, plainLines, plainText: plainLines.join('\n')};
  }
}
