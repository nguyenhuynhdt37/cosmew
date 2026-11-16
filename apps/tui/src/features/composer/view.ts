import {graphemes, textWidth, nextGrapheme} from '../../input/text';
import type {BorderStyle, PermissionMode, ThemeTokens} from '@futryn/contracts';
import type {AgentMode} from '@futryn/sdk';
import {getBorderGlyphs} from '../../theme/theme';
import type {RenderedBoxLine, StyledSpan} from '../../ui';
import {getMatchingSlashCommands} from './logic';
import type {ComposerState} from './types';

/**
 * Prompt composer as a soft card: rounded frame, one text row, pill footer.
 * Mode reads Chat / Plan / Review. Focus tints the border with the accent token.
 */
/** Chip text for each permission mode; Shift+Tab cycles them. */
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan',
  bypassPermissions: 'Bypass',
};

export function renderPromptComposerLines(options: {
  width: number;
  state: ComposerState;
  mode: AgentMode;
  /** Shown instead of the view mode once known (ADR 0027). */
  permissionMode?: PermissionMode;
  activeModelLabel: string;
  activeAccountLabel: string;
  isStreaming: boolean;
  focused: boolean;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  workspaceFiles?: string[];
  maxHeight?: number;
  telemetryLabel?: string;
  contextLine?: RenderedBoxLine;
  placeholder?: string;
}): RenderedBoxLine[] {
  const {
    width,
    state,
    mode,
    permissionMode,
    activeModelLabel,
    activeAccountLabel,
    isStreaming,
    focused,
    tokens,
    borderStyle,
    workspaceFiles = [],
  } = options;

  const glyphs = getBorderGlyphs(borderStyle);
  const innerWidth = Math.max(0, width - 2);
  const bg = tokens.composerBackground;
  // Subtle border color change on focus
  const borderColor = focused ? tokens.borderFocused : tokens.border;
  const lines: RenderedBoxLine[] = [];

  const fill = (text: string, len: number) => text.slice(0, len).padEnd(len, ' ');

  // 1. Autocomplete Popup Menu (Slash commands or @file mentions)
  const popupItems: {label: string; hint: string}[] = [];
  let popupHeader = '';
  const popupLimit = Math.min(5, Math.max(0, (options.maxHeight ?? 20) - 7 - (options.contextLine ? 1 : 0)));
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
      popupItems.push({label: `@${f}`, hint: ''});
    }
  }

  if (popupItems.length > 0) {
    const selIdx = state.slashMenuOpen
      ? state.slashSelectedIndex -
        Math.max(
          0,
          Math.min(
            state.slashSelectedIndex - popupLimit + 1,
            getMatchingSlashCommands(state.value).length - popupLimit,
          ),
        )
      : state.fileSelectedIndex % popupItems.length;
    const topTitle = ` ${popupHeader} `;
    const padTop = Math.max(0, innerWidth - topTitle.length - 1);

    lines.push({
      spans: [
        {text: `${glyphs.topLeft}${glyphs.horizontal}`, fg: tokens.accent, bg: tokens.overlayBackground},
        {text: topTitle, fg: tokens.accent, bg: tokens.overlayBackground, bold: true},
        {
          text: `${glyphs.horizontal.repeat(padTop)}${glyphs.topRight}`,
          fg: tokens.accent,
          bg: tokens.overlayBackground,
        },
      ],
    });

    popupItems.forEach((item, idx) => {
      const isSelected = idx === selIdx;
      const rowBg = isSelected ? tokens.selection : tokens.overlayBackground;
      const rowFg = isSelected ? tokens.selectionForeground : tokens.foreground;
      const marker = isSelected ? '▸ ' : '  ';
      const labelWidth = Math.min(14, Math.max(1, innerWidth - 2));
      const labelCol = `${marker}${item.label}`.slice(0, labelWidth).padEnd(labelWidth, ' ');
      const hintMax = Math.max(0, innerWidth - labelCol.length - 2);
      const hintCol = fill(item.hint, hintMax);

      lines.push({
        spans: [
          {text: glyphs.vertical, fg: tokens.accent, bg: tokens.overlayBackground},
          {text: ` ${labelCol}`, fg: isSelected ? tokens.accent : rowFg, bg: rowBg, bold: isSelected},
          {text: `${hintCol} `, fg: isSelected ? rowFg : tokens.foregroundMuted, bg: rowBg},
          {text: glyphs.vertical, fg: tokens.accent, bg: tokens.overlayBackground},
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
    lines.push({spans: []});
  }

  // 2. Composer frame. A quiet label on the rule, a prompt mark, then a footer.
  const title = '';
  const titleDash = title.length > 0 ? glyphs.horizontal : '';
  const titleRest = Math.max(0, innerWidth - title.length - titleDash.length);
  lines.push({
    spans: [
      {text: `${glyphs.topLeft}${titleDash}`, fg: borderColor, bg},
      {text: title, fg: tokens.foregroundSubtle, bg},
      {text: `${glyphs.horizontal.repeat(titleRest)}${glyphs.topRight}`, fg: borderColor, bg},
    ],
  });

  // 3. Text input. One row until the draft wraps. The prompt mark stays on the first line.
  const lead = '  › ';
  const textCols = Math.max(1, innerWidth - lead.length);
  const placeholder = isStreaming
    ? 'Replying…'
    : options.placeholder && options.placeholder.length <= textCols - 1
      ? options.placeholder
      : 'Ask anything…';

  const pushInputRow = (body: StyledSpan[], prefix: string) => {
    const used = body.reduce((sum, span) => sum + textWidth(span.text), 0);
    const markAt = Math.max(0, prefix.length - 2);
    lines.push({
      spans: [
        {text: glyphs.vertical, fg: borderColor, bg},
        {text: prefix.slice(0, markAt), fg: tokens.foreground, bg},
        {text: prefix.slice(markAt, markAt + 1), fg: tokens.accent, bg},
        {text: prefix.slice(markAt + 1), fg: tokens.foreground, bg},
        ...body,
        {text: ' '.repeat(Math.max(0, textCols - used)), fg: tokens.foreground, bg},
        {text: glyphs.vertical, fg: borderColor, bg},
      ],
    });
  };

  if (state.value.length === 0) {
    const cursorGlyph = focused ? '▌' : ' ';
    const shown = placeholder.slice(0, Math.max(0, textCols - 1));
    pushInputRow(
      [
        {text: cursorGlyph, fg: tokens.cursor, bg, bold: true},
        {text: shown, fg: tokens.foregroundSubtle, bg},
      ],
      lead,
    );
  } else {
    const visual: {text: string; start: number}[] = [];
    let offset = 0;
    for (const line of state.value.split('\n')) {
      let rowText = '';
      let rowStart = offset;
      let columns = 0;
      for (const {segment, index} of graphemes(line)) {
        const cells = textWidth(segment);
        if (columns + cells > textCols && rowText) {
          visual.push({text: rowText, start: rowStart});
          rowText = '';
          rowStart = offset + index;
          columns = 0;
        }
        rowText += segment;
        columns += cells;
      }
      visual.push({text: rowText, start: rowStart});
      if (columns === textCols) visual.push({text: '', start: offset + line.length});
      offset += line.length + 1;
    }
    const cursorRow = Math.max(
      0,
      visual.findLastIndex(row => row.start <= state.cursor),
    );
    const maxInput = Math.max(
      1,
      Math.min(6, (options.maxHeight ?? 20) - lines.length - 3 - (options.contextLine ? 1 : 0)),
    );
    const first = Math.max(0, cursorRow - maxInput + 1);
    for (const [index, row] of visual.slice(first, first + maxInput).entries()) {
      const cursorCol = state.cursor - row.start;
      const hasCursor = focused && first + index === cursorRow;
      pushInputRow(
        hasCursor
          ? [
              {text: row.text.slice(0, cursorCol), fg: tokens.foreground, bg},
              {
                text: row.text.slice(cursorCol, nextGrapheme(row.text, cursorCol)) || ' ',
                fg: tokens.accentForeground,
                bg: tokens.cursor,
                bold: true,
              },
              {text: row.text.slice(nextGrapheme(row.text, cursorCol)), fg: tokens.foreground, bg},
            ]
          : [{text: row.text, fg: tokens.foreground, bg}],
        first + index === 0 ? lead : ' '.repeat(lead.length),
      );
    }
  }

  lines.push({
    spans: [
      {
        text: `${glyphs.bottomLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.bottomRight}`,
        fg: borderColor,
        bg,
      },
    ],
  });

  const modeName = permissionMode
    ? PERMISSION_LABELS[permissionMode]
    : mode === 'plan'
      ? 'Plan'
      : mode === 'review'
        ? 'Review'
        : 'Chat';
  const modeColor =
    permissionMode === 'bypassPermissions'
      ? tokens.error
      : permissionMode === 'auto' || permissionMode === 'acceptEdits'
        ? tokens.warning
        : permissionMode === 'plan'
          ? tokens.info
          : permissionMode
            ? tokens.accent
            : mode === 'plan'
              ? tokens.warning
              : mode === 'review'
                ? tokens.info
                : tokens.accent;
  const modeChip = ` ${modeName} `;
  const meta = `${activeModelLabel}${activeAccountLabel ? `  ·  ${activeAccountLabel}` : ''}`;
  const shortHints: StyledSpan[] = [
    {text: '@', fg: tokens.accent, bg},
    {text: '  ', fg: tokens.foregroundSubtle, bg},
    {text: '/', fg: tokens.accent, bg},
  ];
  const longHints: StyledSpan[] = [
    {text: '@', fg: tokens.accent, bg},
    {text: ' files   ', fg: tokens.foregroundSubtle, bg},
    {text: '/', fg: tokens.accent, bg},
    {text: ' commands', fg: tokens.foregroundSubtle, bg},
  ];
  const hintLenOf = (parts: StyledSpan[]) => parts.reduce((sum, span) => sum + span.text.length, 0);
  const roomFor = (hintLen: number) => Math.max(0, innerWidth - modeChip.length - 1 - hintLen);
  const hintParts = isStreaming
    ? [{text: innerWidth >= 40 ? 'Esc interrupt' : 'Esc', fg: tokens.foregroundSubtle, bg}]
    : options.telemetryLabel
      ? [{text: options.telemetryLabel, fg: tokens.foregroundMuted, bg}]
      : meta.length + 2 <= roomFor(hintLenOf(longHints))
        ? longHints
        : shortHints;
  const metaRoom = Math.max(0, roomFor(hintLenOf(hintParts)) - 1);
  const truncate = (value: string, room: number) =>
    value.length <= room ? value : room > 1 ? value.slice(0, room - 1) + '…' : value.slice(0, room);
  const account = activeAccountLabel ? ` · ${activeAccountLabel}` : '';
  const shownMeta =
    meta.length <= metaRoom
      ? meta
      : account && metaRoom >= account.length + 6
        ? truncate(activeModelLabel, metaRoom - account.length) + account
        : truncate(meta, metaRoom);
  const gap = Math.max(0, metaRoom - shownMeta.length) + 1;

  lines.push({
    spans: [
      {text: ' ', fg: borderColor, bg: tokens.background},
      {text: modeChip, fg: modeColor, bg: tokens.backgroundElevated, bold: true},
      {text: ' ', fg: tokens.foreground, bg},
      {text: shownMeta, fg: tokens.foregroundSubtle, bg},
      {text: ' '.repeat(gap), fg: tokens.foreground, bg},
      ...hintParts,
      {text: ' ', fg: borderColor, bg: tokens.background},
    ],
  });

  if (options.contextLine) lines.push(options.contextLine);
  return lines.map(line => {
    let room = Math.max(0, width);
    const spans: StyledSpan[] = [];
    for (const span of line.spans) {
      let text = '';
      for (const {segment} of graphemes(span.text)) {
        const cells = textWidth(segment);
        if (cells > room) break;
        text += segment;
        room -= cells;
      }
      if (text) spans.push({...span, text});
      if (!room) break;
    }
    return {...line, spans};
  });
}
