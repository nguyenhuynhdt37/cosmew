import type { BorderStyle, ThemeTokens } from '@hannes/contracts';
import { SLASH_COMMANDS } from '../composer';
import { Modal, type RenderedBoxLine } from '../../ui';

export function renderHelpOverlay(options: {
  scrollOffset?: number;
  width: number;
  height: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, tokens, borderStyle } = options;
  const modal = new Modal({ width, height, tokens, borderStyle, minInner: 30 });
  const row = (text: string, fg = tokens.foreground, bold = false) => modal.text(text, { fg, bold });

  modal.top(' KEYBOARD SHORTCUTS & SLASH COMMANDS (/help) ', ' Esc Close ');
  row(' Global Keyboard Navigation:', tokens.markdownHeading, true);
  row('   Ctrl+P       Open Command Palette           Ctrl+T       Open /theme Picker');
  row('   Ctrl+L       Open /model Picker            Ctrl+S       Open /resume Picker');
  row('   Ctrl+N       Start New Session              Ctrl+D       Open /diff Viewer');
  row('   Ctrl+B       Toggle Sidebar                 Shift+Tab    View mode only; tool modes unavailable');
  row('   /            Slash Command Autocomplete     @            Workspace File Autocomplete');
  row('   Esc          Close Dialog / Cancel Stream    Ctrl+C       Interrupt / Clear Draft / Exit');
  row('   !            Shell mode: Not implemented     Alt+Enter    Newline (also Ctrl+J)');
  row('   Mouse drag   Select text · Ctrl+C/Ctrl+Y Copy · Esc Clear · Shift+drag native selection');
  row('   Ctrl+R       Toggle reasoning summary        /model: Ctrl+E cycles active model effort');
  row('');
  row(' Slash Commands:', tokens.markdownHeading, true);
  for (const cmd of SLASH_COMMANDS) {
    row(`   ${cmd.command.padEnd(14, ' ')} ${cmd.title.padEnd(26, ' ')} ${cmd.description}`, tokens.foregroundMuted);
  }
  modal.fill().bottom(' ↑/↓ or PgUp/PgDown Scroll · Esc Close ');

  // Only the body scrolls; title and footer bars stay pinned.
  const lines = modal.lines;
  const body = lines.slice(1, -1);
  const room = Math.max(1, height - 2);
  const offset = Math.max(0, Math.min(options.scrollOffset ?? 0, Math.max(0, body.length - room)));
  return [lines[0]!, ...body.slice(offset, offset + room), lines.at(-1)!];
}
