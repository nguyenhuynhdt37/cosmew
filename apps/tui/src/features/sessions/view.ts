import type { BorderStyle, SessionSummary, ThemeTokens } from '@hannes/contracts';
import { Modal, clampIndex, windowCentered, type RenderedBoxLine } from '../../ui';
import { filterSessions } from './logic';
import type { SessionPickerState } from './types';

export function renderSessionPickerOverlay(options: {
  width: number;
  height: number;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  state: SessionPickerState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, sessions, activeSessionId, state, tokens, borderStyle } = options;
  const modal = new Modal({ width, height, tokens, borderStyle });
  const filtered = filterSessions(sessions, state.query);
  modal.top(` SESSIONS (${filtered.length}/${sessions.length}) `, ' Enter Resume · Ctrl+N New · Ctrl+X Delete · Esc Close ');
  modal.input(` Search: ${state.query}█`);

  const maxRows = Math.max(4, height - 4);
  if (filtered.length === 0) {
    modal.text(
      sessions.length === 0
        ? ' No saved sessions yet. Send a message or press Ctrl+N to start a new session.'
        : ` No sessions matching "${state.query}".`,
      { fg: tokens.foregroundMuted },
    );
  } else {
    const selectedIndex = clampIndex(state.selectedIndex, filtered.length);
    const start = windowCentered(filtered.length, selectedIndex, maxRows);
    filtered.slice(start, start + maxRows).forEach((sess, i) => {
      const selected = start + i === selectedIndex;
      const isCurrent = sess.id === activeSessionId;
      const marker = isCurrent ? '●' : selected ? '▸' : ' ';
      const titlePart = `${sess.title || sess.preview || 'Untitled session'}`.slice(0, Math.max(12, modal.innerWidth - 38));
      const metaPart = `${sess.selection.modelId} · ${sess.messageCount} msgs · ${sess.id.slice(0, 8)}`;
      const row = ` ${marker} ${titlePart.padEnd(Math.max(12, modal.innerWidth - metaPart.length - 6), ' ')} ${metaPart} `;
      modal.text(row, {
        fg: isCurrent ? tokens.accent : selected ? tokens.selectionForeground : tokens.foreground,
        bg: selected ? tokens.selection : modal.bg,
        bold: selected || isCurrent,
      });
    });
  }

  return modal.fill().bottom(' ↑/↓ Navigate · Enter Resume Selected · Ctrl+N Start Fresh Session · Esc Cancel ').lines;
}
