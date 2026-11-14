import type { BorderStyle, ThemeTokens } from '@hannes/contracts';
import type { AgentMode } from '@hannes/sdk';
import { getBorderGlyphs } from '../theme/theme';

export { SLASH_COMMANDS, type SlashCommandDef } from '@hannes/sdk';
import { SLASH_COMMANDS, type SlashCommandDef } from '@hannes/sdk';

export interface ComposerState {
  value: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  draftBeforeHistory: string;
  slashMenuOpen: boolean;
  slashSelectedIndex: number;
  fileMenuOpen: boolean;
  fileSelectedIndex: number;
  fileQuery: string;
  attachedFiles: string[];
}

export function createInitialComposerState(): ComposerState {
  return {
    value: '',
    cursor: 0,
    history: [],
    historyIndex: -1,
    draftBeforeHistory: '',
    slashMenuOpen: false,
    slashSelectedIndex: 0,
    fileMenuOpen: false,
    fileSelectedIndex: 0,
    fileQuery: '',
    attachedFiles: [],
  };
}

export function getMatchingSlashCommands(input: string): SlashCommandDef[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return [];
  const q = trimmed.toLowerCase();
  const ranked = (item: SlashCommandDef) => [item.command, ...item.aliases].some(name => name.toLowerCase() === q) ? 0 : [item.command, ...item.aliases].some(name => name.toLowerCase().startsWith(q)) ? 1 : 2;
  return SLASH_COMMANDS.filter(
    item =>
      item.command.toLowerCase().startsWith(q) ||
      item.aliases.some(a => a.toLowerCase().startsWith(q)) ||
      item.title.toLowerCase().includes(q.slice(1)) ||
      item.command.toLowerCase().includes(q),
  ).sort((a, b) => ranked(a) - ranked(b));
}

export function extractActiveFileMention(value: string, cursor: number): { start: number; query: string } | null {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  const start = before.lastIndexOf('@');
  return start >= 0 ? { start, query } : null;
}

export function updateComposerValue(
  state: ComposerState,
  nextValue: string,
  nextCursor = nextValue.length,
): ComposerState {
  const clampedCursor = Math.max(0, Math.min(nextValue.length, nextCursor));
  const trimmed = nextValue.trimStart();
  const slashMatches = trimmed.startsWith('/') ? getMatchingSlashCommands(trimmed) : [];
  const fileMention = extractActiveFileMention(nextValue, clampedCursor);

  return {
    ...state,
    value: nextValue,
    cursor: clampedCursor,
    slashMenuOpen: slashMatches.length > 0 && !trimmed.includes('\n'),
    slashSelectedIndex: 0,
    fileMenuOpen: fileMention !== null,
    fileSelectedIndex: 0,
    fileQuery: fileMention?.query ?? '',
  };
}

export function applyFileReferenceSelection(state: ComposerState, filePath: string): ComposerState {
  const mention = extractActiveFileMention(state.value, state.cursor);
  if (!mention) return state;
  const prefix = state.value.slice(0, mention.start);
  const suffix = state.value.slice(state.cursor);
  const inserted = `@${filePath} `;
  const nextValue = `${prefix}${inserted}${suffix}`;
  const nextAttached = state.attachedFiles.includes(filePath)
    ? state.attachedFiles
    : [...state.attachedFiles, filePath];
  return {
    ...updateComposerValue(state, nextValue, prefix.length + inserted.length),
    fileMenuOpen: false,
    attachedFiles: nextAttached,
  };
}

export function recordComposerHistory(state: ComposerState, submitted: string): ComposerState {
  const clean = submitted.trim();
  const nextHistory = clean
    ? [...state.history.filter(h => h !== clean), clean].slice(-100)
    : state.history;
  return {
    ...createInitialComposerState(),
    history: nextHistory,
  };
}

