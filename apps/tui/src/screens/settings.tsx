import {
  THEME_TOKEN_KEYS,
  WALLPAPER_PRESET_IDS,
  type AppearanceConfig,
  type BorderStyle,
  type ModelInfo,
  type ThemeTokenKey,
  type ThemeTokens,
} from '@hannes/contracts';
import { SLASH_COMMANDS, type RenderedBoxLine, type StyledSpan } from '../components/editor';
import {
  getBorderGlyphs,
  getThemeMiniSwatches,
  type ThemeEngine,
  type ThemePickerTab,
} from '../theme/theme';

export const THEME_PICKER_TABS: readonly { id: ThemePickerTab; label: string }[] = [
  { id: 'featured', label: 'Featured' },
  { id: 'colors', label: 'Colors' },
  { id: 'live', label: 'Live' },
  { id: 'my-themes', label: 'My Themes' },
];

export interface ThemePickerState {
  tab: ThemePickerTab;
  query: string;
  selectedIndex: number;
  statusMessage?: string;
}

export function createInitialThemePickerState(): ThemePickerState {
  return {
    tab: 'featured',
    query: '',
    selectedIndex: 0,
  };
}

export function renderThemePickerOverlay(options: {
  width: number;
  height: number;
  engine: ThemeEngine;
  state: ThemePickerState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, engine, state, tokens, borderStyle } = options;
  const innerWidth = Math.max(36, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const committed = engine.getCommittedAppearance();
  const active = engine.getActiveAppearance();
  const mode = engine.getEffectiveMode();
  const themes = engine.listThemes(state.tab, state.query);

  const title = ' THEME PICKER (/theme) ';
  const rightMeta = ` Active: ${committed.theme} (${mode}) ${engine.isPreviewing() ? '· PREVIEWING ' : ''}`;
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

  // Tabs bar + Search filter
  const tabSpans: StyledSpan[] = [{ text: glyphs.vertical, fg: tokens.borderFocused, bg }];
  let usedCols = 0;
  for (const t of THEME_PICKER_TABS) {
    const isTab = state.tab === t.id;
    const count = engine.listThemes(t.id, state.query).length;
    const label = ` ${isTab ? '▸' : ' '} ${t.label} (${count}) `;
    tabSpans.push({
      text: label,
      fg: isTab ? tokens.accentForeground : tokens.foregroundMuted,
      bg: isTab ? tokens.accent : tokens.backgroundElevated,
      bold: isTab,
    });
    tabSpans.push({ text: ' ', fg: tokens.foreground, bg: tokens.backgroundElevated });
    usedCols += label.length + 1;
  }
  const searchPart = `Search: ${state.query}█`;
  const searchPad = Math.max(0, innerWidth - usedCols - searchPart.length - 1);
  tabSpans.push({
    text: `${' '.repeat(searchPad)}${searchPart} `.slice(0, Math.max(0, innerWidth - usedCols)),
    fg: tokens.foreground,
    bg: tokens.backgroundElevated,
  });
  tabSpans.push({ text: glyphs.vertical, fg: tokens.borderFocused, bg });
  lines.push({ spans: tabSpans });

  // Live animation controls bar
  const anim = active.animations;
  const wallLabel = engine.getActiveWallpaperPresetId() ?? 'off';
  const animBar = ` Wallpaper: ${wallLabel} (${anim.enabled ? 'ON' : 'OFF'}) │ Motion: ${anim.motion.toUpperCase()} │ Speed: ${anim.speed.toFixed(2)}x │ Cell: ${anim.cellSize}x │ Veil: ${Math.round(anim.veil * 100)}% `;
  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      {
        text: animBar.slice(0, innerWidth).padEnd(innerWidth, ' '),
        fg: tokens.info,
        bg,
      },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  lines.push({
    spans: [
      { text: `${glyphs.vertical}${glyphs.horizontal.repeat(innerWidth)}${glyphs.vertical}`, fg: tokens.border, bg },
    ],
  });

  const maxListRows = Math.max(4, height - 8);
  if (themes.length === 0) {
    const msg =
      state.tab === 'my-themes' && !state.query
        ? ' No custom themes yet. Press Ctrl+E to open Theme Editor or duplicate a theme.'
        : ` No themes matching "${state.query}" in ${state.tab}.`;
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: msg.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.foregroundMuted, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  } else {
    const clampedIdx = Math.max(0, Math.min(themes.length - 1, state.selectedIndex));
    const startIdx = Math.max(
      0,
      Math.min(clampedIdx - Math.floor(maxListRows / 2), Math.max(0, themes.length - maxListRows)),
    );
    const visible = themes.slice(startIdx, startIdx + maxListRows);

    visible.forEach((manifest, i) => {
      const absIdx = startIdx + i;
      const isSelected = absIdx === clampedIdx;
      const isCommitted = manifest.id === committed.theme;
      const rowBg = isSelected ? tokens.selection : bg;
      const rowFg = isSelected ? tokens.selectionForeground : tokens.foreground;
      const swatches = getThemeMiniSwatches(manifest, mode);

      const indicator = isCommitted ? '●' : isSelected ? '▸' : ' ';
      const nameCol = ` ${indicator} ${manifest.name.slice(0, 18).padEnd(18, ' ')} `;
      const catBadge = `[${manifest.category.toUpperCase().slice(0, 6).padEnd(6, ' ')}] `;
      const swatchLen = 10; // 5 x '██'
      const descWidth = Math.max(
        0,
        innerWidth - nameCol.length - swatchLen - 2 - catBadge.length,
      );
      const descCol = ` ${manifest.description.slice(0, descWidth - 1)}`.padEnd(descWidth, ' ');

      lines.push({
        spans: [
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
          {
            text: nameCol,
            fg: isCommitted ? tokens.accent : rowFg,
            bg: rowBg,
            bold: isSelected || isCommitted,
          },
          { text: '██', fg: swatches.background, bg: rowBg },
          { text: '██', fg: swatches.panel, bg: rowBg },
          { text: '██', fg: swatches.accent, bg: rowBg },
          { text: '██', fg: swatches.foreground, bg: rowBg },
          { text: '██', fg: swatches.success, bg: rowBg },
          { text: '  ', fg: rowFg, bg: rowBg },
          { text: catBadge, fg: manifest.wallpaper ? tokens.info : tokens.foregroundSubtle, bg: rowBg },
          { text: descCol, fg: isSelected ? rowFg : tokens.foregroundMuted, bg: rowBg },
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        ],
      });
    });
  }

  while (lines.length < height - 2) {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  }

  const selectedTheme = themes[Math.max(0, Math.min(themes.length - 1, state.selectedIndex))];
  const statusLine =
    state.statusMessage ??
    (selectedTheme
      ? ` ${selectedTheme.name} (${selectedTheme.id}) · ${selectedTheme.attribution ?? 'FUTRYN Built-in'}${selectedTheme.wallpaper ? ` · Live Wallpaper: ${selectedTheme.wallpaper}` : ''}`
      : ' Select a theme to preview and apply.');

  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      {
        text: statusLine.slice(0, innerWidth).padEnd(innerWidth, ' '),
        fg: tokens.accent,
        bg: tokens.backgroundElevated,
      },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  const footer =
    ' ↑/↓ Preview · Enter Apply · Esc Cancel & Restore · Tab Category · Ctrl+W Wallpaper · +/- Speed · Ctrl+G Motion · Ctrl+E Edit ';
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

// ============================================================================
// THEME EDITOR OVERLAY (/theme edit)
// ============================================================================

export interface ThemeEditorState {
  targetThemeId: string;
  editMode: 'dark' | 'light';
  selectedTokenIndex: number;
  editingHex: boolean;
  hexDraft: string;
  renaming: boolean;
  nameDraft: string;
  statusMessage?: string;
}

export function createInitialThemeEditorState(themeId = 'futryn-default', mode: 'dark' | 'light' = 'dark'): ThemeEditorState {
  return {
    targetThemeId: themeId,
    editMode: mode,
    selectedTokenIndex: 0,
    editingHex: false,
    hexDraft: '',
    renaming: false,
    nameDraft: '',
  };
}

export function renderThemeEditorOverlay(options: {
  width: number;
  height: number;
  engine: ThemeEngine;
  state: ThemeEditorState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, engine, state, tokens, borderStyle } = options;
  const innerWidth = Math.max(36, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const manifest = engine.getTheme(state.targetThemeId) ?? engine.getActiveThemeManifest();
  const title = ` THEME EDITOR (${manifest.name} · ${manifest.builtIn ? 'Built-in Immutable' : 'Custom'}) `;
  const rightMeta = ` Mode: ${state.editMode.toUpperCase()} · Esc Close `;
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

  const actionHeader = state.renaming
    ? ` Rename Theme: ${state.nameDraft}█  (Enter Save · Esc Cancel)`
    : state.editingHex
      ? ` Edit Token #${THEME_TOKEN_KEYS[state.selectedTokenIndex]}: ${state.hexDraft}█  (Enter Apply Hex · Esc Cancel)`
      : ' Enter Edit Hex · Ctrl+D Duplicate to Custom · Ctrl+R Rename · Ctrl+Z Reset Token · Ctrl+U Reset All · Tab Dark/Light';

  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      {
        text: actionHeader.slice(0, innerWidth).padEnd(innerWidth, ' '),
        fg: state.editingHex || state.renaming ? tokens.warning : tokens.info,
        bg: tokens.backgroundElevated,
        bold: state.editingHex || state.renaming,
      },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  const palette = state.editMode === 'light' ? manifest.light : manifest.dark;
  const maxRows = Math.max(4, height - 5);
  const clampedIdx = Math.max(0, Math.min(THEME_TOKEN_KEYS.length - 1, state.selectedTokenIndex));
  const startIdx = Math.max(
    0,
    Math.min(clampedIdx - Math.floor(maxRows / 2), Math.max(0, THEME_TOKEN_KEYS.length - maxRows)),
  );
  const visibleKeys = THEME_TOKEN_KEYS.slice(startIdx, startIdx + maxRows);

  visibleKeys.forEach((key: ThemeTokenKey, i: number) => {
    const absIdx = startIdx + i;
    const selected = absIdx === clampedIdx;
    const hex = palette[key];
    const rowBg = selected ? tokens.selection : bg;
    const rowFg = selected ? tokens.selectionForeground : tokens.foreground;
    const left = ` ${selected ? '▸' : ' '} ${key.padEnd(22, ' ')} `;
    const right = ` ${hex} `.padEnd(innerWidth - left.length - 4, ' ');

    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: left, fg: rowFg, bg: rowBg, bold: selected },
        { text: '████', fg: hex, bg: rowBg },
        { text: right, fg: selected ? tokens.accent : tokens.foregroundMuted, bg: rowBg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  });

  while (lines.length < height - 2) {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  }

  const statusText =
    state.statusMessage ??
    (manifest.builtIn
      ? ' Built-in themes are immutable; editing or pressing Ctrl+D automatically saves a Custom copy.'
      : ` Editing custom theme "${manifest.id}". Changes are validated and written atomically.`);

  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      { text: statusText.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.accent, bg: tokens.backgroundElevated },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  const footer = ' ↑/↓ Token · Enter Edit · Ctrl+D Duplicate · Ctrl+Z Reset Token · Ctrl+X Delete Custom · Esc Back ';
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

// ============================================================================
// MODEL PICKER OVERLAY (/models, /model)
// ============================================================================

export interface ModelPickerState {
  query: string;
  selectedIndex: number;
  addingManual: boolean;
  manualDraft: string;
  statusMessage?: string;
}

export function createInitialModelPickerState(): ModelPickerState {
  return {
    query: '',
    selectedIndex: 0,
    addingManual: false,
    manualDraft: '',
  };
}

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
  );
}

export function renderModelPickerOverlay(options: {
  width: number;
  height: number;
  models: ModelInfo[];
  activeModelId: string | null;
  activeAccountAlias: string | null;
  state: ModelPickerState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, models, activeModelId, activeAccountAlias, state, tokens, borderStyle } = options;
  const innerWidth = Math.max(30, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const filtered = filterModels(models, state.query);
  const title = ` MODEL SELECTION (${filtered.length}/${models.length}) `;
  const rightMeta = ` Account: ${activeAccountAlias ?? 'none'} · Esc Close `;
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

  const searchBar = state.addingManual
    ? ` Enter Manual Model ID: ${state.manualDraft}█  (Enter Add & Select · Esc Cancel)`
    : ` Search Models: ${state.query}█  (Ctrl+R Refresh Live Catalog · Ctrl+A Add Manual ID)`;
  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      {
        text: searchBar.slice(0, innerWidth).padEnd(innerWidth, ' '),
        fg: state.addingManual ? tokens.warning : tokens.foreground,
        bg: tokens.backgroundElevated,
      },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  const maxRows = Math.max(4, height - 5);
  if (filtered.length === 0) {
    const emptyMsg = !activeAccountAlias
      ? ' No active provider account connected. Run /login first to authenticate.'
      : ` No models matching "${state.query}". Press Ctrl+R to discover or Ctrl+A to enter a manual model ID.`;
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: emptyMsg.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.warning, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  } else {
    const clampedIdx = Math.max(0, Math.min(filtered.length - 1, state.selectedIndex));
    const startIdx = Math.max(0, Math.min(clampedIdx - Math.floor(maxRows / 2), Math.max(0, filtered.length - maxRows)));
    const visible = filtered.slice(startIdx, startIdx + maxRows);

    visible.forEach((m, i) => {
      const absIdx = startIdx + i;
      const selected = absIdx === clampedIdx;
      const isCurrent = m.id === activeModelId;
      const rowBg = selected ? tokens.selection : bg;
      const rowFg = selected ? tokens.selectionForeground : tokens.foreground;
      const marker = isCurrent ? '●' : selected ? '▸' : ' ';
      const caps: string[] = [];
      if (m.capabilities.streaming === 'supported') caps.push('stream');
      if (m.capabilities.tools === 'supported') caps.push('tools');
      if (m.capabilities.reasoning === 'supported') caps.push('reason');
      if (m.capabilities.vision === 'supported') caps.push('vision');
      const capStr = caps.length > 0 ? `[${caps.join(',')}]` : '[basic]';
      const ctxStr = m.contextLimit ? `${Math.round(m.contextLimit / 1000)}k ctx` : '';
      const rightPart = `${capStr} ${ctxStr}`.trim();
      const leftMax = Math.max(12, innerWidth - rightPart.length - 6);
      const leftPart = ` ${marker} ${m.id}`.slice(0, leftMax).padEnd(leftMax, ' ');
      const fullLine = `${leftPart} ${rightPart}`.slice(0, innerWidth).padEnd(innerWidth, ' ');

      lines.push({
        spans: [
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
          {
            text: fullLine,
            fg: isCurrent ? tokens.accent : rowFg,
            bg: rowBg,
            bold: selected || isCurrent,
          },
          { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        ],
      });
    });
  }

  while (lines.length < height - 2) {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  }

  const statusLine = state.statusMessage ?? ' Select a model with Enter (Global) or Ctrl+P (Project-scoped).';
  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      { text: statusLine.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.info, bg: tokens.backgroundElevated },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  const footer = ' ↑/↓ Navigate · Enter Select Model · Tab Account · Ctrl+E Effort · Ctrl+R Discover · Ctrl+A Manual ID · Esc Close ';
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

// ============================================================================
// PROVIDER CONNECT & ACCOUNT MANAGEMENT OVERLAYS (/connect, /accounts)
// ============================================================================

export { createInitialConnectProviderState, renderConnectProviderOverlay, type ConnectProviderState } from './connect';

// ============================================================================
// COMMAND PALETTE (Ctrl+P), SETTINGS (/config), STATUS (/status), HELP (/help)
// ============================================================================

export interface CommandPaletteState {
  query: string;
  selectedIndex: number;
}

export function createInitialCommandPaletteState(): CommandPaletteState {
  return {
    query: '',
    selectedIndex: 0,
  };
}

export function filterPaletteCommands(query: string) {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (!q) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter(
    c =>
      c.command.toLowerCase().includes(q) ||
      c.title.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) || c.aliases.some(a => a.toLowerCase().includes(q)),
  );
}

export function renderCommandPaletteOverlay(options: {
  width: number;
  height: number;
  state: CommandPaletteState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, state, tokens, borderStyle } = options;
  const innerWidth = Math.max(30, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const matches = filterPaletteCommands(state.query);
  const title = ` COMMAND PALETTE (${matches.length}) `;
  const rightMeta = ' Enter Execute · Esc Close ';
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

  lines.push({
    spans: [
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      {
        text: ` ❯ ${state.query}█`.slice(0, innerWidth).padEnd(innerWidth, ' '),
        fg: tokens.foreground,
        bg: tokens.backgroundElevated,
        bold: true,
      },
      { text: glyphs.vertical, fg: tokens.borderFocused, bg },
    ],
  });

  const maxRows = Math.max(4, height - 4);
  const clampedIdx = Math.max(0, Math.min(Math.max(0, matches.length - 1), state.selectedIndex));
  const start = Math.max(0, clampedIdx - maxRows + 1);
  const visible = matches.slice(start, start + maxRows);

  visible.forEach((cmd, idx) => {
    const selected = start + idx === clampedIdx;
    const rowBg = selected ? tokens.selection : bg;
    const rowFg = selected ? tokens.selectionForeground : tokens.foreground;
    const left = ` ${selected ? '▸' : ' '} ${cmd.title.padEnd(26, ' ')} ${cmd.command.padEnd(13, ' ')} `;
    const right = cmd.shortcut ? ` [${cmd.shortcut}] ` : ' ';
    const descMax = Math.max(0, innerWidth - left.length - right.length);
    const desc = cmd.description.slice(0, descMax).padEnd(descMax, ' ');

    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: left, fg: selected ? tokens.accent : rowFg, bg: rowBg, bold: selected },
        { text: desc, fg: selected ? rowFg : tokens.foregroundMuted, bg: rowBg },
        { text: right, fg: tokens.info, bg: rowBg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  });

  while (lines.length < height - 1) {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  }

  const footer = ' ↑/↓ Navigate · Enter Run Command · Type to Filter · Esc Close ';
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

export interface SettingsOverlayState {
  selectedIndex: number;
}

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
  const innerWidth = Math.max(30, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const title = ' APPEARANCE & TUI SETTINGS (/config) ';
  const rightMeta = ' Enter/Space Toggle · ←/→ Adjust · Esc Close ';
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

  const rows = [
    { label: 'Active Theme', value: `${appearance.theme} (Press Enter to open /theme)` },
    { label: 'Color Mode', value: `${appearance.mode.toUpperCase()} (resolved: ${effectiveMode})` },
    { label: 'Live ASCII Wallpaper', value: appearance.wallpaper ?? 'none (cycle presets with ←/→)' },
    { label: 'Animations Enabled', value: appearance.animations.enabled ? 'ENABLED' : 'DISABLED' },
    { label: 'Motion Mode', value: appearance.animations.motion.toUpperCase() },
    { label: 'Animation Speed', value: `${appearance.animations.speed.toFixed(2)}x` },
    { label: 'Cell Size / Density', value: `${appearance.animations.cellSize}x` },
    { label: 'Readability Veil', value: `${Math.round(appearance.animations.veil * 100)}%` },
    { label: 'Reduced Motion', value: appearance.animations.reducedMotion ? 'ON' : 'OFF' },
    { label: 'Pause When Unfocused', value: appearance.animations.pauseUnfocused ? 'ON' : 'OFF' },
    { label: 'Reactive Agent Effects', value: appearance.animations.reactiveEffects ? 'ON' : 'OFF' },
    { label: 'Syntax Highlighting', value: appearance.syntaxHighlighting ? 'ON' : 'OFF' },
    { label: 'Sidebar Panel', value: appearance.sidebar ? 'VISIBLE' : 'COLLAPSED' },
  ];

  const clamped = Math.max(0, Math.min(rows.length - 1, selectedIndex));
  rows.forEach((r, idx) => {
    const selected = idx === clamped;
    const rowBg = selected ? tokens.selection : bg;
    const rowFg = selected ? tokens.selectionForeground : tokens.foreground;
    const line = ` ${selected ? '▸' : ' '} ${r.label.padEnd(26, ' ')} : ${r.value}`;
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: line.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: rowFg, bg: rowBg, bold: selected },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  });

  while (lines.length < height - 1) {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: ' '.repeat(innerWidth), fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  }

  const footer = ` ↑/↓ Select Setting · Enter/Space Toggle · ←/→ Adjust Value · Wallpapers: ${WALLPAPER_PRESET_IDS.length} · Esc Close `;
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

export function renderStatusOverlay(options: {
  width: number;
  height: number;
  status: ReturnType<import('@hannes/sdk').FutrynClient['status']>;
  appearance: AppearanceConfig;
  colorCapability: string;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, status, appearance, colorCapability, tokens, borderStyle } = options;
  const innerWidth = Math.max(30, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const title = ' FUTRYN SYSTEM & CAPABILITY STATUS (/status) ';
  const rightMeta = ' Esc Close ';
  const topFill = Math.max(0, innerWidth - title.length - rightMeta.length);

  lines.push({
    spans: [
      { text: glyphs.topLeft, fg: tokens.borderFocused, bg },
      { text: title, fg: tokens.accent, bg, bold: true },
      { text: glyphs.horizontal.repeat(topFill), fg: tokens.borderFocused, bg },
      { text: rightMeta, fg: tokens.foregroundMuted, bg },
      { text: glyphs.topRight, fg: tokens.borderFocused, bg },
    ],
  });

  const pushRow = (text: string, fg = tokens.foreground, bold = false) => {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: text.slice(0, innerWidth).padEnd(innerWidth, ' '), fg, bg, bold },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  };

  pushRow(` Workspace       : ${status.workspace}`, tokens.foreground, true);
  pushRow(` Agent Mode      : ${status.mode.toUpperCase()}`, tokens.info);
  pushRow(
    ` Active Provider : ${status.activeProvider ? `${status.activeProvider.name} (${status.activeProvider.id})` : 'None'}`,
  );
  pushRow(
    ` Active Account  : ${status.activeAccount ? `${status.activeAccount.alias} [${status.activeAccount.status}]` : 'None (/login to add)'}`,
    status.activeAccount?.status === 'valid' ? tokens.success : tokens.warning,
  );
  pushRow(
    ` Active Model    : ${status.selection ? status.selection.modelId : 'None (/model to select)'}`,
    status.selection ? tokens.accent : tokens.warning,
  );
  pushRow(` Connectivity    : last validated ${status.activeAccount?.validatedAt ?? 'never'} · /doctor checks live`, tokens.foregroundMuted);
  pushRow(` Active Session  : ${status.activeSessionId ?? 'None'} (${status.messageCount} messages)`);
  pushRow(
    ` Theme & Visuals : ${appearance.theme} · mode=${appearance.mode} · wallpaper=${appearance.wallpaper ?? 'none'} · color=${colorCapability}`,
    tokens.info,
  );
  pushRow('');
  pushRow(' Backend Slice Capabilities (PA1 + TUI1 Truthfulness Matrix):', tokens.markdownHeading, true);
  for (const [k, v] of Object.entries(status.capabilities)) {
    const implemented = v === 'implemented';
    pushRow(
      `   ${implemented ? '✓' : '○'} ${k.padEnd(26, ' ')} : ${implemented ? 'Implemented & Active' : 'Not implemented in PA1/TUI1'}`,
      implemented ? tokens.success : tokens.foregroundSubtle,
    );
  }

  while (lines.length < height - 1) {
    pushRow('');
  }

  const footer = ' Press Esc to return to conversation ';
  const footerFill = Math.max(0, innerWidth - footer.length);
  lines.push({
    spans: [
      { text: glyphs.bottomLeft, fg: tokens.borderFocused, bg },
      { text: footer, fg: tokens.foregroundSubtle, bg },
      { text: glyphs.horizontal.repeat(footerFill), fg: tokens.borderFocused, bg },
      { text: glyphs.bottomRight, fg: tokens.borderFocused, bg },
    ],
  });

  return lines;
}

export function renderHelpOverlay(options: {
  scrollOffset?: number;
  width: number;
  height: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, tokens, borderStyle } = options;
  const innerWidth = Math.max(30, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const title = ' KEYBOARD SHORTCUTS & SLASH COMMANDS (/help) ';
  const rightMeta = ' Esc Close ';
  const topFill = Math.max(0, innerWidth - title.length - rightMeta.length);

  lines.push({
    spans: [
      { text: glyphs.topLeft, fg: tokens.borderFocused, bg },
      { text: title, fg: tokens.accent, bg, bold: true },
      { text: glyphs.horizontal.repeat(topFill), fg: tokens.borderFocused, bg },
      { text: rightMeta, fg: tokens.foregroundMuted, bg },
      { text: glyphs.topRight, fg: tokens.borderFocused, bg },
    ],
  });

  const pushRow = (text: string, fg = tokens.foreground, bold = false) => {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
        { text: text.slice(0, innerWidth).padEnd(innerWidth, ' '), fg, bg, bold },
        { text: glyphs.vertical, fg: tokens.borderFocused, bg },
      ],
    });
  };

  pushRow(' Global Keyboard Navigation:', tokens.markdownHeading, true);
  pushRow('   Ctrl+P       Open Command Palette           Ctrl+T       Open /theme Picker');
  pushRow('   Ctrl+L       Open /model Picker            Ctrl+S       Open /resume Picker');
  pushRow('   Ctrl+N       Start New Session              Ctrl+D       Open /diff Viewer');
  pushRow('   Ctrl+B       Toggle Sidebar                 Shift+Tab    View mode only; tool modes unavailable');
  pushRow('   /            Slash Command Autocomplete     @            Workspace File Autocomplete');
  pushRow('   Esc          Close Dialog / Cancel Stream    Ctrl+C       Interrupt / Clear Draft / Exit');
  pushRow('   !            Shell mode: Not implemented     Alt+Enter    Newline (also Ctrl+J)');
  pushRow('   Ctrl+R       Toggle reasoning summary        /model: Ctrl+E cycles active model effort');
  pushRow('');
  pushRow(' Slash Commands:', tokens.markdownHeading, true);
  for (const cmd of SLASH_COMMANDS) {
    pushRow(`   ${cmd.command.padEnd(14, ' ')} ${cmd.title.padEnd(26, ' ')} ${cmd.description}`, tokens.foregroundMuted);
  }

  while (lines.length < height - 1) {
    pushRow('');
  }

  const footer = ' ↑/↓ or PgUp/PgDown Scroll · Esc Close ';
  const footerFill = Math.max(0, innerWidth - footer.length);
  lines.push({
    spans: [
      { text: glyphs.bottomLeft, fg: tokens.borderFocused, bg },
      { text: footer, fg: tokens.foregroundSubtle, bg },
      { text: glyphs.horizontal.repeat(footerFill), fg: tokens.borderFocused, bg },
      { text: glyphs.bottomRight, fg: tokens.borderFocused, bg },
    ],
  });

  const body = lines.slice(1, -1);
  const room = Math.max(1, height - 2);
  const offset = Math.max(0, Math.min(options.scrollOffset ?? 0, Math.max(0, body.length - room)));
  return [lines[0]!, ...body.slice(offset, offset + room), lines.at(-1)!];
}
