import type {TerminalMouseInput, TerminalSelectionEvent} from './mouse-input';

export interface ScreenPoint {
  column: number; // 1-based
  row: number; // 1-based
}

export interface ScreenSelectionOptions {
  stdout: NodeJS.WritableStream & {isTTY?: boolean; columns?: number; rows?: number};
  mouse: TerminalMouseInput;
  copyText: (text: string) => Promise<boolean>;
}

export interface ScreenSelectionBridge {
  stdout: NodeJS.WritableStream & {isTTY?: boolean; columns?: number; rows?: number};
  lines(): string[];
  extract(start: ScreenPoint, end: ScreenPoint): string;
  dispose(): void;
}

interface HighlightSpan {
  colStart0: number;
  colEnd0: number;
  text: string;
}

type ParserState = 'normal' | 'esc' | 'esc-ignore-one' | 'csi' | 'osc' | 'dcs';

const MAX_CSI_LENGTH = 256;
const MAX_STRING_LENGTH = 65536;
const MAX_SGR_LENGTH = 256;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

function isContinuationStarter(grapheme: string): boolean {
  const cp = grapheme.codePointAt(0);
  if (cp === undefined) return false;
  if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e || cp === 0x20e3) return true;
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true; // Fitzpatrick skin tone modifiers
  if (cp >= 0xe0020 && cp <= 0xe007f) return true; // Emoji tag sequences
  return /^\p{Mark}/u.test(grapheme);
}

function isSingleRegionalIndicator(text: string): boolean {
  const cp = text.codePointAt(0);
  return cp !== undefined && cp >= 0x1f1e6 && cp <= 0x1f1ff && text.length === 2;
}

function applySgrBody(current: string, body: string): string {
  if (!body) return '';
  const parts = body.split(';');
  // Scan top-level SGR parameters without misreading 0 inside 38;2;r;g;b or 38;5;n.
  let lastReset = -1;
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i] ?? '';
    const head = token.includes(':') ? token.slice(0, token.indexOf(':')) : token;
    if (head === '' || head === '0') {
      lastReset = i;
      continue;
    }
    if ((head === '38' || head === '48' || head === '58') && !token.includes(':')) {
      const mode = parts[i + 1];
      if (mode === '5') i += 2;
      else if (mode === '2') i += 4;
    }
  }
  if (lastReset >= 0) {
    const rest = parts.slice(lastReset + 1);
    return rest.length > 0 ? `\x1b[${rest.join(';')}m` : '';
  }
  const next = `\x1b[${body}m`;
  if (!current) return next;
  const combined = current + next;
  return combined.length <= MAX_SGR_LENGTH ? combined : next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizePoints(
  start: ScreenPoint,
  end: ScreenPoint,
  columns: number,
  rows: number,
): {fromRow: number; fromCol: number; toRow: number; toCol: number} {
  const r1 = clamp(Math.trunc(start.row) - 1, 0, rows - 1);
  const c1 = clamp(Math.trunc(start.column) - 1, 0, columns - 1);
  const r2 = clamp(Math.trunc(end.row) - 1, 0, rows - 1);
  const c2 = clamp(Math.trunc(end.column) - 1, 0, columns - 1);
  if (r1 > r2 || (r1 === r2 && c1 > c2)) {
    return {fromRow: r2, fromCol: c2, toRow: r1, toCol: c1};
  }
  return {fromRow: r1, fromCol: c1, toRow: r2, toCol: c2};
}

/** 2D VT screen model tracking printable grapheme cells, per-cell SGR attributes, and cursor/erase sequences. */
class VirtualScreen {
  columns: number;
  rows: number;
  private grid: string[][] = [];
  private sgrGrid: string[][] = [];
  private currentSgr = '';
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;
  private pendingWrap = false;
  private state: ParserState = 'normal';
  private csiBuffer = '';
  private stringEscape = false;
  private stringLength = 0;
  private decoder = new TextDecoder('utf-8');
  private pendingHighSurrogate = '';