export function navigateComposerHistory(state: ComposerState, direction: 'up' | 'down'): ComposerState {
  if (state.history.length === 0) return state;
  if (direction === 'up') {
    if (state.historyIndex === -1) {
      const idx = state.history.length - 1;
      const val = state.history[idx] ?? '';
      return {
        ...updateComposerValue(state, val, val.length),
        draftBeforeHistory: state.value,
        historyIndex: idx,
        slashMenuOpen: false,
      };
    }
    if (state.historyIndex > 0) {
      const idx = state.historyIndex - 1;
      const val = state.history[idx] ?? '';
      return {
        ...updateComposerValue(state, val, val.length),
        historyIndex: idx,
        slashMenuOpen: false,
      };
    }
    return state;
  }

  if (state.historyIndex === -1) return state;
  if (state.historyIndex < state.history.length - 1) {
    const idx = state.historyIndex + 1;
    const val = state.history[idx] ?? '';
    return {
      ...updateComposerValue(state, val, val.length),
      historyIndex: idx,
      slashMenuOpen: false,
    };
  }
  return {
    ...updateComposerValue(state, state.draftBeforeHistory, state.draftBeforeHistory.length),
    historyIndex: -1,
    slashMenuOpen: false,
  };
}

export interface StyledSpan {
  text: string;
  fg: string;
  bg?: string;
  bold?: boolean;
}

export interface RenderedBoxLine {
  spans: StyledSpan[];
}

/**
 * Prompt composer as a soft card: rounded frame, one text row, pill footer.
 * Mode reads Chat / Plan / Review. Focus tints the border with the accent token.
 */
