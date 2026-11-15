import type { BorderStyle, SessionSummary, ThemeManifest, ThemeTokens } from '@hannes/contracts';
import type { FutrynClient, ReactiveAgentEvent } from '@hannes/sdk';
import type { RenderedBoxLine, StyledSpan } from '../components/editor';
import { FYN_LABELS, type FynState } from '../components/mascot';
import { renderTranscriptMessages, type TranscriptItem } from '../components/messages';
import { getBorderGlyphs } from '../theme/theme';

export function renderWelcomeScreen(options: {
  width: number;
  height: number;
  manifest: ThemeManifest;
  status: ReturnType<FutrynClient['status']>;
  wallpaperPresetId: string | null;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, manifest, status, tokens } = options;
  const w = Math.min(Math.max(28, width - 4), 56);
  const bg = tokens.background;
  const lines: RenderedBoxLine[] = [];

  const center = (text: string, fg: string, bold = false): RenderedBoxLine => {
    const clipped = text.slice(0, w);
    const left = Math.max(0, Math.floor((w - clipped.length) / 2));
    return {
      spans: [
        { text: ' '.repeat(left), fg, bg },
        { text: clipped, fg, bg, bold },
        { text: ' '.repeat(Math.max(0, w - left - clipped.length)), fg, bg },
      ],
    };
  };

  const pills = (labels: string[]): RenderedBoxLine => {
    const parts: StyledSpan[] = [];
    for (const label of labels) {
      if (parts.length > 0) parts.push({ text: ' ', fg: tokens.foregroundSubtle, bg });
      parts.push({ text: ` ${label} `, fg: tokens.info, bg: tokens.backgroundElevated });
    }
    const len = parts.reduce((sum, span) => sum + span.text.length, 0);
    const left = Math.max(0, Math.floor((w - len) / 2));
    return {
      spans: [
        { text: ' '.repeat(left), fg: tokens.foregroundSubtle, bg },
        ...parts,
        { text: ' '.repeat(Math.max(0, w - left - len)), fg: tokens.foregroundSubtle, bg },
      ],
    };
  };

  lines.push(center('FUTRYN', tokens.accent, true));
  lines.push(center(manifest.greeting ?? 'Quiet desk. Clear answers.', tokens.foregroundMuted));
  if (!status.activeAccount) {
    lines.push(center('Connect a provider to start', tokens.foregroundMuted));
    lines.push(pills(['/login', '/help']));
  } else if (!status.selection) {
    lines.push(center('Choose a model to start', tokens.foregroundMuted));
    lines.push(pills(['/model', '/help']));
  } else {
    lines.push(center(`${status.selection.modelId} · ${status.activeAccount.alias}`, tokens.foregroundSubtle));
  }

  return lines;
}

export function renderSidebarPanel(options: {
  width: number;
  height: number;
  status: ReturnType<FutrynClient['status']>;
  sessions: SessionSummary[];
  manifest: ThemeManifest;
  wallpaperPresetId: string | null;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, status, sessions, manifest, wallpaperPresetId, tokens, borderStyle } = options;
  const innerWidth = Math.max(16, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.sidebarBackground;
  const lines: RenderedBoxLine[] = [];

  const title = ' Sessions ';
  const fill = Math.max(0, innerWidth - title.length);
  lines.push({
    spans: [
      { text: glyphs.topLeft, fg: tokens.border, bg },
      { text: title, fg: tokens.accent, bg, bold: true },
      { text: glyphs.horizontal.repeat(fill), fg: tokens.border, bg },
      { text: glyphs.topRight, fg: tokens.border, bg },
    ],
  });

  const pushSideRow = (text: string, fg = tokens.foreground, bold = false, rowBg = bg) => {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.border, bg },
        { text: text.slice(0, innerWidth).padEnd(innerWidth, ' '), fg, bg: rowBg, bold },
        { text: glyphs.vertical, fg: tokens.border, bg },
      ],
    });
  };

  const account = status.activeAccount?.alias ?? 'not connected';
  const model = status.selection?.modelId ?? 'no model';
  pushSideRow(` ${status.mode}`, tokens.info, true, tokens.backgroundElevated);
  pushSideRow(` ${account}`, status.activeAccount ? tokens.foreground : tokens.warning);
  pushSideRow(` ${model}`, status.selection ? tokens.foregroundMuted : tokens.warning);
  pushSideRow(` ${manifest.name}${wallpaperPresetId ? ` · ${wallpaperPresetId}` : ''}`, tokens.foregroundSubtle);
  pushSideRow('');

  if (sessions.length === 0) {
    pushSideRow('  No sessions yet', tokens.foregroundSubtle);
  } else {
    for (const s of sessions.slice(0, Math.max(2, height - 12))) {
      const active = s.id === status.activeSessionId;
      pushSideRow(
        ` ${active ? '●' : '·'} ${s.title || s.id.slice(0, 8)}`,
        active ? tokens.accent : tokens.foregroundMuted,
        active,
        active ? tokens.selection : bg,
      );
    }
  }

  while (lines.length < height - 1) {
    pushSideRow('');
  }

  const footer = ' hide · Ctrl+B ';
  const footerFill = Math.max(0, innerWidth - footer.length);
  lines.push({
    spans: [
      { text: glyphs.bottomLeft, fg: tokens.border, bg },
      { text: footer.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg },
      { text: glyphs.horizontal.repeat(footerFill), fg: tokens.border, bg },
      { text: glyphs.bottomRight, fg: tokens.border, bg },
    ],
  });

  return lines;
}

