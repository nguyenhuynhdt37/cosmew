import type {ThemeTokens} from '@futryn/contracts';
import type {RenderedBoxLine} from '../../ui';
import {gateHeight, gateRows, type GateContent} from './logic';

export interface GateLayout {
  lines: RenderedBoxLine[];
  x: number;
  y: number;
  width: number;
}

/** Centered dialog; every row is padded to the dialog width on the overlay surface. */
export function renderStartupGate(
  options: Omit<GateContent, 'width' | 'height'> & {cols: number; rows: number; tokens: ThemeTokens},
): GateLayout {
  const {cols, rows, tokens} = options;
  const width = Math.max(1, Math.min(cols - 2, 64));
  const height = Math.max(1, Math.min(rows - 1, gateHeight(options.phase)));
  const lines = gateRows({...options, width, height}).map(row => ({
    spans: [
      {text: ('  ' + row.text).slice(0, width).padEnd(width), fg: row.fg, bg: tokens.overlayBackground, bold: row.bold},
    ],
  }));
  return {
    lines,
    x: Math.max(0, Math.floor((cols - width) / 2)),
    y: Math.max(0, Math.floor((rows - height) / 2)),
    width,
  };
}