export function renderPromptComposerLines(options: {
  width: number;
  state: ComposerState;
  mode: AgentMode;
  activeModelLabel: string;
  activeAccountLabel: string;
  isStreaming: boolean;
  focused: boolean;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  workspaceFiles?: string[];
  maxHeight?: number;
  telemetryLabel?: string;
}): RenderedBoxLine[] {
  const {
    width,
    state,
    mode,
    activeModelLabel,
    activeAccountLabel,
    isStreaming,
    focused,
    tokens,
    borderStyle,
    workspaceFiles = [],
  } = options;

  const glyphs = getBorderGlyphs(borderStyle);
  const innerWidth = Math.max(16, width - 2);
  const bg = tokens.composerBackground;
  // Subtle border color change on focus
  const borderColor = focused ? tokens.borderFocused : tokens.border;
  const lines: RenderedBoxLine[] = [];

  const fill = (text: string, len: number) => text.slice(0, len).padEnd(len, ' ');

  // 1. Autocomplete Popup Menu (Slash commands or @file mentions)
  const popupItems: { label: string; hint: string }[] = [];
  let popupHeader = '';
  const popupLimit = Math.min(5, Math.max(0, (options.maxHeight ?? 20) - 8));
  if (state.slashMenuOpen) {
    const allMatches = getMatchingSlashCommands(state.value);
    const start = Math.max(0, Math.min(state.slashSelectedIndex - popupLimit + 1, allMatches.length - popupLimit));
    const matches = allMatches.slice(start, start + popupLimit);
    popupHeader = `Commands (${allMatches.length})`;
    for (const cmd of matches) {
      popupItems.push({
        label: cmd.command,
        hint: `${cmd.unavailable ? 'Unavailable · ' : ''}${cmd.description}${cmd.shortcut ? `  [${cmd.shortcut}]` : ''}`,
      });
    }
  } else if (state.fileMenuOpen && workspaceFiles.length > 0) {
    const topFiles = workspaceFiles.slice(0, popupLimit);
    popupHeader = `Files (${workspaceFiles.length})`;
    for (const f of topFiles) {
      popupItems.push({ label: `@${f}`, hint: '' });
    }
  }

  if (popupItems.length > 0) {
    const selIdx =
      state.slashMenuOpen
        ? state.slashSelectedIndex - Math.max(0, Math.min(state.slashSelectedIndex - popupLimit + 1, getMatchingSlashCommands(state.value).length - popupLimit))
        : state.fileSelectedIndex % popupItems.length;
    const topTitle = ` ${popupHeader} `;
    const padTop = Math.max(0, innerWidth - topTitle.length - 1);

    lines.push({
      spans: [
        { text: `${glyphs.topLeft}${glyphs.horizontal}`, fg: tokens.accent, bg: tokens.overlayBackground },
        { text: topTitle, fg: tokens.accent, bg: tokens.overlayBackground, bold: true },
        { text: `${glyphs.horizontal.repeat(padTop)}${glyphs.topRight}`, fg: tokens.accent, bg: tokens.overlayBackground },
      ],
    });

    popupItems.forEach((item, idx) => {
      const isSelected = idx === selIdx;
      const rowBg = isSelected ? tokens.selection : tokens.overlayBackground;
      const rowFg = isSelected ? tokens.selectionForeground : tokens.foreground;
      const marker = isSelected ? '▸ ' : '  ';
      const labelWidth = Math.min(20, Math.max(1, innerWidth - 2));
      const labelCol = `${marker}${item.label}`.slice(0, labelWidth).padEnd(labelWidth, ' ');
      const hintMax = Math.max(0, innerWidth - labelCol.length - 2);
      const hintCol = fill(item.hint, hintMax);

      lines.push({
        spans: [
          { text: glyphs.vertical, fg: tokens.accent, bg: tokens.overlayBackground },
          { text: ` ${labelCol}`, fg: isSelected ? tokens.accent : rowFg, bg: rowBg, bold: isSelected },
          { text: `${hintCol} `, fg: isSelected ? rowFg : tokens.foregroundMuted, bg: rowBg },
          { text: glyphs.vertical, fg: tokens.accent, bg: tokens.overlayBackground },
        ],
      });
    });

    lines.push({
      spans: [
        {
          text: `${glyphs.bottomLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.bottomRight}`,
          fg: tokens.accent,
          bg: tokens.overlayBackground,
        },
      ],
    });
    // Khoảng đệm giữa popup và composer
    lines.push({ spans: [] });
  }

  // 2. Composer frame. A quiet label on the rule, a prompt mark, then a footer.
  const title = '';
  const titleDash = title.length > 0 ? glyphs.horizontal : '';
  const titleRest = Math.max(0, innerWidth - title.length - titleDash.length);
  lines.push({
    spans: [
      { text: `${glyphs.topLeft}${titleDash}`, fg: borderColor, bg },
      { text: title, fg: tokens.foregroundSubtle, bg },
      { text: `${glyphs.horizontal.repeat(titleRest)}${glyphs.topRight}`, fg: borderColor, bg },
    ],
  });

  // 3. Text input. One row until the draft wraps. The prompt mark stays on the first line.
  const lead = '  › ';
  const textCols = Math.max(1, innerWidth - lead.length);
  const placeholder = isStreaming ? 'Replying…' : 'Ask anything…';

  const pushInputRow = (body: StyledSpan[], prefix: string) => {
    const used = body.reduce((sum, span) => sum + span.text.length, 0);
    const markAt = Math.max(0, prefix.length - 2);
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: borderColor, bg },
        { text: prefix.slice(0, markAt), fg: tokens.foreground, bg },
        { text: prefix.slice(markAt, markAt + 1), fg: tokens.accent, bg },
        { text: prefix.slice(markAt + 1), fg: tokens.foreground, bg },
        ...body,
        { text: ' '.repeat(Math.max(0, textCols - used)), fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: borderColor, bg },
      ],
    });
  };

  if (state.value.length === 0) {
    const cursorGlyph = focused ? '▌' : ' ';
    const shown = placeholder.slice(0, Math.max(0, textCols - 1));
    pushInputRow([
      { text: cursorGlyph, fg: tokens.cursor, bg, bold: true },
      { text: shown, fg: tokens.foregroundSubtle, bg },
    ], lead);
  } else {
    const visual: { text: string; start: number }[] = [];
    let offset = 0;
    for (const line of state.value.split('\n')) {
      for (let start = 0; start <= line.length; start += textCols) {
        visual.push({ text: line.slice(start, start + textCols), start: offset + start });
        if (start + textCols > line.length) break;
      }
      offset += line.length + 1;
    }
    const cursorRow = Math.max(0, visual.findLastIndex(row => row.start <= state.cursor));
    const maxInput = Math.max(1, Math.min(6, (options.maxHeight ?? 20) - lines.length - 3));
    const first = Math.max(0, cursorRow - maxInput + 1);
    for (const [index, row] of visual.slice(first, first + maxInput).entries()) {
      const cursorCol = state.cursor - row.start;
      const hasCursor = focused && first + index === cursorRow;
      pushInputRow(hasCursor ? [
        { text: row.text.slice(0, cursorCol), fg: tokens.foreground, bg },
        { text: row.text[cursorCol] ?? ' ', fg: tokens.accentForeground, bg: tokens.cursor, bold: true },
        { text: row.text.slice(cursorCol + 1), fg: tokens.foreground, bg },
      ] : [{ text: row.text, fg: tokens.foreground, bg }], first + index === 0 ? lead : ' '.repeat(lead.length));
    }
  }

  lines.push({ spans: [{
    text: `${glyphs.bottomLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.bottomRight}`,
    fg: borderColor, bg,
  }] });

  const modeName = mode === 'plan' ? 'Plan' : mode === 'review' ? 'Review' : 'Chat';
  const modeColor = mode === 'plan' ? tokens.warning : mode === 'review' ? tokens.info : tokens.accent;
  const modeChip = ` ${modeName} `;
  const meta = `${activeModelLabel}${activeAccountLabel ? `  ·  ${activeAccountLabel}` : ''}${options.telemetryLabel ? ` · ${options.telemetryLabel}` : ''}`;
  const shortHints: StyledSpan[] = [
    { text: '@', fg: tokens.accent, bg },
    { text: '  ', fg: tokens.foregroundSubtle, bg },
    { text: '/', fg: tokens.accent, bg },
  ];
  const longHints: StyledSpan[] = [
    { text: '@', fg: tokens.accent, bg },
    { text: ' files   ', fg: tokens.foregroundSubtle, bg },
    { text: '/', fg: tokens.accent, bg },
    { text: ' commands', fg: tokens.foregroundSubtle, bg },
  ];
  const hintLenOf = (parts: StyledSpan[]) => parts.reduce((sum, span) => sum + span.text.length, 0);
  const roomFor = (hintLen: number) => Math.max(0, innerWidth - modeChip.length - 1 - hintLen);
  const hintParts = isStreaming
    ? [{ text: 'Esc', fg: tokens.foregroundSubtle, bg }]
    : meta.length + 2 <= roomFor(hintLenOf(longHints))
      ? longHints
      : shortHints;
  const metaRoom = roomFor(hintLenOf(hintParts));
  const shownMeta = meta.slice(0, meta.length + 2 <= metaRoom ? meta.length : Math.max(0, metaRoom - 2));
  const gap = Math.max(0, metaRoom - shownMeta.length);

  lines.push({
    spans: [
      { text: ' ', fg: borderColor, bg: tokens.background },
      { text: modeChip, fg: modeColor, bg: tokens.backgroundElevated, bold: true },
      { text: ' ', fg: tokens.foreground, bg },
      { text: shownMeta, fg: tokens.foregroundSubtle, bg },
      { text: ' '.repeat(gap), fg: tokens.foreground, bg },
      ...hintParts,
      { text: ' ', fg: borderColor, bg: tokens.background },
    ],
  });

  return lines;
}
