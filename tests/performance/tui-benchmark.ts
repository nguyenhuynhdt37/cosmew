import {cpus, platform, release} from 'node:os';
import {deriveTokensFromTriplet} from '../../apps/tui/src/theme/presets';
import {renderTranscriptViewport} from '../../apps/tui/src/features/transcript/view';
import {Canvas} from '../../apps/tui/src/ui/canvas';
import {renderAnsiDiff} from '../../apps/tui/src/render/ansi-diff';
import {transcriptFixture} from './tui-fixture';

const tokens = deriveTokensFromTriplet('#faf9f5', '#262624', '#a85236');
const stats = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
};
const output: unknown[] = [];
for (const count of [100, 1000, 5000]) {
  const items = transcriptFixture(count);
  const samples: number[] = [],
    layouts: number[] = [],
    canvases: number[] = [],
    diffs: number[] = [];
  let prev: Canvas['cells'] | null = null,
    bytes = 0;
  const cpu = process.cpuUsage();
  const heap = process.memoryUsage().heapUsed;
  for (let i = 0; i < 24; i++) {
    const start = performance.now();
    const vp = renderTranscriptViewport({
      items,
      width: 120,
      height: 32,
      scrollOffset: -1,
      tokens,
      borderStyle: 'rounded',
      syntaxHighlighting: true,
    });
    const laid = performance.now();
    const canvas = new Canvas(120, 40, tokens.foreground, tokens.background);
    canvas.block(1, 0, vp.lines, 120);
    canvas.spans(36, 0, [{text: `› typing ${i}`, fg: tokens.foreground}], 120);
    const painted = performance.now();
    const ansi = renderAnsiDiff(canvas.cells, 40, 'truecolor', prev);
    const end = performance.now();
    prev = canvas.cells;
    bytes += Buffer.byteLength(ansi);
    samples.push(end - start);
    layouts.push(laid - start);
    canvases.push(painted - laid);
    diffs.push(end - painted);
  }
  output.push({
    count,
    frameMs: stats(samples),
    layoutMs: stats(layouts),
    canvasMs: stats(canvases),
    ansiDiffMs: stats(diffs),
    ansiBytes: bytes,
    cpuMicros: process.cpuUsage(cpu),
    heapDelta: process.memoryUsage().heapUsed - heap,
  });
}
console.log(
  JSON.stringify(
    {
      environment: {
        bun: Bun.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        dimensions: '120x40',
        iterations: 24,
      },
      scenarios: output,
    },
    null,
    2,
  ),
);
