/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useEffect, useMemo, useState} from 'react';
import {WindowedRows} from '../screen';
import {useKeymap} from '../hooks';
import {useUiTheme} from './ui-theme';
import {useTheme} from '../theme';
import {useHighlightedCode} from './code-block';
import {KeyHint} from './key-hint';
import {graphemes, safeText, stringCells} from './text-line';
export interface DiffLine {
  kind: 'meta' | 'hunk' | 'added' | 'removed' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
}
/** Hunk counters distinguish source resembling ---/+++ from file headers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  let oldLine = 0,
    newLine = 0,
    oldRemaining = 0,
    newRemaining = 0;
  return safeText(diff)
    .slice(0, 262144)
    .split('\n')
    .map(text => {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[3]);
        oldRemaining = Number(hunk[2] ?? 1);
        newRemaining = Number(hunk[4] ?? 1);
        return {kind: 'hunk', text};
      }
      if (oldRemaining || newRemaining) {
        if (text.startsWith('-') && oldRemaining > 0) {
          oldRemaining--;
          return {kind: 'removed', text, oldLine: oldLine++};
        }
        if (text.startsWith('+') && newRemaining > 0) {
          newRemaining--;
          return {kind: 'added', text, newLine: newLine++};
        }
        if (text.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
          oldRemaining--;
          newRemaining--;
          return {kind: 'context', text, oldLine: oldLine++, newLine: newLine++};
        }
      }
      return {kind: 'meta', text};
    });
}
export interface DiffProps {
  diff: string;
  maxLines?: number;
  expanded?: boolean;
  onToggle?: () => void;
  isActive?: boolean;
  width?: number;
}
export function Diff({diff, maxLines = 20, expanded, onToggle, isActive = false, width}: DiffProps) {
  const [local, setLocal] = useState(false);
  const open = expanded ?? local;
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const limit = Math.max(1, Math.floor(maxLines));
  useKeymap(
    {
      expand: () => {
        if (expanded === undefined) setLocal(value => !value);
        onToggle?.();
      },
    },
    {isActive},
  );
  return (
    <Box width={width} flexDirection="column" minWidth={0}>
      <DiffView lines={rows} width={width ?? 80} maxLines={open ? undefined : limit} showHunks foldHint={false} />
      {rows.length > limit ? (
        <KeyHint keys="Ctrl+O" label={open ? 'collapse diff' : `expand diff · +${rows.length - limit} lines`} />
      ) : null}
      {diff.length > 262144 ? <Text>… diff truncated at 262144 characters</Text> : null}
    </Box>
  );
}

export interface DiffStats {
  added: number;
  removed: number;
}
export function diffStats(diff: string): DiffStats {
  const rows = parseUnifiedDiff(diff);
  return {
    added: rows.filter(row => row.kind === 'added').length,
    removed: rows.filter(row => row.kind === 'removed').length,
  };
}
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** `Added 1 line, removed 1 line` / `Added 2 lines` / `Removed 1 line` (the reference tool summary). */
export function diffSummary({added, removed}: DiffStats): string {
  const parts = [
    ...(added ? [`Added ${plural(added, 'line')}`] : []),
    ...(removed ? [`${added ? 'removed' : 'Removed'} ${plural(removed, 'line')}`] : []),
  ];
  return parts.length ? parts.join(', ') : 'No changes';
}
type DiffViewInput = {diff: string; lines?: never} | {diff?: never; lines: readonly DiffLine[]};
export type DiffViewProps = DiffViewInput & {
  /** Full row width including the gutter. */
  width: number;
  /**
   * `update`: ` 1 -hello` / ` 1 +HELLO` / ` 2  world` with add/remove backgrounds.
   * `new`: numbered lines of a created file, no sign column and no background.
   */
  variant?: 'update' | 'new';
  /** Logical rows shown before `… +N lines`; every row when omitted. */
  maxLines?: number;
  offset?: number;
  viewportRows?: number;
  onRowCount?: (count: number) => void;
  language?: string;
  showHunks?: boolean;
  foldHint?: boolean;
  tailLines?: number;
  windowRows?: boolean;
};
interface ViewRow {
  kind: 'added' | 'removed' | 'context' | 'gap' | 'hunk';
  number?: number;
  text: string;
}
/**
 * Claude Code style diff body (spec 3/8). Rows are `[pad][number][space][sign]content`, wrapped by cell width with a blank
 * gutter on continuation rows. The caller positions it (the transcript puts it under `  ⎿  `, the diff panel in its pane).
 */
