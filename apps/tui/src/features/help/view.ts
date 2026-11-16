import type {BorderStyle, ThemeTokens} from '@futryn/contracts';
import {SLASH_COMMANDS} from '../composer';
import {Modal, type RenderedBoxLine} from '../../ui';

export function renderHelpOverlay(options: {
  scrollOffset?: number;
  width: number;
  height: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, tokens, borderStyle} = options;
  const modal = new Modal({width, height, tokens, borderStyle, minInner: 30});
  const row = (text: string, fg = tokens.foreground, bold = false) => modal.text(text, {fg, bold});

  modal.top(' KEYBOARD SHORTCUTS & SLASH COMMANDS (/help) ', ' Esc Close ');
  row(' Global Keyboard Navigation:', tokens.markdownHeading, true);
  row('   Ctrl+P       Open Command Palette           Ctrl+B       Toggle Sidebar');
  for (const command of SLASH_COMMANDS.filter(command => command.shortcut && command.command !== '/exit'))
    row(`   ${command.shortcut!.padEnd(13)} ${command.command.padEnd(14)} ${command.title}`);
  row('   Shift+Tab    Cycle permission mode; explicit deny rules still win');
  row('   /            Slash Command Autocomplete     @            Workspace File Autocomplete');
  row('   Esc          Close Dialog / Cancel Stream    Ctrl+C       Interrupt / Clear Draft / Exit');
  row('   !            Sandboxed shell command         Alt+Enter    Newline (also Ctrl+J)');
  row('   Mouse drag   Select text · Ctrl+C/Ctrl+Y Copy · Esc Clear · Shift+drag native selection');
  row('   Ctrl+R       Toggle reasoning summary        /model: Ctrl+E cycles active model effort');
  row('');
  row(' Slash Commands:', tokens.markdownHeading, true);
  for (const cmd of SLASH_COMMANDS.filter(command => command.help !== false)) {
    row(
      `   ${cmd.command.padEnd(14, ' ')} ${cmd.title.padEnd(26, ' ')} ${cmd.unavailable ?? cmd.description}`,
      tokens.foregroundMuted,
    );
  }
  modal.fill().bottom(' ↑/↓ or PgUp/PgDown Scroll · Esc Close ');

  // Only the body scrolls; title and footer bars stay pinned.
  const lines = modal.lines;
  const body = lines.slice(1, -1);
  const room = Math.max(1, height - 2);
  const offset = Math.max(0, Math.min(options.scrollOffset ?? 0, Math.max(0, body.length - room)));
  return [lines[0]!, ...body.slice(offset, offset + room), lines.at(-1)!];
}
