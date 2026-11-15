import { SLASH_COMMANDS, type SlashCommandDef } from '@hannes/sdk';
import { createInitialComposerState, type ComposerState } from './types';

export { SLASH_COMMANDS, type SlashCommandDef };

export function getMatchingSlashCommands(input: string): SlashCommandDef[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return [];
  const q = trimmed.toLowerCase();
  const ranked = (item: SlashCommandDef) => item.command.toLowerCase() === q ? 0 : item.command.toLowerCase().startsWith(q) ? 1 : item.aliases.some(name => name.toLowerCase() === q) ? 2 : item.aliases.some(name => name.toLowerCase().startsWith(q)) ? 3 : 4;
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
