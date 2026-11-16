import type { AppearanceConfig, ThemeTokens } from '@futryn/contracts';
import type { ReactiveAgentEvent } from '@futryn/sdk';
import type { ThemeEngine } from '../theme/theme';
import type { Canvas } from '../ui';
import type { ScreenMetrics } from './metrics';

/**
 * Paint the live wallpaper into the side gutters only. The content column stays untouched so
 * wallpaper characters can never end up inside the composer or transcript.
 */
export function paintWallpaper(canvas: Canvas, options: {
  engine: ThemeEngine;
  wallpaperId: string;
  appearance: AppearanceConfig;
  tokens: ThemeTokens;
  metrics: ScreenMetrics;
  timeSeconds: number;
  eventKind?: ReactiveAgentEvent['kind'];
}): void {
  const { engine, wallpaperId, appearance, tokens, metrics } = options;
  const { cols, rows, colLeft, colWidth } = metrics;
  const grid = engine.wallpaperEngine.renderFrame(wallpaperId, {
    cols,
    rows,
    timeSeconds: options.timeSeconds,
    config: appearance.animations,
    backgroundHex: tokens.background,
    centerColumnRange: [colLeft, colLeft + colWidth],
    eventKind: options.eventKind,
  });
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (x >= colLeft && x < colLeft + colWidth) continue;
      const wCell = grid[y]?.[x];
      if (wCell) canvas.cells[y]![x] = { ch: wCell.ch[0] ?? ' ', fg: wCell.fg, bg: wCell.bg ?? tokens.background, bold: false };
    }
  }
}
