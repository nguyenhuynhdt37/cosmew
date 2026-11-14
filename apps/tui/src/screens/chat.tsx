import type { BorderStyle, SessionSummary, ThemeManifest, ThemeTokens } from '@hannes/contracts';
import type { FutrynClient, ReactiveAgentEvent } from '@hannes/sdk';
import type { RenderedBoxLine, StyledSpan } from '../components/editor';
import { renderTranscriptMessages, type TranscriptItem } from '../components/messages';
import { getBorderGlyphs } from '../theme/theme';

const FUTRYN_COMPACT_LOGO = [
  '█▀▀ █░█ ▀█▀ █▀█ █░█ █▄░█',
  '█▀░ █▄█ ░█░ █▀▄ ░█░ █░▀█',
];

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
  const w = Math.min(Math.max(28, width - 4), 60);
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

  // Compact 2-line modern CLI typography
  for (const row of FUTRYN_COMPACT_LOGO) {
    lines.push(center(row, tokens.accent, true));
  }

  // Tagline
  const greeting = manifest.greeting ?? 'high-craft terminal intelligence';
  lines.push(center(greeting, tokens.foregroundMuted));

  // Single subtle status/hint line
  if (!status.activeAccount) {
    lines.push(center('/connect to add a provider', tokens.foregroundSubtle));
  } else if (!status.selection) {
    lines.push(center('/models to select a model', tokens.foregroundSubtle));
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

  const title = ' SESSIONS ';
  const fill = Math.max(0, innerWidth - title.length);
  lines.push({
    spans: [
      { text: glyphs.topLeft, fg: tokens.border, bg },
      { text: title, fg: tokens.accent, bg, bold: true },
      { text: glyphs.horizontal.repeat(fill), fg: tokens.border, bg },
      { text: glyphs.topRight, fg: tokens.border, bg },
    ],
  });

  const pushSideRow = (text: string, fg = tokens.foreground, bold = false) => {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.border, bg },
        { text: text.slice(0, innerWidth).padEnd(innerWidth, ' '), fg, bg, bold },
        { text: glyphs.vertical, fg: tokens.border, bg },
      ],
    });
  };

  pushSideRow(` Mode    : ${status.mode.toUpperCase()}`, tokens.info, true);
  pushSideRow(
    ` Account : ${status.activeAccount?.alias ?? 'none'}`,
    status.activeAccount ? tokens.success : tokens.warning,
  );
  pushSideRow(
    ` Model   : ${status.selection?.modelId ?? 'none'}`,
    status.selection ? tokens.foreground : tokens.warning,
  );
  pushSideRow(` Theme   : ${manifest.name}`, tokens.accent);
  if (wallpaperPresetId) {
    pushSideRow(` Scene   : ${wallpaperPresetId}`, tokens.foregroundMuted);
  }
  pushSideRow('─'.repeat(innerWidth), tokens.border);

  if (sessions.length === 0) {
    pushSideRow('  (no saved sessions)', tokens.foregroundSubtle);
  } else {
    for (const s of sessions.slice(0, Math.max(2, height - 12))) {
      const active = s.id === status.activeSessionId;
      pushSideRow(
        ` ${active ? '●' : '·'} ${s.title || s.id.slice(0, 8)}`,
        active ? tokens.accent : tokens.foregroundMuted,
        active,
      );
    }
  }

  while (lines.length < height - 1) {
    pushSideRow('');
  }

  const footer = ' Ctrl+B Hide ';
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
}): StyledSpan[] {
  const { width, status, manifest, reactiveEvent, reactiveEffectsEnabled, isPreviewing, tokens } = options;
  const bg = tokens.background;

  let stateLabel = 'ready';
  let stateColor = tokens.foregroundSubtle;
  if (reactiveEffectsEnabled) {
    switch (reactiveEvent.kind) {
      case 'thinking':
        stateLabel = 'thinking';
        stateColor = tokens.warning;
        break;
      case 'streaming':
        stateLabel = 'streaming';
        stateColor = tokens.accent;
        break;
      case 'tool':
        stateLabel = 'tool';
        stateColor = tokens.info;
        break;
      case 'permission':
        stateLabel = 'permission';
        stateColor = tokens.warning;
        break;
      case 'error':
        stateLabel = 'error';
        stateColor = tokens.error;
        break;
      case 'done':
        stateLabel = 'ready';
        stateColor = tokens.success;
        break;
      default:
        stateLabel = 'ready';
        stateColor = tokens.success;
        break;
    }
  }

  const left = ` FUTRYN `;
  const dot = '● ';
  const session = status.activeSessionId
    ? ` ${status.activeSessionId.slice(0, 8)} · ${status.messageCount} msgs`
    : '';
  const right = `${isPreviewing ? '[Preview] ' : ''}${manifest.name} · ${status.selection?.modelId ?? 'no model'} `;
  const used = left.length + dot.length + stateLabel.length + session.length + right.length;
  const pad = ' '.repeat(Math.max(0, width - used));

  return [
    { text: left, fg: tokens.accent, bg, bold: true },
    { text: dot, fg: stateColor, bg },
    { text: stateLabel, fg: stateColor, bg },
    { text: session, fg: tokens.foregroundMuted, bg },
    { text: pad, fg: tokens.foreground, bg },
    { text: right.slice(0, Math.max(0, width - left.length - dot.length - stateLabel.length)), fg: tokens.foregroundSubtle, bg },
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
    let thumb = ' ';
    if (totalLines > height) {
      const thumbPos = Math.floor((clampedOffset / Math.max(1, maxOffset)) * (height - 1));
      thumb = row === thumbPos ? '┃' : '│';
    }
    result.push({
      spans: [
        ...line.spans,
        ...(line.spans.length > 0
          ? [{ text: ` ${thumb}`, fg: tokens.scrollbar, bg: tokens.background }]
          : []),
      ],
    });
  }

  return { lines: result, totalLines, clampedOffset };
}
