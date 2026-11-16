import type { ThemeTokens } from '@futryn/contracts';
import { Canvas } from '../../ui/canvas';
import type { FrameSnapshot, TranscriptViewport } from '../../types';
export interface CellPoint { row: number; col: number }
/** Select only already rendered, redacted cells. Streaming continues behind the
 * frozen view so repainting cannot replace the text the user is copying. */
export class TextSelection {
  frame: FrameSnapshot | null = null;
  private anchor: CellPoint = {row:0,col:0};
  private end: CellPoint = {row:0,col:0};
  private dragging = false;
  private document: TranscriptViewport | null = null;
  private pointer: CellPoint = {row:0,col:0};
  private edgeElapsed = 0;
  private copied = false;
  private tooLarge = false;
  private clamp(point: CellPoint): CellPoint {
    if (this.document) {
      const doc = this.document;
      return {row: Math.max(0, Math.min(doc.lines.length - 1, doc.offset + Math.max(0, Math.min(doc.height - 1, point.row - doc.top)))), col: Math.max(0, Math.min(doc.width - 1, point.col - doc.left))};
    }
    return {row: Math.max(0, Math.min(this.frame!.rows - 2, point.row)), col: Math.max(0, Math.min(this.frame!.cols - 1, point.col))};
  }
  begin(frame: FrameSnapshot, point: CellPoint): void {
    this.frame = frame;
    const doc = frame.transcriptViewport;
    this.document = doc && point.row >= doc.top && point.row < doc.top + doc.height && point.col >= doc.left && point.col < doc.left + doc.width ? {...doc} : null;
    this.pointer = point; this.edgeElapsed = 0;
    this.anchor = this.end = this.clamp(point); this.dragging = true; this.copied = false; this.tooLarge = false;
  }
  move(point: CellPoint): void {
    if (!this.frame || !this.dragging) return;
    this.pointer = point;
    if (this.document && (point.row < this.document.top || point.row >= this.document.top + this.document.height)) this.scroll(point.row < this.document.top ? -2 : 2);
    this.end = this.clamp(point);
  }
  step(deltaSeconds: number): void {
    if (!this.dragging || !this.document || this.pointer.row >= this.document.top && this.pointer.row < this.document.top + this.document.height) { this.edgeElapsed = 0; return; }
    this.edgeElapsed += deltaSeconds;
    if (this.edgeElapsed >= 0.06) { this.scroll(this.pointer.row < this.document.top ? -1 : 1); this.edgeElapsed = 0; }
  }
  /** Keep the frozen document and selection anchor while scrolling across screens. */
  scroll(amount: number): boolean {
    if (!this.document) return false;
    const doc = this.document;
    doc.offset = Math.max(0, Math.min(Math.max(0, doc.lines.length - doc.height), doc.offset + amount));
    if (this.dragging) this.end = this.clamp(this.pointer);
    return true;
  }
  release(point: CellPoint): void { if (this.frame && this.dragging) this.end = this.clamp(point); this.dragging = false; if (!this.active()) this.clear(); }
  active(): boolean { return !!this.frame && (this.anchor.row !== this.end.row || this.anchor.col !== this.end.col); }
  clear(): void { this.frame = null; this.document = null; this.dragging = false; this.edgeElapsed = 0; this.copied = false; this.tooLarge = false; }
  private bounds(): [CellPoint, CellPoint] {
    return this.anchor.row < this.end.row || (this.anchor.row === this.end.row && this.anchor.col <= this.end.col) ? [this.anchor, this.end] : [this.end, this.anchor];
  }
  text(): string {
    if (!this.active()) return '';
    const [start, end] = this.bounds(); const rows: string[] = [];
    for (let y = start.row; y <= end.row; y++) {
      const from = y === start.row ? start.col : 0;
      const to = y === end.row ? end.col + 1 : this.document?.width ?? this.frame!.cols;
      const line = this.document ? this.documentRow(y).map(cell => cell.ch).join('') : this.frame!.plainLines[y]!;
      rows.push(line.slice(from, to).replace(/\s+$/g, ''));
    }
    return rows.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  }
  copySequence(): string | null {
    const text = this.text(); if (!text) return null;
    if (Buffer.byteLength(text) > 65536) { this.tooLarge = true; return null; }
    this.copied = true;
    return `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
  }
  private documentRow(row: number) {
    const doc = this.document!;
    const base = this.frame!.cells[doc.top]?.[doc.left];
    const canvas = new Canvas(doc.width, 1, base?.fg ?? '', base?.bg ?? '');
    const line = doc.lines[row];
    if (line) canvas.block(0, 0, [line], doc.width);
    return canvas.cells[0]!;
  }
  view(tokens: ThemeTokens): FrameSnapshot {
    const base = this.frame!;
    const cells = base.cells.map(row => row.map(cell => ({...cell})));
    if (this.document) {
      const doc = this.document;
      for (let row = 0; row < doc.height; row++) {
        const documentRow = this.documentRow(doc.offset + row);
        for (let col = 0; col < doc.width; col++) {
          const cell = documentRow[col];
          cells[doc.top + row]![doc.left + col] = cell ? {...cell} : {ch:' ', fg:tokens.foreground, bg:tokens.background, bold:false};
        }
      }
    }
    if (this.active()) {
      const [start, end] = this.bounds();
      for (let y = start.row; y <= end.row; y++) {
        const screenRow = this.document ? y - this.document.offset + this.document.top : y;
        if (this.document && (screenRow < this.document.top || screenRow >= this.document.top + this.document.height)) continue;
        const from = y === start.row ? start.col : 0; const to = y === end.row ? end.col + 1 : this.document?.width ?? base.cols;
        for (let x = from; x < to; x++) {
          const screenCol = x + (this.document?.left ?? 0);
          cells[screenRow]![screenCol] = {...cells[screenRow]![screenCol]!, fg: tokens.selectionForeground, bg: tokens.selection, selected: true};
        }
      }
      const hint = this.tooLarge ? 'Selection too large · select fewer lines' : this.copied ? 'Copy requested · Ctrl+C Retry · Esc Clear' : base.cols < 36 ? 'Ctrl+C Copy · Esc' : 'Ctrl+C Copy · Esc Clear';
      cells[base.rows - 1] = Array.from({length:base.cols}, (_, x) => ({ch: hint[x] ?? ' ', fg: tokens.foregroundMuted, bg: tokens.background, bold:false}));
    }
    const plainLines = cells.map(row => row.map(cell => cell.ch).join(''));
    return {...base, cells, plainLines, plainText: plainLines.join('\n')};
  }
}
