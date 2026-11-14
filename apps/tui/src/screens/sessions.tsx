import type { BorderStyle, SessionSummary, ThemeTokens } from '@hannes/contracts';
import type { RenderedBoxLine } from '../components/editor';
import { getBorderGlyphs } from '../theme/theme';

export interface SessionPickerState {
  query: string;
  selectedIndex: number;
}

export function createInitialSessionPickerState(): SessionPickerState {
  return {
    query: '',
    selectedIndex: 0,
  };
}

export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(
    s =>
      s.title.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.selection.modelId.toLowerCase().includes(q) ||
      s.preview.toLowerCase().includes(q),
  );
}

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
  const innerWidth = Math.max(24, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const filtered = filterSessions(sessions, state.query);
  const title = ` SESSIONS (${filtered.length}/${sessions.length}) `;
  const rightMeta = ' Enter Resume · Ctrl+N New · Ctrl+X Delete · Esc Close ';
  const topFill = Math.max(0, innerWidth - title.length - rightMeta.length);

  lines.push({
    spans: [
      { text: glyphs.topLeft, fg: tokens.borderFocused, bg },
      { text: title, fg: tokens.accent, bg, bold: true },
      { text: glyphs.horizontal.repeat(topFill), fg: tokens.borderFocused, bg },
      { text: rightMeta.slice(0, Math.max(0, innerWidth - title.length)), fg: tokens.foregroundMuted, bg },
      { text: glyphs.topRight, fg: tokens.borderFocused, bg },
    ],
  });

  const searchLine = ` Search: ${state.query}█`;
  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      {
        text: searchLine.slice(0, innerWidth).padEnd(innerWidth, ' '),
        fg: tokens.foreground,
        bg: tokens.backgroundElevated,
      },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  const maxRows = Math.max(4, height - 4);
  if (filtered.length === 0) {
    const emptyText =
      sessions.length === 0
        ? ' No saved sessions yet. Send a message or press Ctrl+N to start a new session.'
        : ` No sessions matching "${state.query}".`;
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: emptyText.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.foregroundMuted, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  } else {
    const clampedIdx = Math.max(0, Math.min(filtered.length - 1, state.selectedIndex));
    const startIdx = Math.max(0, Math.min(clampedIdx - Math.floor(maxRows / 2), Math.max(0, filtered.length - maxRows)));
    const visible = filtered.slice(startIdx, startIdx + maxRows);

    visible.forEach((sess, i) => {
      const absIdx = startIdx + i;
      const selected = absIdx === clampedIdx;
      const isCurrent = sess.id === activeSessionId;
      const rowBg = selected ? tokens.selection : bg;
      const rowFg = selected ? tokens.selectionForeground : tokens.foreground;
      const marker = isCurrent ? '●' : selected ? '▸' : ' ';
      const titlePart = `${sess.title || sess.preview || 'Untitled session'}`.slice(0, Math.max(12, innerWidth - 38));
      const metaPart = `${sess.selection.modelId} · ${sess.messageCount} msgs · ${sess.id.slice(0, 8)}`;
      const fullRow = ` ${marker} ${titlePart.padEnd(Math.max(12, innerWidth - metaPart.length - 6), ' ')} ${metaPart} `;
      lines.push({
        spans: [
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
          {
            text: fullRow.slice(0, innerWidth).padEnd(innerWidth, ' '),
            fg: isCurrent ? tokens.accent : rowFg,
            bg: rowBg,
            bold: selected || isCurrent,
          },
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        ],
      });
    });
  }

  while (lines.length < height - 1) {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  }

  const footer = ' ↑/↓ Navigate · Enter Resume Selected · Ctrl+N Start Fresh Session · Esc Cancel ';
  const footerFill = Math.max(0, innerWidth - footer.length);
  lines.push({
    spans: [
      { text: glyphs.bottomLeft, fg: tokens.borderFocused, bg },
      { text: footer.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg },
      { text: glyphs.horizontal.repeat(footerFill), fg: tokens.borderFocused, bg },
      { text: glyphs.bottomRight, fg: tokens.borderFocused, bg },
    ],
  });

  return lines;
}