export function DiffView({
  diff,
  lines,
  width,
  variant = 'update',
  maxLines,
  offset = 0,
  viewportRows,
  onRowCount,
  language = '',
  showHunks = false,
  foldHint = true,
  tailLines = 0,
  windowRows = false,
}: DiffViewProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const all = useMemo(() => {
    const rows: ViewRow[] = [];
    let hunks = 0;
    for (const row of lines ?? parseUnifiedDiff(diff ?? '')) {
      if (row.kind === 'hunk') {
        if (showHunks) rows.push({kind: 'hunk', text: safeText(row.text).replace(/\n/g, ' ')});
        else if (hunks++ > 0 && variant === 'update') rows.push({kind: 'gap', text: '…'});
      } else if (row.kind !== 'meta')
        rows.push({
          kind: row.kind,
          number: row.kind === 'removed' ? row.oldLine : row.newLine,
          text: safeText(row.text.slice(1)).replace(/\n/g, ' '),
        });
      else if (showHunks) rows.push({kind: 'gap', text: safeText(row.text).replace(/\n/g, ' ')});
    }
    return rows;
  }, [diff, lines, variant, showHunks]);
  const limit = maxLines === undefined ? all.length : Math.max(1, Math.floor(maxLines));
  const digits = useMemo(() => all.reduce((n, row) => Math.max(n, String(row.number ?? '').length), 1), [all]);
  const gutter = 1 + digits + 1 + (variant === 'update' ? 1 : 0);
  const total = Math.max(gutter + 2, Math.floor(width));
  const body = Math.max(1, total - gutter);
  // Only plain layout is cached for the file. Highlighting and colour work are viewport bounded.
  const physical = useMemo(() => {
    const tail = Math.min(tailLines, limit - 1);
    const folded = all.length > limit && tail > 0;
    const rows = folded
      ? [
          ...all.slice(0, limit - tail),
          {kind: 'gap', text: `… +${all.length - limit} lines`} as const,
          ...all.slice(-tail),
        ]
      : all.slice(0, limit);
    return rows.flatMap((row, at) =>
      wrapSource(row.text, row.kind === 'gap' || row.kind === 'hunk' ? total : body).map((text, index) => ({
        row,
        at,
        index,
        text,
      })),
    );
  }, [all, limit, tailLines, body, total]);
  useEffect(() => onRowCount?.(physical.length), [physical.length, onRowCount]);
  const start = Math.max(0, Math.min(offset, Math.max(0, physical.length - (viewportRows ?? physical.length))));
  const tints = useMemo(
    () => ({
      added: ui.diffTint('diffAdded'),
      removed: ui.diffTint('diffRemoved'),
    }),
    [ui.colors, ui.mode, ui.tokens],
  );
  const hunkColor = showHunks ? ui.diffHunk() : undefined;
  const renderRows = (first: number, end: number) =>
    physical.slice(first, end).map(({row, at, index, text}) => {
      if (row.kind === 'gap' || row.kind === 'hunk')
        return (
          <Text
            key={`${at}:${index}`}
            color={row.kind === 'hunk' ? hunkColor : ui.color('dim')}
            dimColor={row.kind === 'hunk'}
            wrap="truncate-end"
          >
            {text}
          </Text>
        );
      const marked = variant === 'update' && row.kind !== 'context';
      const bg = marked ? tints[row.kind === 'added' ? 'added' : 'removed'] : undefined;
      const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' ';
      const head = ` ${index === 0 ? String(row.number ?? '').padStart(digits) : ' '.repeat(digits)} `;
      return (
        <Text key={`${at}:${index}`} wrap="truncate-end" backgroundColor={bg}>
          <Text color={color('foregroundSubtle')}>{head}</Text>
          {variant === 'update' ? (
            <Text color={marked ? color(row.kind === 'added' ? 'diffAdded' : 'diffRemoved') : color('diffContext')}>
              {index === 0 ? sign : ' '}
            </Text>
          ) : null}
          <DiffSource text={text} language={language} kind={row.kind} />
          {bg ? ' '.repeat(Math.max(0, body - stringCells(text))) : ''}
        </Text>
      );
    });
  return (
    <Box flexDirection="column" width={total} minWidth={0}>
      {windowRows ? (
        <WindowedRows count={physical.length}>{renderRows}</WindowedRows>
      ) : (
        renderRows(start, viewportRows === undefined ? physical.length : start + viewportRows)
      )}
      {foldHint && !tailLines && all.length > limit ? (
        <Text color={ui.color('dim')}>{`… +${all.length - limit} lines`}</Text>
      ) : null}
    </Box>
  );
}

function DiffSource({text, language, kind}: {text: string; language: string; kind: ViewRow['kind']}) {
  const theme = useTheme();
  const highlighted = useHighlightedCode(text, language);
  return <Text color={theme.color(kind === 'context' ? 'diffContext' : 'foreground')}>{highlighted}</Text>;
}

/** Prefer word boundaries, preserving indentation and splitting long words at grapheme boundaries. */
function wrapSource(text: string, width: number): string[] {
  if (stringCells(text) <= width) return [text];
  const lines: string[] = [];
  let line = '';
  let cells = 0;
  const flush = () => {
    lines.push(line);
    line = '';
    cells = 0;
  };
  for (const chunk of text.match(/ +|[^ ]+/gu) ?? []) {
    const size = stringCells(chunk);
    if (chunk[0] !== ' ' && size <= width && cells + size > width) flush();
    if (cells + size <= width) {
      line += chunk;
      cells += size;
      continue;
    }
    for (const {segment} of graphemes.segment(chunk)) {
      const size = stringCells(segment);
      if (cells + size > width && line) flush();
      line += segment;
      cells += size;
    }
  }
  lines.push(line);
  return lines;
}
