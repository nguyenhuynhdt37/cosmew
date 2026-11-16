import {expect, test} from 'bun:test';
import {deriveTokensFromTriplet} from '../../apps/tui/src/theme/presets';
import {renderTranscriptViewport} from '../../apps/tui/src/features/transcript/view';
import {transcriptFixture} from '../performance/tui-fixture';
import {TranscriptLayout} from '../../apps/tui/src/features/transcript/layout';
import {renderTranscriptMessages} from '../../apps/tui/src/features/transcript/view';

const tokens = deriveTokensFromTriplet('#faf9f5', '#262624', '#a85236');
test('one composer frame must not reformat unchanged history', () => {
  const items = transcriptFixture(1000);
  const options = {
    items,
    width: 120,
    height: 32,
    scrollOffset: -1,
    tokens,
    borderStyle: 'rounded' as const,
    syntaxHighlighting: true,
  };
  renderTranscriptViewport(options);
  // Getter proves repeated parsing without relying on wall-clock timing.
  let reads = 0;
  const original = items[0]!.content;
  Object.defineProperty(items[0], 'content', {
    get() {
      reads++;
      return original;
    },
  });
  renderTranscriptViewport(options);
  expect(reads).toBe(0);
});

test('indexed rows equal canonical full rendering across widths and cache eviction', () => {
  const items = transcriptFixture(100);
  items[1]!.reasoningExpanded = true;
  items[3]!.expandedActivities = ['tools:call3'];
  const layout = new TranscriptLayout(4, 100_000);
  for (const width of [120, 53, 24, 90]) {
    const options = {
      items,
      width,
      height: 12,
      scrollOffset: 0,
      tokens,
      borderStyle: 'rounded' as const,
      syntaxHighlighting: true,
      layout,
    };
    const expected = renderTranscriptMessages({...options, width: Math.max(16, width - 2)});
    const vp = layout.viewport(options);
    expect(vp.totalLines).toBe(expected.length);
    for (let offset = 0; offset < expected.length; offset += 11)
      expect(layout.rows(offset, 12)).toEqual(expected.slice(offset, offset + 12));
    expect(layout.cacheStats.entries).toBeLessThanOrEqual(4);
    expect(layout.cacheStats.weight).toBeLessThanOrEqual(100_000);
  }
});

test('streaming updates only dirty messages, keeps reading anchor and follows bottom on request', () => {
  let items = transcriptFixture(1000);
  const layout = new TranscriptLayout();
  const view = (scrollOffset: number, width = 120) =>
    layout.viewport({items, width, height: 20, scrollOffset, tokens, borderStyle: 'rounded', syntaxHighlighting: true});
  const top = view(150);
  const anchor = top.visibleLines;
  const before = layout.metrics.messagesLaidOut;
  const tail = items.at(-1)!;
  tail.content += '\nNew output\n'.repeat(50);
  layout.invalidate(tail.id);
  const next = view(top.clampedOffset);
  expect(next.visibleLines).toEqual(anchor);
  expect(next.newOutput).toBe(true);
  expect(layout.metrics.messagesLaidOut - before).toBeLessThan(10);
  // Expansion before the anchor changes offsets, not the message being read.
  items[1]!.reasoningExpanded = true;
  layout.invalidate(items[1]!.id);
  const expanded = view(next.clampedOffset);
  expect(expanded.clampedOffset).toBeGreaterThan(next.clampedOffset);
  expect(expanded.visibleLines).toEqual(anchor);
  // Appending while reading does not jump to bottom.
  items = [...items, {id: 'new', role: 'user', content: 'new prompt'}];
  expect(view(expanded.clampedOffset).visibleLines).toEqual(anchor);
  const bottom = view(-1);
  expect(bottom.clampedOffset).toBe(bottom.totalLines - 20);
  expect(bottom.newOutput).toBe(false);
});

test('selection freezes history lazily while source messages stream and cache stays bounded', () => {
  const items = transcriptFixture(100);
  const layout = new TranscriptLayout(5, 200_000);
  layout.viewport({
    items,
    width: 100,
    height: 20,
    scrollOffset: -1,
    tokens,
    borderStyle: 'rounded',
    syntaxHighlighting: true,
  });
  const frozen = layout.freeze();
  const original = frozen.readRows(frozen.totalLines - 20, 20);
  items.at(-1)!.content = 'Changed after selection';
  layout.invalidate(items.at(-1)!.id);
  layout.viewport({
    items,
    width: 100,
    height: 20,
    scrollOffset: -1,
    tokens,
    borderStyle: 'rounded',
    syntaxHighlighting: true,
  });
  expect(frozen.readRows(frozen.totalLines - 20, 20)).toEqual(original);
  expect(layout.cacheStats.entries).toBeLessThanOrEqual(5);
});

test('resizing preserves a message anchor and theme changes invalidate colors without changing history', () => {
  const items = transcriptFixture(100);
  const layout = new TranscriptLayout();
  const view = (width: number, scrollOffset: number, theme = tokens) =>
    layout.viewport({
      items,
      width,
      height: 12,
      scrollOffset,
      tokens: theme,
      borderStyle: 'rounded',
      syntaxHighlighting: true,
    });
  view(120, 0);
  // Start exactly on a stable user prompt, independent of wrapping inside the preceding answer.
  const full = renderTranscriptMessages({items: items.slice(0, 20), width: 118, tokens, borderStyle: 'rounded'});
  const first = view(120, full.length);
  const resized = view(60, first.clampedOffset);
  expect(resized.visibleLines[1]!.spans.map(s => s.text).join('')).toContain('Inspect module 20');
  const dark = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
  const themed = view(60, resized.clampedOffset, dark);
  expect(themed.visibleLines[1]!.spans[0]!.fg).toBe(dark.foregroundMuted);
  expect(items).toHaveLength(100);
});

test('expanded command output exposes every retained result row, including rows beyond 1000', () => {
  const items = transcriptFixture(2);
  const tail = items[1]!;
  tail.expandedActivities = ['tools:call1'];
  tail.toolResults![0]!.content = Array.from({length: 1200}, (_, i) => `output row ${i}`).join('\n');
  const layout = new TranscriptLayout();
  layout.viewport({
    items,
    width: 120,
    height: 20,
    scrollOffset: -1,
    tokens,
    borderStyle: 'rounded',
    syntaxHighlighting: true,
  });
  const text = layout
    .rows(0, layout.totalLines)
    .flatMap(line => line.spans.map(s => s.text))
    .join('\n');
  expect(text).toContain('output row 1199');
  expect(tail.toolResults![0]!.content).toContain('output row 1199');
});
