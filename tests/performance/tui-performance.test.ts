import {expect, test} from 'bun:test';
import {TranscriptLayout} from '../../apps/tui/src/features/transcript/layout';
import {deriveTokensFromTriplet} from '../../apps/tui/src/theme/presets';
import {Canvas} from '../../apps/tui/src/ui/canvas';
import {renderAnsiDiff} from '../../apps/tui/src/render/ansi-diff';
import {transcriptFixture} from './tui-fixture';

test('5000-message warm frames stay bounded and never reformat history for typing', () => {
  const items = transcriptFixture(5000),
    layout = new TranscriptLayout();
  const tokens = deriveTokensFromTriplet('#faf9f5', '#262624', '#a85236');
  const options = {
    items,
    width: 120,
    height: 32,
    scrollOffset: -1,
    tokens,
    borderStyle: 'rounded' as const,
    syntaxHighlighting: true,
  };
  layout.viewport(options);
  const count = layout.metrics.messagesLaidOut,
    samples: number[] = [];
  let prev: Canvas['cells'] | null = null;
  for (let i = 0; i < 40; i++) {
    const start = performance.now(),
      vp = layout.viewport(options);
    const canvas = new Canvas(120, 40, tokens.foreground, tokens.background);
    canvas.block(0, 0, vp.lines, 120);
    canvas.spans(36, 0, [{text: `typing ${i}`, fg: tokens.foreground}]);
    renderAnsiDiff(canvas.cells, 40, 'truecolor', prev);
    prev = canvas.cells;
    samples.push(performance.now() - start);
  }
  expect(layout.metrics.messagesLaidOut - count).toBe(0);
  expect(layout.cacheStats.entries).toBeLessThanOrEqual(256);
  expect(layout.cacheStats.weight).toBeLessThanOrEqual(2_000_000);
  // Documented M1 Pro baseline; structural assertions above are independent of hardware speed.
  expect(samples.sort((a, b) => a - b)[37]!).toBeLessThan(16);
}, 15_000);
