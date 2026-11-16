import type {BorderStyle, SessionSummary, ThemeManifest, ThemeTokens} from '@futryn/contracts';
import type {FutrynClient} from '@futryn/sdk';
import {getBorderGlyphs} from '../../theme/theme';
import type {RenderedBoxLine} from '../../ui';

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
  const {width, height, status, sessions, manifest, wallpaperPresetId, tokens, borderStyle} = options;
  const innerWidth = Math.max(16, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.sidebarBackground;
  const lines: RenderedBoxLine[] = [];

  const title = ' Sessions ';
  const fill = Math.max(0, innerWidth - title.length);
  lines.push({
    spans: [
      {text: glyphs.topLeft, fg: tokens.border, bg},
      {text: title, fg: tokens.accent, bg, bold: true},
      {text: glyphs.horizontal.repeat(fill), fg: tokens.border, bg},
      {text: glyphs.topRight, fg: tokens.border, bg},
    ],
  });

  const pushSideRow = (text: string, fg = tokens.foreground, bold = false, rowBg = bg) => {
    lines.push({
      spans: [
        {text: glyphs.vertical, fg: tokens.border, bg},
        {text: text.slice(0, innerWidth).padEnd(innerWidth, ' '), fg, bg: rowBg, bold},
        {text: glyphs.vertical, fg: tokens.border, bg},
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
      {text: glyphs.bottomLeft, fg: tokens.border, bg},
      {text: footer.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg},
      {text: glyphs.horizontal.repeat(footerFill), fg: tokens.border, bg},
      {text: glyphs.bottomRight, fg: tokens.border, bg},
    ],
  });

  return lines;
}
