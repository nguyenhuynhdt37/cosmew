import type {BorderStyle, ThemeTokens, ToolCall} from '@futryn/contracts';
import {textWidth} from '../../input/text';
import type {RenderedBoxLine} from '../../ui';
import type {TranscriptItem} from './types';
import {renderTranscriptMessages} from './view';

export interface TranscriptViewportOptions {
  items: TranscriptItem[];
  width: number;
  height: number;
  scrollOffset: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  syntaxHighlighting: boolean;
  compactActivities?: boolean;
  awaitingApproval?: (call: ToolCall) => boolean;
  /** Retained for a session; callers explicitly invalidate changed IDs. */
  layout?: TranscriptLayout;
}
export interface TranscriptViewportResult {
  lines: RenderedBoxLine[];
  visibleLines: RenderedBoxLine[];
  /** @deprecated Explicit full-document export. Interactive rendering never reads this getter. */
  readonly allLines: RenderedBoxLine[];
  totalLines: number;
  clampedOffset: number;
  newOutput: boolean;
}
interface Entry {
  item: TranscriptItem;
  height: number;
  revision: number;
}
interface Cached {
  revision: number;
  lines: RenderedBoxLine[];
  weight: number;
}

/** Exact prefix sums: updates and visible-message lookup are O(log messages). */
class Heights {
  private tree: number[] = [0];
  constructor(values: number[]) {
    this.tree = Array(values.length + 1).fill(0);
    values.forEach((value, index) => this.add(index, value));
  }
  add(index: number, delta: number): void {
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i]! += delta;
  }
  sum(end: number): number {
    let total = 0;
    for (let i = end; i > 0; i -= i & -i) total += this.tree[i]!;
    return total;
  }
  at(row: number): number {
    let index = 0,
      sum = 0;
    for (let bit = 2 ** Math.floor(Math.log2(Math.max(1, this.tree.length))); bit; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && sum + this.tree[next]! <= row) {
        index = next;
        sum += this.tree[next]!;
      }
    }
    return index;
  }
}

/** Owns metadata for all messages, but styled layouts for only a bounded working set. */
export class TranscriptLayout {
  private entries: Entry[] = [];
  private ids = new Map<string, number>();
  private heights = new Heights([]);
  private items: TranscriptItem[] | null = null;
  private style = '';
  private options!: TranscriptViewportOptions;
  private dirty = new Set<string>();
  private cache = new Map<string, Cached>();
  private weight = 0;
  private anchor: {id: string; row: number} | null = null;
  private lastOffset = -1;
  private unseen = false;
  private outputChanged = false;
  readonly metrics = {messagesLaidOut: 0, cacheHits: 0};
  constructor(
    readonly maxEntries = 256,
    readonly maxWeight = 2_000_000,
  ) {}
  invalidate(id: string, output = true): void {
    this.dirty.add(id);
    this.outputChanged ||= output;
  }
  invalidateAll(): void {
    for (const entry of this.entries) this.dirty.add(entry.item.id);
  }
  get cacheStats() {
    return {entries: this.cache.size, weight: this.weight};
  }
  get totalLines(): number {
    return this.heights.sum(this.entries.length);
  }

  private format(entry: Entry, index: number): RenderedBoxLine[] {
    const cached = this.cache.get(entry.item.id);
    if (cached?.revision === entry.revision) {
      this.cache.delete(entry.item.id);
      this.cache.set(entry.item.id, cached);
      this.metrics.cacheHits++;
      return cached.lines;
    }
    if (cached) {
      this.weight -= cached.weight;
      this.cache.delete(entry.item.id);
    }
    this.metrics.messagesLaidOut++;
    const lines = renderTranscriptMessages({
      ...this.options,
      width: Math.max(16, this.options.width - 2),
      items: [entry.item],
    });
    if (index && lines.length) lines.unshift({spans: []});
    const weight = lines.reduce(
      (sum, line) => sum + 32 + line.spans.reduce((n, span) => n + 64 + span.text.length * 2, 0),
      0,
    );
    // Oversized individual messages are rendered, but never defeat the cache bound.
    if (weight <= this.maxWeight && this.maxEntries > 0) {
      this.cache.set(entry.item.id, {revision: entry.revision, lines, weight});
      this.weight += weight;
      while (this.cache.size > this.maxEntries || this.weight > this.maxWeight) {
        const key = this.cache.keys().next().value!;
        this.weight -= this.cache.get(key)!.weight;
        this.cache.delete(key);
      }
    }
    return lines;
  }

