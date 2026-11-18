/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useMemo, useState} from 'react';
import {useKeymap} from '../hooks';
import {useTheme} from '../theme';
import {KeyHint} from './key-hint';
import {safeText} from './text-line';
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