  constructor(columns: number, rows: number) {
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    this.resetScreen();
  }

  get inEscapeSequence(): boolean {
    return this.state !== 'normal' || this.pendingHighSurrogate !== '';
  }

  resize(nextColumns: number, nextRows: number): void {
    const cols = Math.max(1, nextColumns);
    const rows = Math.max(1, nextRows);
    if (cols === this.columns && rows === this.rows) return;
    const resized: string[][] = [];
    const resizedSgr: string[][] = [];
    for (let r = 0; r < rows; r++) {
      const existing = this.grid[r];
      const existingSgr = this.sgrGrid[r];
      if (!existing || !existingSgr) {
        resized.push(this.emptyRow(cols));
        resizedSgr.push(this.emptySgrRow(cols));
        continue;
      }
      if (existing.length === cols) {
        resized.push(existing);
        resizedSgr.push(existingSgr);
      } else if (existing.length < cols) {
        resized.push(existing.concat(this.emptyRow(cols - existing.length)));
        resizedSgr.push(existingSgr.concat(this.emptySgrRow(cols - existingSgr.length)));
      } else {
        const sliced = existing.slice(0, cols);
        const slicedSgr = existingSgr.slice(0, cols);
        // If shrinking cut right between a wide character and its continuation cell, clear the orphaned half.
        if (existing[cols] === '' && cols > 0) {
          sliced[cols - 1] = ' ';
          slicedSgr[cols - 1] = '';
        }
        resized.push(sliced);
        resizedSgr.push(slicedSgr);
      }
    }
    this.grid = resized;
    this.sgrGrid = resizedSgr;
    this.columns = cols;
    this.rows = rows;
    this.row = clamp(this.row, 0, rows - 1);
    this.col = clamp(this.col, 0, cols - 1);
    this.savedRow = clamp(this.savedRow, 0, rows - 1);
    this.savedCol = clamp(this.savedCol, 0, cols - 1);
    this.pendingWrap = false;
  }

