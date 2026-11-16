import { THEME_TOKEN_KEYS, type BorderStyle, type ThemeTokenKey, type ThemeTokens } from '@futryn/contracts';
import type { ThemeEngine } from '../../theme/theme';
import { Modal, clampIndex, windowCentered, type RenderedBoxLine } from '../../ui';
import type { ThemeEditorState } from './types';

export function renderThemeEditorOverlay(options: {
  width: number;
  height: number;
  engine: ThemeEngine;
  state: ThemeEditorState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, engine, state, tokens, borderStyle } = options;
  const modal = new Modal({ width, height, tokens, borderStyle, minInner: 36 });
  const manifest = engine.getTheme(state.targetThemeId) ?? engine.getActiveThemeManifest();
  modal.top(
    ` THEME EDITOR (${manifest.name} · ${manifest.builtIn ? 'Built-in Immutable' : 'Custom'}) `,
    ` Mode: ${state.editMode.toUpperCase()} · Esc Close `,
  );

  const editing = state.editingHex || state.renaming;
  const actionHeader = state.renaming
    ? ` Rename Theme: ${state.nameDraft}█  (Enter Save · Esc Cancel)`
    : state.editingHex
      ? ` Edit Token #${THEME_TOKEN_KEYS[state.selectedTokenIndex]}: ${state.hexDraft}█  (Enter Apply Hex · Esc Cancel)`
      : ' Enter Edit Hex · Ctrl+D Duplicate to Custom · Ctrl+R Rename · Ctrl+Z Reset Token · Ctrl+U Reset All · Tab Dark/Light';
  modal.text(actionHeader, { fg: editing ? tokens.warning : tokens.info, bg: tokens.backgroundElevated, bold: editing });

  const palette = state.editMode === 'light' ? manifest.light : manifest.dark;
  const maxRows = Math.max(4, height - 5);
  const selectedIndex = clampIndex(state.selectedTokenIndex, THEME_TOKEN_KEYS.length);
  const start = windowCentered(THEME_TOKEN_KEYS.length, selectedIndex, maxRows);
  THEME_TOKEN_KEYS.slice(start, start + maxRows).forEach((key: ThemeTokenKey, i: number) => {
    const selected = start + i === selectedIndex;
    const hex = palette[key];
    const rowBg = selected ? tokens.selection : modal.bg;
    const left = ` ${selected ? '▸' : ' '} ${key.padEnd(22, ' ')} `;
    modal.spans([
      { text: left, fg: selected ? tokens.selectionForeground : tokens.foreground, bg: rowBg, bold: selected },
      { text: '████', fg: hex, bg: rowBg },
      { text: ` ${hex} `.padEnd(modal.innerWidth - left.length - 4, ' '), fg: selected ? tokens.accent : tokens.foregroundMuted, bg: rowBg },
    ]);
  });

  modal.fillTo(height - 2);
  modal.text(
    state.statusMessage ?? (manifest.builtIn
      ? ' Built-in themes are immutable; editing or pressing Ctrl+D automatically saves a Custom copy.'
      : ` Editing custom theme "${manifest.id}". Changes are validated and written atomically.`),
    { fg: tokens.accent, bg: tokens.backgroundElevated },
  );
  return modal.bottom(' ↑/↓ Token · Enter Edit · Ctrl+D Duplicate · Ctrl+Z Reset Token · Ctrl+X Delete Custom · Esc Back ').lines;
}
