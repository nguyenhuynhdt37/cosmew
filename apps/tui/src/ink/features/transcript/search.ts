import {safeText} from '../../ui/text-line';
import {transcriptParts, toolDisplay, type TranscriptItem} from './logic';

export type SearchIndex = string[];
export interface SearchMatch {
  itemIndex: number;
  start: number;
  end: number;
}
/** Visible body text, never terminal escape bytes or hidden tool JSON. */
export function searchableText(item: TranscriptItem): string {
  if (item.role !== 'assistant') return safeText([item.content, ...(item.notices ?? [])].join('\n'));
  const lines: string[] = [];
  for (const part of transcriptParts(item)) {
    if (part.kind === 'text' || part.kind === 'reasoning') lines.push(part.text);
    else if (part.kind === 'hook') lines.push(`${part.event.name} says: ${part.event.summary}`);
    else
      for (const id of part.callIds) {
        const call = item.toolCalls?.find(call => call.id === id);
        if (!call) continue;
        const display = toolDisplay(
          call,
          item.toolResults?.find(result => result.callId === id),
          !!item.streaming,
          true,
          item.toolOutput?.[id],
        );
        lines.push(display.title, ...display.lines);
      }
  }
  if (item.errorText) lines.push(item.errorText);
  lines.push(...(item.notices ?? []));
  return safeText(lines.join('\n'));
}
export function buildSearchIndex(items: TranscriptItem[]): SearchIndex {
  return items.map(searchableText);
}
/** A revision is warmed only on demand; bounded chunks let terminal input run between batches. */
export async function buildSearchIndexAsync(
  items: readonly TranscriptItem[],
  signal?: AbortSignal,
): Promise<SearchIndex | null> {
  const index: SearchIndex = [];
  for (let at = 0; at < items.length;) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (signal?.aborted) return null;
    const deadline = performance.now() + 4;
    let count = 0;
    do {
      index.push(searchableText(items[at++]!));
    } while (at < items.length && ++count < 32 && performance.now() < deadline);
  }
  return signal?.aborted ? null : index;
}
export function findMatches(index: SearchIndex, query: string): SearchMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  index.forEach((text, itemIndex) => {
    // Map folded UTF-16 offsets back to the original text (e.g. capital dotted I).
    let folded = '';
    const offsets: number[] = [];
    let original = 0;
    for (const character of text) {
      const lower = character.toLowerCase();
      folded += lower;
      for (let n = 0; n < lower.length; n++) offsets.push(original);
      original += character.length;
    }
    let at = 0;
    while ((at = folded.indexOf(needle, at)) >= 0) {
      const start = offsets[at]!;
      const last = offsets[at + needle.length - 1]!;
      matches.push({itemIndex, start, end: last + (text.codePointAt(last)! > 0xffff ? 2 : 1)});
      at += needle.length;
    }
  });
  return matches;
}
export function searchStatus(state: {
  building: boolean;
  ms?: number;
  query: string;
  count: number;
  current: number;
}): string | null {
  if (state.building) return 'indexing…';
  if (state.ms !== undefined) return `indexed in ${state.ms}ms`;
  if (state.count > 0) return `${state.current} of ${state.count}`;
  return state.query ? 'no matches' : null;
}

/** Query scans yield as well: changing text must never synchronously scan the entire history. */
export async function findMatchesAsync(
  index: SearchIndex,
  query: string,
  signal: AbortSignal,
): Promise<SearchMatch[] | null> {
  const matches: SearchMatch[] = [];
  if (!query) return matches;
  for (let at = 0; at < index.length; at += 16) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (signal.aborted) return null;
    matches.push(
      ...findMatches(index.slice(at, at + 16), query).map(match => ({...match, itemIndex: match.itemIndex + at})),
    );
  }
  return matches;
}