  write(chunk: string | Uint8Array): void {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, {stream: true});
    if (!text) return;
    if (this.pendingHighSurrogate) {
      text = this.pendingHighSurrogate + text;
      this.pendingHighSurrogate = '';
    }
    const lastCode = text.charCodeAt(text.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      this.pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    let i = 0;
    while (i < text.length) {
      if (this.state !== 'normal') {
        const cp = text.codePointAt(i)!;
        const step = cp > 0xffff ? 2 : 1;
        this.consumeChar(text.slice(i, i + step));
        i += step;
        continue;
      }
      const code = text.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) {
        this.consumeNormal(text[i]!);
        i += 1;
        continue;
      }
      let runEnd = i + 1;
      while (runEnd < text.length) {
        const nextCode = text.charCodeAt(runEnd);
        if (nextCode < 0x20 || nextCode === 0x7f) break;
        runEnd++;
      }
      const run = text.slice(i, runEnd);
      for (const {segment} of GRAPHEME_SEGMENTER.segment(run)) {
        this.writeGrapheme(segment);
      }
      i = runEnd;
    }
  }

  lines(): string[] {
    return this.grid.map(cells => cells.join('').trimEnd());
  }

  cellRangeText(row0: number, start0: number, end0: number): HighlightSpan {
    const r = clamp(row0, 0, this.rows - 1);
    const cells = this.grid[r];
    if (!cells) return {colStart0: 0, colEnd0: 0, text: ''};
    let s = clamp(start0, 0, this.columns - 1);
    let e = clamp(end0, 0, this.columns - 1);
    if (s > e) {
      const tmp = s;
      s = e;
      e = tmp;
    }
    if (s > 0 && cells[s] === '') s -= 1;
    if (e + 1 < this.columns && cells[e + 1] === '') e += 1;
    return {colStart0: s, colEnd0: e, text: cells.slice(s, e + 1).join('')};
  }

  renderRangeAnsi(
    row0: number,
    start0: number,
    end0: number,
    reverse = false,
  ): {colStart0: number; colEnd0: number; ansi: string} {
    const r = clamp(row0, 0, this.rows - 1);
    const cells = this.grid[r];
    const sgrs = this.sgrGrid[r];
    if (!cells || !sgrs) return {colStart0: 0, colEnd0: 0, ansi: ''};
    let s = clamp(start0, 0, this.columns - 1);
    let e = clamp(end0, 0, this.columns - 1);
    if (s > e) {
      const tmp = s;
      s = e;
      e = tmp;
    }
    if (s > 0 && cells[s] === '') s -= 1;
    if (e + 1 < this.columns && cells[e + 1] === '') e += 1;

    let out = '';
    let activeSgr: string | undefined;
    for (let c = s; c <= e; c++) {
      const ch = cells[c];
      if (ch === '') continue;
      const cellSgr = sgrs[c] ?? '';
      if (cellSgr !== activeSgr) {
        if (reverse && activeSgr === undefined && cellSgr === '') {
          out += '\x1b[7m';
        } else {
          out += `\x1b[0m${cellSgr}${reverse ? '\x1b[7m' : ''}`;
        }
        activeSgr = cellSgr;
      }
      out += ch ?? ' ';
    }
    if (out) out += '\x1b[0m';
    return {colStart0: s, colEnd0: e, ansi: out};
  }

  extract(start: ScreenPoint, end: ScreenPoint): string {
    const {fromRow, fromCol, toRow, toCol} = normalizePoints(start, end, this.columns, this.rows);
    const extracted: string[] = [];
    for (let r = fromRow; r <= toRow; r++) {
      const cells = this.grid[r];
      if (!cells) continue;
      let colStart = r === fromRow ? fromCol : 0;
      const colEnd = r === toRow ? toCol : this.columns - 1;
      if (colStart > 0 && cells[colStart] === '') colStart -= 1;
      extracted.push(
        cells
          .slice(colStart, colEnd + 1)
          .join('')
          .trimEnd(),
      );
    }
    while (extracted.length > 0 && extracted[0] === '') extracted.shift();
    while (extracted.length > 0 && extracted[extracted.length - 1] === '') extracted.pop();
    return extracted.join('\n');
  }

  private emptyRow(cols = this.columns): string[] {
    return Array.from({length: cols}, () => ' ');
  }

  private emptySgrRow(cols = this.columns): string[] {
    return Array.from({length: cols}, () => '');
  }

  private clearScreen(): void {
    this.grid = Array.from({length: this.rows}, () => this.emptyRow());
    this.sgrGrid = Array.from({length: this.rows}, () => this.emptySgrRow());
  }

  private resetScreen(): void {
    this.clearScreen();
    this.currentSgr = '';
    this.row = 0;
    this.col = 0;
    this.savedRow = 0;
    this.savedCol = 0;
    this.pendingWrap = false;
  }

  private lineFeed(): void {
    if (this.row + 1 < this.rows) {
      this.row += 1;
    } else {
      this.grid.shift();
      this.grid.push(this.emptyRow());
      this.sgrGrid.shift();
      this.sgrGrid.push(this.emptySgrRow());
    }
    this.pendingWrap = false;
  }

  private reverseIndex(): void {
    if (this.row > 0) {
      this.row -= 1;
    } else {
      this.grid.pop();
      this.grid.unshift(this.emptyRow());
      this.sgrGrid.pop();
      this.sgrGrid.unshift(this.emptySgrRow());
    }
    this.pendingWrap = false;
  }

  private clearHalfWideAt(r: number, c: number): void {
    const cells = this.grid[r];
    const sgrs = this.sgrGrid[r];
    if (!cells || !sgrs) return;
    if (cells[c] === '' && c > 0) {
      cells[c - 1] = ' ';
      cells[c] = ' ';
      sgrs[c - 1] = '';
      sgrs[c] = '';
    } else if (c + 1 < this.columns && cells[c + 1] === '') {
      cells[c] = ' ';
      cells[c + 1] = ' ';
      sgrs[c] = '';
      sgrs[c + 1] = '';
    }
  }

  private clearRange(r: number, startCol: number, endColExclusive: number): void {
    const cells = this.grid[r];
    const sgrs = this.sgrGrid[r];
    if (!cells || !sgrs) return;
    const from = Math.max(0, startCol);
    const to = Math.min(this.columns, endColExclusive);
    if (from >= to) return;
    this.clearHalfWideAt(r, from);
    this.clearHalfWideAt(r, to - 1);
    for (let c = from; c < to; c++) {
      cells[c] = ' ';
      sgrs[c] = '';
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.clearRange(this.row, this.col, this.columns);
      for (let r = this.row + 1; r < this.rows; r++) {
        this.grid[r] = this.emptyRow();
        this.sgrGrid[r] = this.emptySgrRow();
      }
    } else if (mode === 1) {
      for (let r = 0; r < this.row; r++) {
        this.grid[r] = this.emptyRow();
        this.sgrGrid[r] = this.emptySgrRow();
      }
      this.clearRange(this.row, 0, this.col + 1);
    } else if (mode === 2 || mode === 3) {
      this.clearScreen();
    }
  }

  private eraseLine(mode: number): void {
    if (mode === 0) {
      this.clearRange(this.row, this.col, this.columns);
    } else if (mode === 1) {
      this.clearRange(this.row, 0, this.col + 1);
    } else if (mode === 2) {
      this.grid[this.row] = this.emptyRow();
      this.sgrGrid[this.row] = this.emptySgrRow();
    }
  }

  private insertLines(count: number): void {
    const available = this.rows - this.row;
    const n = Math.min(count, available);
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.row, 0, this.emptyRow());
      this.grid.pop();
      this.sgrGrid.splice(this.row, 0, this.emptySgrRow());
      this.sgrGrid.pop();
    }
    this.col = 0;
    this.pendingWrap = false;
  }

  private deleteLines(count: number): void {
    const available = this.rows - this.row;
    const n = Math.min(count, available);
    if (n <= 0) return;
    this.grid.splice(this.row, n);
    this.sgrGrid.splice(this.row, n);
    for (let i = 0; i < n; i++) {
      this.grid.push(this.emptyRow());
      this.sgrGrid.push(this.emptySgrRow());
    }
    this.col = 0;
    this.pendingWrap = false;
  }

  private consumeChar(ch: string): void {
    if (this.state === 'normal') {
      this.consumeNormal(ch);
      return;
    }
    if (this.state === 'esc') {
      this.consumeEscape(ch);
      return;
    }
    if (this.state === 'esc-ignore-one') {
      this.state = 'normal';
      return;
    }
    if (this.state === 'csi') {
      this.consumeCsi(ch);
      return;
    }
    this.consumeStringTerminator(ch, this.state === 'osc');
  }

  private consumeNormal(ch: string): void {
    const code = ch.charCodeAt(0);
    if (ch === '\x1b') {
      this.state = 'esc';
      return;
    }
    if (ch === '\r') {
      this.col = 0;
      this.pendingWrap = false;
      return;
    }
    if (ch === '\n' || ch === '\x0b' || ch === '\x0c') {
      this.lineFeed();
      return;
    }
    if (ch === '\b') {
      this.pendingWrap = false;
      if (this.col > 0) this.col -= 1;
      return;
    }
    if (ch === '\t') {
      this.pendingWrap = false;
      this.col = Math.min(this.columns - 1, ((this.col >> 3) + 1) << 3);
      return;
    }
    if (code < 0x20 || code === 0x7f) return;
    this.writeGrapheme(ch);
  }

  private consumeEscape(ch: string): void {
    if (ch === '[') {
      this.state = 'csi';
      this.csiBuffer = '';
      return;
    }
    if (ch === ']') {
      this.state = 'osc';
      this.stringEscape = false;
      this.stringLength = 0;
      return;
    }
    if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') {
      this.state = 'dcs';
      this.stringEscape = false;
      this.stringLength = 0;
      return;
    }
    this.state = 'normal';
    if (ch === '7') {
      this.savedRow = this.row;
      this.savedCol = this.col;
    } else if (ch === '8') {
      this.row = clamp(this.savedRow, 0, this.rows - 1);
      this.col = clamp(this.savedCol, 0, this.columns - 1);
      this.pendingWrap = false;
    } else if (ch === 'c') {
      this.resetScreen();
    } else if (ch === 'D') {
      this.lineFeed();
    } else if (ch === 'M') {
      this.reverseIndex();
    } else if (ch === 'E') {
      this.col = 0;
      this.lineFeed();
    } else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#' || ch === ' ') {
      this.state = 'esc-ignore-one';
    }
  }

  private consumeCsi(ch: string): void {
    const code = ch.charCodeAt(0);
    if (ch === '\x1b') {
      this.state = 'esc';
      this.csiBuffer = '';
      return;
    }
    if (code < 0x20) {
      if (ch === '\r') {
        this.col = 0;
        this.pendingWrap = false;
      } else if (ch === '\n' || ch === '\x0b' || ch === '\x0c') {
        this.lineFeed();
      } else if (ch === '\b' && this.col > 0) {
        this.pendingWrap = false;
        this.col -= 1;
      }
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      const raw = this.csiBuffer;
      this.csiBuffer = '';
      this.state = 'normal';
      this.handleCsi(raw, ch);
      return;
    }
    if (this.csiBuffer.length >= MAX_CSI_LENGTH) {
      this.csiBuffer = '';
      this.state = 'normal';
      return;
    }
    this.csiBuffer += ch;
  }

  private consumeStringTerminator(ch: string, allowBel: boolean): void {
    this.stringLength += 1;
    if (this.stringEscape) {
      this.stringEscape = false;
      if (ch === '\\') {
        this.state = 'normal';
        return;
      }
    }
    if (allowBel && ch === '\x07') {
      this.state = 'normal';
      return;
    }
    if (ch === '\x1b') {
      this.stringEscape = true;
      return;
    }
    if (this.stringLength >= MAX_STRING_LENGTH) {
      this.state = 'normal';
      this.stringEscape = false;
    }
  }

  private handleCsi(raw: string, final: string): void {
    let prefix = '';
    let idx = 0;
    const first = raw[0];
    if (first === '?' || first === '>' || first === '<' || first === '=') {
      prefix = first;
      idx = 1;
    }
    let end = raw.length;
    while (end > idx) {
      const code = raw.charCodeAt(end - 1);
      if (code >= 0x20 && code <= 0x2f) end -= 1;
      else break;
    }
    const hasIntermediate = end < raw.length;
    const body = raw.slice(idx, end);
    const parts = body.length > 0 ? body.split(';') : [];

    if (prefix === '?' && !hasIntermediate && (final === 'h' || final === 'l')) {
      if (parts.includes('1049') || parts.includes('1047') || parts.includes('47')) {
        this.resetScreen();
      }
      return;
    }
    if (prefix !== '' || hasIntermediate) return;

    const parseNum = (i: number): number | undefined => {
      const part = parts[i];
      if (!part) return undefined;
      const colon = part.indexOf(':');
      const head = colon >= 0 ? part.slice(0, colon) : part;
      if (!head) return undefined;
      const parsed = Number.parseInt(head, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };
    const p1 = (i = 0, fallback = 1): number => {
      const val = parseNum(i);
      return val && val > 0 ? val : fallback;
    };
    const p0 = (i = 0, fallback = 0): number => parseNum(i) ?? fallback;

    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - p1());
        this.pendingWrap = false;
        break;
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + p1());
        this.pendingWrap = false;
        break;
      case 'C':
        this.col = Math.min(this.columns - 1, this.col + p1());
        this.pendingWrap = false;
        break;
      case 'D':
        this.col = Math.max(0, this.col - p1());
        this.pendingWrap = false;
        break;
      case 'E':
        this.row = Math.min(this.rows - 1, this.row + p1());
        this.col = 0;
        this.pendingWrap = false;
        break;
      case 'F':
        this.row = Math.max(0, this.row - p1());
        this.col = 0;
        this.pendingWrap = false;
        break;
      case 'G':
      case '`':
        this.col = clamp(p1() - 1, 0, this.columns - 1);
        this.pendingWrap = false;
        break;
      case 'H':
      case 'f':
        this.row = clamp(p1(0) - 1, 0, this.rows - 1);
        this.col = clamp(p1(1) - 1, 0, this.columns - 1);
        this.pendingWrap = false;
        break;
      case 'd':
        this.row = clamp(p1() - 1, 0, this.rows - 1);
        this.pendingWrap = false;
        break;
      case 's':
        this.savedRow = this.row;
        this.savedCol = this.col;
        break;
      case 'u':
        this.row = clamp(this.savedRow, 0, this.rows - 1);
        this.col = clamp(this.savedCol, 0, this.columns - 1);
        this.pendingWrap = false;
        break;
      case 'J':
        this.eraseDisplay(p0());
        break;
      case 'K':
        this.eraseLine(p0());
        break;
      case 'X':
        this.clearRange(this.row, this.col, this.col + p1());
        break;
      case 'L':
        this.insertLines(p1());
        break;
      case 'M':
        this.deleteLines(p1());
        break;
      case 'm':
        this.currentSgr = applySgrBody(this.currentSgr, body);
        break;
      default:
        break;
    }
  }

  private writeGrapheme(grapheme: string): void {
    const cells = this.grid[this.row];
    const sgrs = this.sgrGrid[this.row];
    if (!cells || !sgrs) return;

    // Cross-chunk grapheme continuations (combining marks, VS16, skin tones, ZWJ sequences, regional indicator pairs).
    const prevColRaw = this.pendingWrap ? this.col : this.col - 1;
    let prevCol = prevColRaw;
    if (prevCol > 0 && cells[prevCol] === '') prevCol -= 1;
    const prevText = prevCol >= 0 && prevCol < this.columns ? cells[prevCol] : undefined;
    const width = Bun.stringWidth(grapheme);
    const shouldMerge =
      prevText !== undefined &&
      (width === 0 ||
        isContinuationStarter(grapheme) ||
        prevText.endsWith('\u200d') ||
        (isSingleRegionalIndicator(prevText) && isSingleRegionalIndicator(grapheme)));

    if (shouldMerge && prevText !== undefined) {
      const oldSpan = prevCol + 1 < this.columns && cells[prevCol + 1] === '' ? 2 : 1;
      const merged = prevText + grapheme;
      const newWidth = Math.min(2, Math.max(1, Bun.stringWidth(merged)));
      cells[prevCol] = merged;
      if (oldSpan === 1 && newWidth === 2 && prevCol + 1 < this.columns) {
        this.clearHalfWideAt(this.row, prevCol + 1);
        cells[prevCol + 1] = '';
        sgrs[prevCol + 1] = sgrs[prevCol] ?? '';
        if (prevCol + 2 >= this.columns) {
          this.col = this.columns - 1;
          this.pendingWrap = true;
        } else {
          this.col = prevCol + 2;
          this.pendingWrap = false;
        }
      }
      return;
    }

    if (width >= 2) {
      if (this.pendingWrap) {
        this.col = 0;
        this.lineFeed();
      }
      if (this.col + 2 > this.columns && this.columns >= 2) {
        this.clearHalfWideAt(this.row, this.col);
        this.col = 0;
        this.lineFeed();
      }
      const rowCells = this.grid[this.row];
      const rowSgrs = this.sgrGrid[this.row];
      if (!rowCells || !rowSgrs) return;
      if (this.columns < 2) {
        rowCells[0] = grapheme;
        rowSgrs[0] = this.currentSgr;
        this.col = 0;
        this.pendingWrap = true;
        return;
      }
      this.clearHalfWideAt(this.row, this.col);
      this.clearHalfWideAt(this.row, this.col + 1);
      rowCells[this.col] = grapheme;
      rowCells[this.col + 1] = '';
      rowSgrs[this.col] = this.currentSgr;
      rowSgrs[this.col + 1] = this.currentSgr;
      if (this.col + 2 >= this.columns) {
        this.col = this.columns - 1;
        this.pendingWrap = true;
      } else {
        this.col += 2;
        this.pendingWrap = false;
      }
      return;
    }

    if (this.pendingWrap) {
      this.col = 0;
      this.lineFeed();
    }
    const rowCells = this.grid[this.row];
    const rowSgrs = this.sgrGrid[this.row];
    if (!rowCells || !rowSgrs) return;
    this.clearHalfWideAt(this.row, this.col);
    rowCells[this.col] = grapheme;
    rowSgrs[this.col] = this.currentSgr;
    if (this.col + 1 >= this.columns) {
      this.col = this.columns - 1;
      this.pendingWrap = true;
    } else {
      this.col += 1;
      this.pendingWrap = false;
    }
  }
}

