import type { BorderStyle, ThemeTokens } from '@hannes/contracts';
import type { ThemeEngine } from '../../theme/theme';
import type { RenderedBoxLine, StyledSpan } from '../../ui';
import type { ThemePickerState } from './types';

/** Flat (borderless) picker: each row is padded to the full width on the overlay surface. */
export function renderThemePickerOverlay(options: {
  width: number;
  height: number;
  engine: ThemeEngine;
  state: ThemePickerState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, engine, state, tokens } = options;
  const themes = engine.listThemes('all');
  const active = engine.getCommittedAppearance();
  const line = (parts: StyledSpan[]): RenderedBoxLine => {
    const spans = parts.map(part => ({ ...part, bg: part.bg ?? tokens.overlayBackground }));
    const used = spans.reduce((sum, span) => sum + span.text.length, 0);
    if (used < width) spans.push({ text: ' '.repeat(width - used), fg: tokens.foreground, bg: tokens.overlayBackground });
    return { spans };
  };
  const lines: RenderedBoxLine[] = [
    line([{ text: '  Theme', fg: tokens.accent, bold: true }]),
    line([{ text: width < 34 ? '  Choose appearance' : '  Choose a theme', fg: tokens.foregroundMuted }]),
    line([]),
  ];
  for (const [index, theme] of themes.entries()) {
    const selected = index === state.selectedIndex;
    const name = `${selected ? '  › ' : '    '}${theme.name}${active.theme === theme.id ? ' ●' : ''}`;
    const label = (width >= 40 ? name.padEnd(17) + theme.description : name).slice(0, Math.max(0, width));
    lines.push(line([{ text: label.padEnd(width), fg: selected ? tokens.selectionForeground : tokens.foreground,
      bg: selected ? tokens.selection : tokens.overlayBackground, bold: selected }]));
  }
  while (lines.length < Math.max(0, height - 2)) lines.push(line([]));
  const footer = width < 38 ? '↑↓  Enter  Esc' : '↑↓ Preview   Enter Apply   Esc Cancel';
  lines.push(line([{ text: `  ${state.statusMessage ?? footer}`.slice(0, width), fg: tokens.foregroundMuted }]));
  return lines.slice(0, height);
}
