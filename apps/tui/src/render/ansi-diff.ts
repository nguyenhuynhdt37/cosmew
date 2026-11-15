import { bgHex, fgHex, type TerminalColorCapability } from '../theme/theme';
import type { FrameCell } from '../types';

/** Diff `cells` against `prev` and return the minimal ANSI to repaint changed rows. */
export function renderAnsiDiff(cells: FrameCell[][], rows: number, cap: TerminalColorCapability, prev: FrameCell[][] | null): string {
    let out = '';

    for (let y = 0; y < rows; y++) {
      const row = cells[y]!;
      const prevRow = prev?.[y];
      let rowChanged = !prevRow || prevRow.length !== row.length;
      if (!rowChanged && prevRow) {
        for (let x = 0; x < row.length; x++) {
          const a = row[x]!;
          const b = prevRow[x]!;
          if (a.ch !== b.ch || a.fg !== b.fg || a.bg !== b.bg || a.bold !== b.bold || a.selected !== b.selected) {
            rowChanged = true;
            break;
          }
        }
      }
      if (!rowChanged) continue;

      out += `\x1b[${y + 1};1H`;
      let curFg = '';
      let curBg = '';
      let curBold = false;
      let curSelected = false;

      for (let x = 0; x < row.length; x++) {
        const cell = row[x]!;
        if (cap === 'none' && Boolean(cell.selected) !== curSelected) {
          out += cell.selected ? '\x1b[7m' : '\x1b[27m'; curSelected = Boolean(cell.selected);
        }
        if (cell.bold !== curBold) {
          out += cell.bold ? '\x1b[1m' : '\x1b[22m';
          curBold = cell.bold;
        }
        if (cell.fg !== curFg) {
          out += fgHex(cell.fg, cap);
          curFg = cell.fg;
        }
        if (cell.bg !== curBg) {
          out += bgHex(cell.bg, cap);
          curBg = cell.bg;
        }
        out += cell.ch;
      }
      out += '\x1b[0m';
    }

    return out;
}
