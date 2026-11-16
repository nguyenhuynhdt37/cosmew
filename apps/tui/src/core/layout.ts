import type {OverlayLayout} from './feature';

/** Wide dialog filling most of the terminal; the default for list-style overlays. */
export function wideLayout(cols: number, rows: number, backdrop = false): OverlayLayout {
  return {
    width: Math.min(cols - 2, Math.max(44, Math.floor(cols * 0.86))),
    height: Math.min(rows - 2, Math.max(12, Math.floor(rows * 0.82))),
    backdrop,
  };
}
