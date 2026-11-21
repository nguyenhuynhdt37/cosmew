/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useMemo, useState} from 'react';
import {useKeymap} from '../hooks';
import {useUiTheme} from './ui-theme';
import {useTheme} from '../theme';
import {KeyHint} from './key-hint';
import {safeText, stringCells, wrapRuns} from './text-line';
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
  const {color} = useTheme();
  const ui = useUiTheme();
  const [local, setLocal] = useState(false);
  const open = expanded ?? local;
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const limit = Math.max(1, Math.floor(maxLines));
  const digits = rows.reduce(
    (size, row) => Math.max(size, String(Math.max(row.oldLine ?? 0, row.newLine ?? 0)).length),
    1,
  );
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
      {(open ? rows : rows.slice(0, limit)).map((row, at) => (
        <Box key={at} minWidth={0}>
          <Text color={color('foregroundSubtle')}>
            {String(row.oldLine ?? '').padStart(digits)} {String(row.newLine ?? '').padStart(digits)} │{' '}
          </Text>
          <Box minWidth={0} flexShrink={1}>
            <Text
              color={color(
                row.kind === 'added'
                  ? 'diffAdded'
                  : row.kind === 'removed'
                    ? 'diffRemoved'
                    : row.kind === 'hunk'
                      ? 'accent'
                      : 'diffContext',
              )}
              backgroundColor={
                row.kind === 'added'
                  ? ui.color('diffAdded')
                  : row.kind === 'removed'
                    ? ui.color('diffRemoved')
                    : undefined
              }
              wrap="wrap"
            >
              {row.text || ' '}
            </Text>
          </Box>
        </Box>
      ))}
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
export interface DiffViewProps {
  diff: string;
  /** Full row width including the gutter. */
  width: number;
  /**
   * `update`: ` 1 -hello` / ` 1 +HELLO` / ` 2  world` with add/remove backgrounds.
   * `new`: numbered lines of a created file, no sign column and no background.
   */
  variant?: 'update' | 'new';
  /** Logical rows shown before `… +N lines`; every row when omitted. */
  maxLines?: number;
}
interface ViewRow {
  kind: 'added' | 'removed' | 'context' | 'gap';
  number?: number;
  text: string;
}
/**
 * Claude Code style diff body (spec 3/8). Rows are `[pad][number][space][sign]content`, wrapped by cell width with a blank
 * gutter on continuation rows. The caller positions it (the transcript puts it under `  ⎿  `, the diff panel in its pane).
 */
export function DiffView({diff, width, variant = 'update', maxLines}: DiffViewProps) {
  const {color, mode, colors} = useTheme();
  const ui = useUiTheme();
  const all = useMemo(() => {
    const rows: ViewRow[] = [];
    let hunks = 0;
    for (const row of parseUnifiedDiff(diff)) {
      if (row.kind === 'hunk') {
        if (hunks++ > 0 && variant === 'update') rows.push({kind: 'gap', text: '…'});
      } else if (row.kind !== 'meta')
        rows.push({
          kind: row.kind,
          number: row.kind === 'removed' ? row.oldLine : row.newLine,
          text: row.text.slice(1),
        });
    }
    return rows;
  }, [diff, variant]);
  const limit = maxLines === undefined ? all.length : Math.max(1, Math.floor(maxLines));
  const shown = all.slice(0, limit);
  const digits = Math.max(1, ...shown.map(row => String(row.number ?? '').length));
  const gutter = 1 + digits + 1 + (variant === 'update' ? 1 : 0);
  const total = Math.max(gutter + 1, Math.floor(width));
  const body = Math.max(1, total - gutter);
  const light = mode === 'light';
  return (
    <Box flexDirection="column" width={total} minWidth={0}>
      {shown.flatMap((row, at) => {
        if (row.kind === 'gap')
          return [
            <Text key={at} color={ui.color('dim')}>
              {' '.repeat(gutter)}
              {row.text}
            </Text>,
          ];
        const marked = variant === 'update' && row.kind !== 'context';
        const bg = marked ? ui.color(row.kind === 'added' ? 'diffAdded' : 'diffRemoved') : undefined;
        const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' ';
        const signColor = marked ? color(row.kind === 'added' ? 'diffAdded' : 'diffRemoved') : undefined;
        // Dark rows carry coloured text (spec 9); light rows keep the foreground.
        const textColor = marked && !light && colors ? signColor : undefined;
        return wrapRuns([{text: safeText(row.text)}], body).map((line, index) => {
          const text = line.map(run => run.text).join('');
          const first = index === 0;
          const head = `${' '}${first ? String(row.number ?? '').padStart(digits) : ' '.repeat(digits)} ${variant === 'update' ? (first ? sign : ' ') : ''}`;
          return (
            <Text key={`${at}:${index}`}>
              <Text color={signColor} backgroundColor={bg}>
                {head}
              </Text>
              <Text color={textColor} backgroundColor={bg}>
                {text + (bg ? ' '.repeat(Math.max(0, body - stringCells(text))) : '')}
              </Text>
            </Text>
          );
        });
      })}
      {all.length > limit ? <Text color={ui.color('dim')}>{`… +${all.length - limit} lines`}</Text> : null}
    </Box>
  );
}
