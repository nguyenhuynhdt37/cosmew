import {useLayoutEffect, useMemo, useReducer} from 'react';
import type {DOMElement} from 'ink';
import type {TranscriptItem} from './logic';

export const TRANSCRIPT_ITEM_GAP = 1;

const OVERSCAN_ROWS = 6;
const MIN_VIRTUAL_ITEMS = 12;

function estimatedHeight(item: TranscriptItem, width: number, detailed: boolean) {
  const textRows = (text: string) => {
    let rows = 0;
    for (const line of text.slice(0, 262144).split('\n')) rows += Math.max(1, Math.ceil(line.length / width));
    return rows;
  };
  let rows = item.content ? textRows(item.content) : 0;
  if (item.streaming) rows = Math.min(rows, 24);
  if (item.context) rows += 20;
  rows += item.notices?.length ?? 0;
  for (const part of item.parts ?? []) {
    if (part.kind === 'reasoning') rows += detailed ? 2 + textRows(part.text) : 2;
    if (part.kind === 'hook' && detailed) rows += 2;
  }
  if (item.toolCalls?.length) rows += detailed ? item.toolCalls.length * 16 : 2;
  return Math.max(2, rows + 1);
}

function itemAt(offsets: readonly number[], row: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    if (offsets[mid]! <= row) low = mid;
    else high = mid;
  }
  return low;
}

/** Maintain logical rows for unmounted items, correcting estimates as their Ink boxes are measured. */
export function useTranscriptViewport(
  items: readonly TranscriptItem[],
  width: number,
  detailed: boolean,
  rows: number | undefined,
  back: number,
  anchors: ReadonlyMap<string, DOMElement>,
  highlightedId?: string,
) {
  const enabled = rows !== undefined && items.length > MIN_VIRTUAL_ITEMS;
  const caches = useMemo(
    () =>
      [false, true].map(() => ({
        heights: new WeakMap<TranscriptItem, number>(),
        estimates: new WeakMap<TranscriptItem, number>(),
      })),
    [width],
  );
  const {heights, estimates} = caches[detailed ? 1 : 0]!;
  const [revision, remeasure] = useReducer(n => n + 1, 0);
  const offsets = useMemo(() => {
    // Measured heights live on the stable item identity. A layout correction invalidates the prefix sums.
    void revision;
    if (!enabled) return [];
    const result = [0];
    for (const item of items) {
      let estimate = estimates.get(item);
      if (estimate === undefined) {
        estimate = estimatedHeight(item, width, detailed);
        estimates.set(item, estimate);
      }
      result.push(result.at(-1)! + (heights.get(item) ?? estimate));
    }
    return result;
  }, [enabled, items, width, detailed, heights, estimates, revision]);
  const total = offsets.at(-1) ?? 0;
  const bottom = Math.max(1, total - back);
  const first = enabled ? itemAt(offsets, Math.max(0, bottom - rows - OVERSCAN_ROWS)) : 0;
  const end = enabled ? itemAt(offsets, bottom + OVERSCAN_ROWS - 1) + 1 : items.length;
  const shown = useMemo(() => (enabled ? items.slice(first, end) : items), [enabled, items, first, end]);
  useLayoutEffect(() => {
    if (!enabled) return;
    let changed = false;
    for (const item of shown) {
      if (item.id === highlightedId) continue;
      const node = anchors.get(item.id)?.yogaNode;
      if (!node) continue;
      const height = node.getComputedHeight() + TRANSCRIPT_ITEM_GAP;
      const prior = heights.get(item) ?? estimates.get(item);
      heights.set(item, height);
      if (prior !== height) changed = true;
    }
    if (changed) remeasure();
  });
  return {
    enabled,
    offsets,
    shown,
    before: offsets[first] ?? 0,
    after: total - (offsets[end] ?? 0),
  };
}