/**
 * Intercepts Ink stdout writes into a 2D virtual terminal screen, draws reverse-video drag overlays on TTYs,
 * and copies extracted text to the clipboard on drag release.
 */
export function createScreenSelectionBridge(options: ScreenSelectionOptions): ScreenSelectionBridge {
  const screen = new VirtualScreen(options.stdout.columns || 80, options.stdout.rows || 24);
  const highlightedLines = new Map<number, HighlightSpan>();
  let anchor: ScreenPoint | null = null;
  let focus: ScreenPoint | null = null;
  let moved = false;
  let disposed = false;

  const computeSelectionSpans = (start: ScreenPoint, end: ScreenPoint): Map<number, HighlightSpan> => {
    const {fromRow, fromCol, toRow, toCol} = normalizePoints(start, end, screen.columns, screen.rows);
    const spans = new Map<number, HighlightSpan>();
    for (let r = fromRow; r <= toRow; r++) {
      const start0 = r === fromRow ? fromCol : 0;
      const end0 = r === toRow ? toCol : screen.columns - 1;
      spans.set(r + 1, screen.cellRangeText(r, start0, end0));
    }
    return spans;
  };

  const renderHighlight = () => {
    if (!options.stdout.isTTY || disposed || !anchor || !focus || !moved) return;
    if (screen.inEscapeSequence) return;
    const nextSpans = computeSelectionSpans(anchor, focus);
    let out = '\x1b7';
    for (const [row1, prev] of highlightedLines) {
      const next = nextSpans.get(row1);
      if (!next) {
        const restored = screen.renderRangeAnsi(row1 - 1, prev.colStart0, prev.colEnd0, false);
        out += `\x1b[${row1};${restored.colStart0 + 1}H${restored.ansi}`;
        continue;
      }
      if (prev.colStart0 < next.colStart0) {
        const left = screen.renderRangeAnsi(
          row1 - 1,
          prev.colStart0,
          Math.min(prev.colEnd0, next.colStart0 - 1),
          false,
        );
        out += `\x1b[${row1};${left.colStart0 + 1}H${left.ansi}`;
      }
      if (prev.colEnd0 > next.colEnd0) {
        const right = screen.renderRangeAnsi(row1 - 1, Math.max(prev.colStart0, next.colEnd0 + 1), prev.colEnd0, false);
        out += `\x1b[${row1};${right.colStart0 + 1}H${right.ansi}`;
      }
    }
    for (const [row1, next] of nextSpans) {
      const highlighted = screen.renderRangeAnsi(row1 - 1, next.colStart0, next.colEnd0, true);
      out += `\x1b[${row1};${highlighted.colStart0 + 1}H${highlighted.ansi}`;
    }
    out += '\x1b8';
    highlightedLines.clear();
    for (const [row1, span] of nextSpans) highlightedLines.set(row1, span);
    options.stdout.write(out);
  };

  const clearHighlight = () => {
    if (highlightedLines.size === 0) return;
    if (options.stdout.isTTY) {
      let out = '\x1b7';
      for (const [row1, prev] of highlightedLines) {
        const restored = screen.renderRangeAnsi(row1 - 1, prev.colStart0, prev.colEnd0, false);
        out += `\x1b[${row1};${restored.colStart0 + 1}H${restored.ansi}`;
      }
      out += '\x1b8';
      options.stdout.write(out);
    }
    highlightedLines.clear();
  };

  const onResize = () => {
    if (disposed) return;
    screen.resize(options.stdout.columns || 80, options.stdout.rows || 24);
    highlightedLines.clear();
    if (anchor) {
      anchor = {column: clamp(anchor.column, 1, screen.columns), row: clamp(anchor.row, 1, screen.rows)};
    }
    if (focus) {
      focus = {column: clamp(focus.column, 1, screen.columns), row: clamp(focus.row, 1, screen.rows)};
    }
  };
  if (typeof options.stdout.on === 'function') {
    options.stdout.on('resize', onResize);
  }

  const handleSelection = (event: TerminalSelectionEvent) => {
    if (disposed) return;
    if (event.phase === 'start') {
      clearHighlight();
      anchor = {column: event.column, row: event.row};
      focus = {column: event.column, row: event.row};
      moved = false;
      return;
    }
    if (event.phase === 'move') {
      if (!anchor) {
        anchor = {column: event.column, row: event.row};
        focus = {column: event.column, row: event.row};
        return;
      }
      if (!moved && (event.column !== anchor.column || event.row !== anchor.row)) {
        moved = true;
      }
      focus = {column: event.column, row: event.row};
      if (moved) renderHighlight();
      return;
    }
    if (!anchor) return;
    if (!moved && (event.column !== anchor.column || event.row !== anchor.row)) {
      moved = true;
    }
    const start = anchor;
    const end = {column: event.column, row: event.row};
    const wasMoved = moved;
    anchor = null;
    focus = null;
    moved = false;
    clearHighlight();
    if (!wasMoved) return;
    const text = screen.extract(start, end);
    if (text.trim().length === 0) return;
    void Promise.resolve()
      .then(() => options.copyText(text))
      .then(ok => {
        if (ok && !disposed) options.mouse.notifyCopied?.(text);
      })
      .catch(() => {});
  };

  const handleSelectionReset = () => {
    if (disposed) return;
    anchor = null;
    focus = null;
    moved = false;
    clearHighlight();
  };

  const unsubscribeSelection = options.mouse.subscribeSelection?.(handleSelection);
  const unsubscribeSelectionReset = options.mouse.subscribeSelectionReset?.(handleSelectionReset);

  const stdout = new Proxy(options.stdout, {
    get(target, property) {
      if (property === 'write') {
        return (...args: unknown[]) => {
          const chunk = args[0];
          if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
            screen.write(chunk);
          }
          const result = Reflect.apply(target.write, target, args);
          if (anchor && focus && moved) {
            renderHighlight();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    stdout,
    lines: () => screen.lines(),
    extract: (start, end) => screen.extract(start, end),
    dispose() {
      if (disposed) return;
      anchor = null;
      focus = null;
      moved = false;
      clearHighlight();
      disposed = true;
      unsubscribeSelection?.();
      unsubscribeSelectionReset?.();
      if (typeof options.stdout.off === 'function') {
        options.stdout.off('resize', onResize);
      } else if (typeof options.stdout.removeListener === 'function') {
        options.stdout.removeListener('resize', onResize);
      }
    },
  };
}
