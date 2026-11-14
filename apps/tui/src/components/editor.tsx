import type { BorderStyle, ThemeTokens } from '@hannes/contracts';
import type { AgentMode } from '@hannes/sdk';
import { getBorderGlyphs } from '../theme/theme';

export interface SlashCommandDef {
  command: string;
  aliases: string[];
  title: string;
  description: string;
  category: 'Navigation' | 'Appearance' | 'Providers & Models' | 'Sessions' | 'Workspace & Security';
  shortcut?: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    command: '/theme',
    aliases: ['/themes'],
    title: 'Theme Picker',
    description: 'Browse Featured, Colors, Live ASCII Wallpapers, and My Themes with live preview',
    category: 'Appearance',
    shortcut: 'Ctrl+T',
  },
  {
    command: '/theme edit',
    aliases: ['/editor', '/customize'],
    title: 'Theme Editor',
    description: 'Customize semantic tokens, wallpaper settings, duplicate, import, or export themes',
    category: 'Appearance',
  },
  {
    command: '/model',
    aliases: ['/models'],
    title: 'Select Model',
    description: 'Search and select active model from discovered or cached provider catalog',
    category: 'Providers & Models',
    shortcut: 'Ctrl+L',
  },
  {
    command: '/login',
    aliases: ['/connect'],
    title: 'Connect Provider Account',
    description: 'Search providers and supported API key, environment or no-auth methods',
    category: 'Providers & Models',
  },
  {
    command: '/logout', aliases: [], title: 'Sign Out',
    description: 'Manage accounts and delete local credentials', category: 'Providers & Models',
  },
  {
    command: '/doctor', aliases: [], title: 'Diagnose Connection',
    description: 'Validate active provider connectivity and runtime configuration', category: 'Providers & Models',
  },
  {
    command: '/mcp', aliases: [], title: 'MCP Management',
    description: 'Not implemented in PA1/TUI1; MCP authentication is separate', category: 'Workspace & Security',
  },
  {
    command: '/plugin', aliases: ['/plugins'], title: 'Plugin Management',
    description: 'Not implemented in PA1/TUI1; no plugin host is enabled', category: 'Workspace & Security',
  },
  {
    command: '/compact', aliases: [], title: 'Compact Context',
    description: 'Not implemented: summarization and provenance backend unavailable', category: 'Sessions',
  },
  {
    command: '/accounts',
    aliases: ['/account'],
    title: 'Switch Account',
    description: 'Manage connected provider accounts, switch active account, or log out',
    category: 'Providers & Models',
  },
  {
    command: '/resume',
    aliases: ['/sessions', '/continue'],
    title: 'Session Picker',
    description: 'Browse, search, resume, or delete saved conversation sessions',
    category: 'Sessions',
    shortcut: 'Ctrl+S',
  },
  {
    command: '/new',
    aliases: [],
    title: 'New Session',
    description: 'Start a fresh conversation session with the current model selection',
    category: 'Sessions',
    shortcut: 'Ctrl+N',
  },
  {
    command: '/permissions',
    aliases: ['/perm'],
    title: 'Permission Requests',
    description: 'Inspect and resolve pending security permission prompts (Allow once / Session / Deny)',
    category: 'Workspace & Security',
  },
  {
    command: '/diff',
    aliases: [],
    title: 'Workspace Diff Viewer',
    description: 'Inspect git working tree changes with syntax-colored unified diff hunks',
    category: 'Workspace & Security',
    shortcut: 'Ctrl+D',
  },
  {
    command: '/config',
    aliases: ['/settings'],
    title: 'Appearance & TUI Settings',
    description: 'Configure dark/light/system mode, animation speed, veil, motion, and sidebar',
    category: 'Appearance',
  },
  {
    command: '/status',
    aliases: [],
    title: 'System & Provider Status',
    description: 'View active provider, account, model, session stats, and backend capabilities',
    category: 'Navigation',
  },
  {
    command: '/clear',
    aliases: [],
    title: 'Clear Conversation',
    description: 'Start a fresh conversation; previous sessions remain available via /resume',
    category: 'Sessions',
  },
  {
    command: '/help',
    aliases: ['/?'],
    title: 'Keyboard & Command Help',
    description: 'Show all FUTRYN keyboard shortcuts, slash commands, and navigation rules',
    category: 'Navigation',
  },
  {
    command: '/exit',
    aliases: ['/quit'],
    title: 'Exit FUTRYN',
    description: 'Restore terminal state cleanly and exit the TUI',
    category: 'Navigation',
    shortcut: 'Ctrl+C',
  },
];

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
  return SLASH_COMMANDS.filter(
    item =>
      item.command.toLowerCase().startsWith(q) ||
      item.aliases.some(a => a.toLowerCase().startsWith(q)) ||
      item.title.toLowerCase().includes(q.slice(1)) ||
      item.command.toLowerCase().includes(q),
  );
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
  if (state.slashMenuOpen) {
    const matches = getMatchingSlashCommands(state.value).slice(0, 5);
    popupHeader = `Commands (${matches.length})`;
    for (const cmd of matches) {
      popupItems.push({
        label: cmd.command,
        hint: `${cmd.description}${cmd.shortcut ? `  [${cmd.shortcut}]` : ''}`,
      });
    }
  } else if (state.fileMenuOpen && workspaceFiles.length > 0) {
    const topFiles = workspaceFiles.slice(0, 5);
    popupHeader = `Files (${workspaceFiles.length})`;
    for (const f of topFiles) {
      popupItems.push({ label: `@${f}`, hint: '' });
    }
  }

  if (popupItems.length > 0) {
    const selIdx =
      (state.slashMenuOpen ? state.slashSelectedIndex : state.fileSelectedIndex) % popupItems.length;
    const topTitle = ` ${popupHeader} `;
    const padTop = Math.max(0, innerWidth - topTitle.length);

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
      const labelCol = `${marker}${item.label}`.padEnd(20, ' ');
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

  // 2. Composer Top Border (Rounded corners)
  lines.push({
    spans: [
      {
        text: `${glyphs.topLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.topRight}`,
        fg: borderColor,
        bg,
      },
    ],
  });

  // 3. Text input. The card stays one row tall until the draft wraps.
  const hPad = '  ';
  const textCols = Math.max(1, innerWidth - hPad.length * 2);
  const placeholder = isStreaming
    ? 'Replying…  Esc to stop'
    : 'Message Fyn…   @ files    / commands';

  if (state.value.length === 0) {
    const cursorGlyph = focused ? '▌' : ' ';
    const padAfter = Math.max(0, textCols - placeholder.length - 2);
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: borderColor, bg },
        { text: hPad, fg: tokens.foreground, bg },
        { text: cursorGlyph, fg: tokens.cursor, bg, bold: true },
        { text: ' ', fg: tokens.foreground, bg },
        { text: placeholder.slice(0, textCols - 2), fg: tokens.foregroundSubtle, bg },
        { text: ' '.repeat(padAfter), fg: tokens.foreground, bg },
        { text: hPad, fg: tokens.foreground, bg },
        { text: glyphs.vertical, fg: borderColor, bg },
      ],
    });
  } else {
    let charOffset = 0;
    const rawLines = state.value.split('\n');
    rawLines.slice(0, 6).forEach((lineText) => {
      const lineStart = charOffset;
      const lineEnd = lineStart + lineText.length;
      charOffset = lineEnd + 1;
      const hasCursor = focused && state.cursor >= lineStart && state.cursor <= lineEnd;

      if (hasCursor) {
        const cursorCol = state.cursor - lineStart;
        const before = lineText.slice(0, cursorCol);
        const cursorChar = lineText[cursorCol] ?? ' ';
        const after = lineText.slice(cursorCol + 1);
        const usedLen = before.length + 1 + after.length;
        const padRight = ' '.repeat(Math.max(0, textCols - usedLen));

        lines.push({
          spans: [
            { text: glyphs.vertical, fg: borderColor, bg },
            { text: hPad, fg: tokens.foreground, bg },
            { text: before.slice(0, textCols), fg: tokens.foreground, bg },
            { text: cursorChar, fg: tokens.accentForeground, bg: tokens.cursor, bold: true },
            {
              text: (after + padRight).slice(0, Math.max(0, textCols - before.length - 1)),
              fg: tokens.foreground,
              bg,
            },
            { text: hPad, fg: tokens.foreground, bg },
            { text: glyphs.vertical, fg: borderColor, bg },
          ],
        });
      } else {
        const paddedText = fill(lineText, textCols);
        lines.push({
          spans: [
            { text: glyphs.vertical, fg: borderColor, bg },
            { text: hPad, fg: tokens.foreground, bg },
            { text: paddedText, fg: tokens.foreground, bg },
            { text: hPad, fg: tokens.foreground, bg },
            { text: glyphs.vertical, fg: borderColor, bg },
          ],
        });
      }
    });
  }

  // 4. Hairline between the draft and the pill footer
  lines.push({
    spans: [
      { text: '├', fg: borderColor, bg },
      { text: '─'.repeat(innerWidth), fg: borderColor, bg },
      { text: '┤', fg: borderColor, bg },
    ],
  });

  // 6. Footer: mode pill, model, shortcut
  const modeName = mode === 'plan' ? 'Plan' : mode === 'review' ? 'Review' : 'Chat';
  const pill = ` ${modeName} `;
  const pillFg = mode === 'chat' ? tokens.accentForeground : mode === 'plan' ? tokens.warning : tokens.info;
  const pillBg = mode === 'chat' ? tokens.accent : tokens.backgroundElevated;
  const meta = `  ${activeModelLabel}${activeAccountLabel ? ` · ${activeAccountLabel}` : ''}`;
  const rightHint = isStreaming ? ' Esc ' : ' Ctrl+P ';
  const gap = Math.max(0, innerWidth - pill.length - meta.length - rightHint.length);
  const metaRoom = Math.max(0, innerWidth - pill.length - rightHint.length);

  lines.push({
    spans: [
      { text: glyphs.vertical, fg: borderColor, bg },
      { text: pill, fg: pillFg, bg: pillBg, bold: true },
      { text: meta.slice(0, metaRoom), fg: tokens.foregroundMuted, bg },
      { text: ' '.repeat(meta.length > metaRoom ? 0 : gap), fg: tokens.foreground, bg },
      { text: rightHint, fg: tokens.foregroundSubtle, bg },
      { text: glyphs.vertical, fg: borderColor, bg },
    ],
  });

  // 8. Composer Bottom Border (Rounded corners)
  lines.push({
    spans: [
      {
        text: `${glyphs.bottomLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.bottomRight}`,
        fg: borderColor,
        bg,
      },
    ],
  });

  return lines;
}
