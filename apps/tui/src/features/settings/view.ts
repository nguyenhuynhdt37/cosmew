import { WALLPAPER_PRESET_IDS, type AppearanceConfig, type BorderStyle, type ThemeTokens } from '@futryn/contracts';
import { Modal, clampIndex, type RenderedBoxLine } from '../../ui';
import { settingsRows } from './logic';

export function renderSettingsOverlay(options: {
  width: number;
  height: number;
  appearance: AppearanceConfig;
  effectiveMode: 'dark' | 'light';
  selectedIndex: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, appearance, effectiveMode, selectedIndex, tokens, borderStyle } = options;
  const modal = new Modal({ width, height, tokens, borderStyle, minInner: 30 });
  modal.top(' APPEARANCE & TUI SETTINGS (/config) ', ' Enter/Space Toggle · ←/→ Adjust · Esc Close ');

  const rows = settingsRows(appearance, effectiveMode);
  const selected = clampIndex(selectedIndex, rows.length);
  rows.forEach((r, idx) => {
    const on = idx === selected;
    modal.text(` ${on ? '▸' : ' '} ${r.label.padEnd(26, ' ')} : ${r.value}`, {
      fg: on ? tokens.selectionForeground : tokens.foreground,
      bg: on ? tokens.selection : modal.bg,
      bold: on,
    });
  });

  return modal.fill().bottom(` ↑/↓ Select Setting · Enter/Space Toggle · ←/→ Adjust Value · Wallpapers: ${WALLPAPER_PRESET_IDS.length} · Esc Close `).lines;
}
