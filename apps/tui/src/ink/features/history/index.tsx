/** @jsxImportSource react */
import {useState} from 'react';
import {Box, Text} from 'ink';
import {Rule, TextLine, safeText} from '../../ui';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useUiTheme} from '../../ui/ui-theme';

export function recordHistory(history: readonly string[], content: string): string[] {
  const clean = content.trim();
  return clean ? [...history.filter(item => item !== clean), clean].slice(-100) : [...history];
}
export function searchHistory(history: readonly string[], query: string, before = history.length): number {
  for (let i = Math.min(before, history.length) - 1; i >= 0; i--) {
    if (history[i]!.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return i;
  }
  return -1;
}
export function useHistory(initial: readonly string[] = []) {
  const [entries, setEntries] = useState(() =>
    initial.reduce<string[]>((items, text) => recordHistory(items, text), []),
  );
  return {entries, setEntries, record: (content: string) => setEntries(items => recordHistory(items, content))};
}
/** Indices of entries that match `query`, newest first (Ctrl+R lists newest at the top). */
export function filterHistory(history: readonly string[], query: string): number[] {
  const needle = query.toLocaleLowerCase();
  const found: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.toLocaleLowerCase().includes(needle)) found.push(i);
  return found;
}
export interface HistoryProps {
  query: string;
  scope?: 'session' | 'project' | 'everywhere';
  timestamps?: readonly string[];
  /** Matching prompts, newest first (see `filterHistory`). */
  matches: readonly string[];
  selected?: number;
  width?: number;
  /** One-line notice that replaces the key help (for example "Not implemented"). */
  notice?: string;
  rows?: number;
}
const oneLine = (text: string) => safeText(text).replace(/\s*\n\s*/g, ' ');
/**
 * Ctrl+R panel (spec 2): `▔` rule, title, the list on the left with a rounded preview box on the right,
 * a rounded filter box, relative timestamps and the current history scope.
 */
export function History({
  query,
  matches,
  timestamps,
  scope = 'everywhere',
  selected = 0,
  width,
  notice,
  rows = 5,
}: HistoryProps) {
  const {columns} = useTerminalSize();
  const ui = useUiTheme();
  const total = Math.max(8, Math.floor(width ?? columns ?? 80));
  const room = total - 2;
  const listWidth = Math.max(6, Math.floor(room * 0.5));
  const previewWidth = Math.max(6, room - listWidth - 1);
  const index = Math.max(0, Math.min(selected, matches.length - 1));
  const visible = Math.max(1, rows);
  const start = Math.max(0, Math.min(index - visible + 1, Math.max(0, matches.length - visible)));
  const shown = matches.slice(start, start + visible);
  const preview = safeText(matches[index] ?? '')
    .split('\n')
    .slice(0, visible)
    .map(line => line.slice(0, Math.max(1, previewWidth - 4)));
  return (
    <Box flexDirection="column" width={total} minWidth={0}>
      <Rule width={total} glyph="▔" />
      <Box paddingLeft={1}>
        <Text bold>{`Search prompts · ${scope}`}</Text>
      </Box>
      <Box paddingLeft={1} minWidth={0}>
        <Box flexDirection="column" width={listWidth} minWidth={0}>
          {matches.length ? (
            shown.map((entry, offset) => {
              const active = start + offset === index;
              return (
                <TextLine
                  key={`${start + offset}:${entry}`}
                  width={listWidth - 1}
                  color={active ? ui.color('selected') : ui.color('dim')}
                  wrap="truncate-end"
                >{`${active ? '❯ ' : '  '}${timestamps ? historyAge(timestamps[start + offset] ?? '').padEnd(8) + ' ' : ''}${oneLine(entry)}`}</TextLine>
              );
            })
          ) : (
            <TextLine width={listWidth - 1} color={ui.color('dim')}>
              No match
            </TextLine>
          )}
        </Box>
        <Box
          flexDirection="column"
          width={previewWidth}
          minWidth={0}
          borderStyle="round"
          borderColor={ui.color('dim')}
          paddingX={1}
          height={visible + 2}
        >
          {preview.map((line, n) => (
            <TextLine key={n} width={Math.max(1, previewWidth - 4)} wrap="truncate-end">
              {line}
            </TextLine>
          ))}
        </Box>
      </Box>
      <Box paddingLeft={1} width={total} minWidth={0}>
        <Box borderStyle="round" borderColor={ui.color('dim')} width={total - 2} paddingX={1}>
          <Text color={ui.color('dim')}>⌕ </Text>
          {query ? <Text>{safeText(query)}</Text> : <Text color={ui.color('dim')}>Filter history…</Text>}
        </Box>
      </Box>
      <Box paddingLeft={2} minWidth={0}>
        <TextLine width={Math.max(1, total - 2)} color={ui.color('dim')} wrap="truncate-end">
          {notice ?? '↑/↓ to navigate · ctrl+s to change scope · Enter to use · Esc to cancel'}
        </TextLine>
      </Box>
    </Box>
  );
}

/** Unknown legacy timestamps are displayed honestly. */
export function historyAge(timestamp: string, now = Date.now()): string {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return '—';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