  private sync(options: TranscriptViewportOptions): boolean {
    this.options = options;
    const style = JSON.stringify([
      options.width,
      options.tokens,
      options.borderStyle,
      options.syntaxHighlighting,
      options.compactActivities,
    ]);
    const restyle = style !== this.style;
    const changed = restyle || this.items !== options.items || this.dirty.size > 0;
    if (restyle) {
      this.cache.clear();
      this.weight = 0;
      this.style = style;
    }
    if (this.items !== options.items) {
      const old = this.entries;
      if (this.items && options.items.length > old.length) this.outputChanged = true;
      const append = old.length <= options.items.length && old.every((entry, i) => entry.item === options.items[i]);
      this.entries = options.items.map((item, index) =>
        append && index < old.length ? old[index]! : {item, height: 0, revision: 0},
      );
      this.ids = new Map(this.entries.map((entry, index) => [entry.item.id, index]));
      if (!append) {
        this.cache.clear();
        this.weight = 0;
        this.anchor = null;
      }
      this.items = options.items;
      this.entries.forEach((entry, index) => {
        if (restyle || !append || index >= old.length) entry.height = this.format(entry, index).length;
      });
      this.heights = new Heights(this.entries.map(entry => entry.height));
    } else if (restyle) {
      this.entries.forEach((entry, index) => {
        entry.height = this.format(entry, index).length;
      });
      this.heights = new Heights(this.entries.map(entry => entry.height));
    }
    for (const id of this.dirty) {
      const index = this.ids.get(id);
      if (index === undefined) continue;
      const entry = this.entries[index]!;
      entry.revision++;
      const height = this.format(entry, index).length;
      this.heights.add(index, height - entry.height);
      entry.height = height;
    }
    this.dirty.clear();
    return changed;
  }

  /** Only the requested rows are materialized; no full-history line array. */
  rows(offset: number, count: number): RenderedBoxLine[] {
    const result: RenderedBoxLine[] = [];
    let index = this.heights.at(offset),
      start = this.heights.sum(index);
    while (index < this.entries.length && result.length < count) {
      const entry = this.entries[index]!;
      if (entry.height)
        result.push(
          ...this.format(entry, index).slice(
            Math.max(0, offset - start),
            Math.max(0, offset - start) + count - result.length,
          ),
        );
      start += entry.height;
      index++;
    }
    return result;
  }

  viewport(options: TranscriptViewportOptions): TranscriptViewportResult {
    const changed = this.sync(options);
    const height = Math.max(0, options.height),
      totalLines = this.totalLines;
    const max = Math.max(0, totalLines - height);
    let offset = options.scrollOffset;
    // Explicit navigation wins; otherwise retain the message-relative reading anchor.
    if (offset >= 0 && offset === this.lastOffset && this.anchor && changed) {
      const index = this.ids.get(this.anchor.id);
      if (index !== undefined)
        offset = this.heights.sum(index) + Math.min(this.anchor.row, Math.max(0, this.entries[index]!.height - 1));
    }
    const clampedOffset = offset < 0 ? max : Math.max(0, Math.min(max, offset));
    const index = this.heights.at(clampedOffset);
    this.anchor =
      index < this.entries.length
        ? {id: this.entries[index]!.item.id, row: clampedOffset - this.heights.sum(index)}
        : null;
    if (offset < 0) this.unseen = false;
    else if (this.outputChanged) this.unseen = true;
    this.outputChanged = false;
    this.lastOffset = offset < 0 ? -1 : clampedOffset;
    const visibleLines = this.rows(clampedOffset, height);
    const contentWidth = Math.max(16, options.width - 2);
    const lines = Array.from({length: height}, (_, row) => {
      const line = visibleLines[row] ?? {spans: []};
      const used = line.spans.reduce((sum, span) => sum + textWidth(span.text), 0);
      return {
        ...line,
        spans: [
          ...line.spans,
          ...(totalLines > height
            ? [
                {
                  text: `${' '.repeat(Math.max(0, contentWidth - used))} ${row === Math.floor((clampedOffset / Math.max(1, max)) * (height - 1)) ? '┃' : '│'}`,
                  fg: options.tokens.scrollbar,
                  bg: options.tokens.background,
                },
              ]
            : []),
        ],
      };
    });
    const layout = this;
    return {
      lines,
      visibleLines,
      totalLines,
      clampedOffset,
      newOutput: this.unseen,
      get allLines() {
        return layout.rows(0, totalLines);
      },
    };
  }

  /** Freeze source on explicit selection, and render further rows on demand. */
  freeze(): {totalLines: number; readRows: (offset: number, count: number) => RenderedBoxLine[]} {
    const frozen = new TranscriptLayout(this.maxEntries, this.maxWeight);
    frozen.options = {...this.options, items: [], layout: undefined, awaitingApproval: undefined};
    frozen.style = this.style;
    frozen.entries = this.entries.map(entry => ({...entry, item: structuredClone(entry.item)}));
    frozen.heights = new Heights(frozen.entries.map(entry => entry.height));
    // Retain permission labels exactly as displayed; later rows need no current permission state.
    frozen.cache = new Map(this.cache);
    frozen.weight = this.weight;
    return {totalLines: frozen.totalLines, readRows: (offset, count) => frozen.rows(offset, count)};
  }
}
