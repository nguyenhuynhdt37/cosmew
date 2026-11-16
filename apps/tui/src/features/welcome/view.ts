import type { BorderStyle, ThemeManifest, ThemeTokens } from '@futryn/contracts';
import type { FutrynClient } from '@futryn/sdk';
import type { RenderedBoxLine, StyledSpan } from '../../ui';

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

