import type { BorderStyle, ThemeTokens } from '@hannes/contracts';
import { Modal, clampIndex, windowTrailing, type RenderedBoxLine } from '../../ui';
import { filterPaletteCommands } from './logic';
import type { CommandPaletteState } from './types';

export function renderCommandPaletteOverlay(options: {
  width: number;
  height: number;
  state: CommandPaletteState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, state, tokens, borderStyle } = options;
  const modal = new Modal({ width, height, tokens, borderStyle, minInner: 30 });
  const matches = filterPaletteCommands(state.query);
  modal.top(` COMMAND PALETTE (${matches.length}) `, ' Enter Execute · Esc Close ');
  modal.input(` ❯ ${state.query}█`, true);

  const maxRows = Math.max(4, height - 4);
  const selectedIndex = clampIndex(state.selectedIndex, matches.length);
  const start = windowTrailing(selectedIndex, maxRows);
  matches.slice(start, start + maxRows).forEach((cmd, idx) => {
    const selected = start + idx === selectedIndex;
    const rowBg = selected ? tokens.selection : modal.bg;
    const rowFg = selected ? tokens.selectionForeground : tokens.foreground;
    const left = ` ${selected ? '▸' : ' '} ${cmd.title.padEnd(26, ' ')} ${cmd.command.padEnd(13, ' ')} `;
    const right = cmd.shortcut ? ` [${cmd.shortcut}] ` : ' ';
    const descMax = Math.max(0, modal.innerWidth - left.length - right.length);
    modal.spans([
      { text: left, fg: selected ? tokens.accent : rowFg, bg: rowBg, bold: selected },
      { text: cmd.description.slice(0, descMax).padEnd(descMax, ' '), fg: selected ? rowFg : tokens.foregroundMuted, bg: rowBg },
      { text: right, fg: tokens.info, bg: rowBg },
    ]);
  });

  return modal.fill().bottom(' ↑/↓ Navigate · Enter Run Command · Type to Filter · Esc Close ').lines;
}