export function renderTopHeaderBar(options: {
  width: number;
  status: ReturnType<FutrynClient['status']>;
  manifest: ThemeManifest;
  reactiveEvent: ReactiveAgentEvent;
  reactiveEffectsEnabled: boolean;
  isPreviewing: boolean;
  tokens: ThemeTokens;
  companionState?: FynState;
}): StyledSpan[] {
  const { width, status, reactiveEvent, reactiveEffectsEnabled, isPreviewing, tokens, companionState } = options;
  const bg = tokens.backgroundPanel;

  const stateKey: FynState = companionState ?? (reactiveEffectsEnabled && reactiveEvent.kind !== 'idle' ? (
    reactiveEvent.kind === 'thinking' ? 'thinking' :
    reactiveEvent.kind === 'streaming' ? 'streaming' :
    reactiveEvent.kind === 'error' ? 'error' :
    reactiveEvent.kind === 'permission' ? 'waiting' :
    reactiveEvent.kind === 'done' ? 'done' : 'idle'
  ) : 'idle');

  const label = FYN_LABELS[stateKey] ?? 'ready';
  let stateColor = tokens.success;
  switch (stateKey) {
    case 'thinking':
    case 'waiting':
      stateColor = tokens.warning;
      break;
    case 'streaming':
      stateColor = tokens.accent;
      break;
    case 'error':
      stateColor = tokens.error;
      break;
    case 'cancelled':
    case 'sleep':
      stateColor = tokens.foregroundSubtle;
      break;
    default:
      stateColor = tokens.success;
      break;
  }

  const fyn = `Fyn · ${label}`;
  const leftParts: StyledSpan[] = [
    { text: ' FUTRYN', fg: tokens.accent, bg, bold: true },
    { text: '   ', fg: tokens.foregroundSubtle, bg },
    { text: '● ', fg: stateColor, bg },
    { text: fyn, fg: stateColor, bg },
  ];
  const leftLen = leftParts.reduce((sum, span) => sum + span.text.length, 0);
  const bits = [
    isPreviewing ? 'preview' : '',
    status.selection?.modelId ?? '',
  ].filter(Boolean);
  const room = Math.max(0, width - leftLen);
  const metadata = bits.join(' · ');
  const clipped = metadata.length > Math.max(0, room - 2) && room > 3 ? metadata.slice(0, room - 3) + '…' : metadata;
  const rightText = room > 0 ? ` ${clipped} `.slice(0, room) : '';
  const padLen = Math.max(0, room - rightText.length);

  return [
    ...leftParts,
    { text: ' '.repeat(padLen), fg: tokens.foregroundMuted, bg },
    { text: rightText, fg: tokens.foregroundMuted, bg },
  ];
}

export function renderTranscriptViewport(options: {
  items: TranscriptItem[];
  width: number;
  height: number;
  scrollOffset: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  syntaxHighlighting: boolean;
}): { lines: RenderedBoxLine[]; totalLines: number; clampedOffset: number } {
  const { items, width, height, scrollOffset, tokens, borderStyle, syntaxHighlighting } = options;
  const contentWidth = Math.max(16, width - 2);
  const allLines = renderTranscriptMessages({
    items,
    width: contentWidth,
    tokens,
    borderStyle,
    syntaxHighlighting,
  });

  const totalLines = allLines.length;
  const maxOffset = Math.max(0, totalLines - height);
  const clampedOffset = scrollOffset < 0 ? maxOffset : Math.max(0, Math.min(maxOffset, scrollOffset));
  const slice = allLines.slice(clampedOffset, clampedOffset + height);

  const result: RenderedBoxLine[] = [];
  for (let row = 0; row < height; row++) {
    const line = slice[row] ?? { spans: [] };
    const used = line.spans.reduce((sum, span) => sum + span.text.length, 0);
    let thumb = ' ';
    if (totalLines > height) {
      const thumbPos = Math.floor((clampedOffset / Math.max(1, maxOffset)) * (height - 1));
      thumb = row === thumbPos ? '┃' : '│';
    }
    result.push({
      spans: [
        ...line.spans,
        ...(totalLines > height
          ? [{ text: `${' '.repeat(Math.max(0, contentWidth - used))} ${thumb}`, fg: tokens.scrollbar, bg: tokens.background }]
          : []),
      ],
    });
  }

  return { lines: result, totalLines, clampedOffset };
}
