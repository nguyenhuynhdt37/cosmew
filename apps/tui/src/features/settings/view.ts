import type {AppearanceConfig, BorderStyle, ThemeTokens} from '@futryn/contracts';
import {Modal, clampIndex, type RenderedBoxLine} from '../../ui';
import {settingsRows, type ConfigurationRow, type SettingsSection} from './logic';

export function renderSettingsOverlay(options: {
  width: number;
  height: number;
  appearance: AppearanceConfig;
  effectiveMode: 'dark' | 'light';
  selectedIndex: number;
  section?: SettingsSection;
  appearanceScope?: 'global' | 'project';
  rows?: ConfigurationRow[];
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, appearance, effectiveMode, selectedIndex, tokens, borderStyle} = options;
  const modal = new Modal({width, height, tokens, borderStyle, minInner: 1});
  const scope =
    options.section === 'Appearance' ? ` · ${options.appearanceScope === 'project' ? 'workspace' : 'user'}` : '';
  const title = ` /config · ${options.section ?? 'Appearance'}${scope} `;
  modal.top(title.slice(0, modal.innerWidth));
  const rows = options.rows ?? settingsRows(appearance, effectiveMode);
  const selected = clampIndex(selectedIndex, rows.length);
  const available = Math.max(0, height - 4);
  const offset = Math.max(0, Math.min(selected - Math.floor(available / 2), rows.length - available));
  for (let index = offset; index < Math.min(rows.length, offset + available); index++) {
    const row: ConfigurationRow = rows[index]!;
    const on = index === selected;
    const source = row.source ? ` [${row.source}]` : '';
    const prefix = ` ${on ? '▸' : ' '} ${row.label}: `;
    const valueRoom = Math.max(1, modal.innerWidth - prefix.length - source.length);
    const value =
      row.value.startsWith('/') && row.value.length > valueRoom
        ? valueRoom === 1
          ? '…'
          : `…${row.value.slice(-(valueRoom - 1))}`
        : row.value;
    const text = `${prefix}${value}${source}${row.disabled ? ' (read-only)' : ''}`;
    modal.text(text, {
      fg: on ? tokens.selectionForeground : row.disabled ? tokens.foregroundMuted : tokens.foreground,
      bg: on ? tokens.selection : modal.bg,
      bold: on,
    });
  }
  const active: ConfigurationRow | undefined = rows[selected];
  const hint =
    active?.disabled ??
    (active?.action?.startsWith('budget-')
      ? '←/→ chooses a preset; saved at user level for future turns and restarts.'
      : active?.action
        ? 'Enter opens editor; appearance changes apply live and persist.'
        : 'Read-only effective value.');
  modal.fillTo(Math.max(1, height - 3));
  if (height >= 4) modal.text(` ${hint}`, {fg: tokens.foregroundMuted});
  if (height >= 3)
    modal.text(
      options.section === 'Appearance'
        ? ' Tab section · Ctrl+G save scope · ↑/↓ row'
        : ' Tab/Shift+Tab section · ↑/↓ row · Enter edit',
      {fg: tokens.foregroundSubtle},
    );
  return modal.fill().bottom(' Esc close ').lines;
}
