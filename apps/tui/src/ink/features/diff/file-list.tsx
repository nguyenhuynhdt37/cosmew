/** @jsxImportSource react */
import {useMemo, useState} from 'react';
import {Box, Text} from 'ink';
import type {WorkspaceDiffFile} from '@cosmew/sdk';
import {useBindingLabel} from '../../hooks/keymap';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {MouseRow} from '../../ui/mouse-row';
import {graphemes, safeText, stringCells} from '../../ui/text-line';
import {useTheme} from '../../theme';
import {useUiTheme} from '../../ui/ui-theme';

const statusStyles = {
  added: {marker: 'A', token: 'diffAdded'},
  deleted: {marker: 'D', token: 'diffRemoved'},
  modified: {marker: 'M', token: 'warning'},
  renamed: {marker: 'R', token: 'info'},
  untracked: {marker: '?', token: 'info'},
} as const;

/** Clip by terminal cells, preserving the filename before sacrificing its directory. */
function clipPath(path: string, width: number) {
  const text = safeText(path).replace(/\n/g, ' ');
  if (stringCells(text) <= width) return text;
  let tail = '';
  let remaining = width - 1;
  for (const {segment} of Array.from(graphemes.segment(text)).reverse()) {
    remaining -= stringCells(segment);
    if (remaining < 0) break;
    tail = segment + tail;
  }
  return width > 0 ? `…${tail}` : '';
}
export function DiffFileRow({
  file,
  width,
  selected = false,
}: {
  file: WorkspaceDiffFile;
  width: number;
  selected?: boolean;
}) {
  const {color, colors, engine} = useTheme();
  const {diffSelection} = useUiTheme();
  const {marker, token} = statusStyles[file.status];
  const counts = `+${file.additions} -${file.deletions}`;
  const path = clipPath(file.path, Math.max(1, width - 5 - stringCells(counts)));
  const slash = path.lastIndexOf('/') + 1;
  const padding = ' '.repeat(Math.max(1, width - 4 - stringCells(path) - stringCells(counts)));
  const inverseRow = selected && (!colors || engine.colorCapability === '16');
  return (
    <Text
      wrap="truncate-end"
      backgroundColor={selected && !inverseRow ? diffSelection() : undefined}
      inverse={inverseRow}
    >
      <Text color={selected ? color('info') : undefined} bold={selected} inverse={selected && !inverseRow}>
        {selected ? '❯ ' : '  '}
      </Text>
      <Text color={color(token)} dimColor={token === 'info'}>
        {marker}{' '}
      </Text>
      <Text color={color('foregroundSubtle')}>{path.slice(0, slash)}</Text>
      <Text color={color('foreground')} bold={selected}>
        {path.slice(slash)}
      </Text>
      {padding}
      <Text color={color('diffAdded')}>+{file.additions}</Text>{' '}
      <Text color={color('diffRemoved')}>-{file.deletions}</Text>
    </Text>
  );
}
/** Selection has a two-row margin; only the visible file rows are mounted. */
export function DiffFileList({
  files,
  selected,
  rows = 8,
  width,
  isActive,
  onSelect,
  onMove,
  group,
}: {
  group?: {count: number; hidden: boolean; onToggle: () => void};
  files: WorkspaceDiffFile[];
  selected: number;
  rows?: number;
  width: number;
  isActive: boolean;
  onSelect: (index: number) => void;
  onMove: (step: number) => void;
}) {
  const {color} = useTheme();
  const up = useBindingLabel('DiffDialog', 'diff:previousFile');
  const down = useBindingLabel('DiffDialog', 'diff:nextFile');
  const pageUp = useBindingLabel('DiffDialog', 'diff:pageUp');
  const pageDown = useBindingLabel('DiffDialog', 'diff:pageDown');
  const [previousStart, setStart] = useState(0);
  const margin = Math.min(2, Math.floor((rows - 1) / 2));
  const start = Math.max(
    0,
    Math.min(files.length - rows, selected - margin, Math.max(previousStart, selected - rows + margin + 1)),
  );
  if (start !== previousStart) setStart(start);
  const below = Math.max(0, files.length - start - rows);
  const ref = useMouseTarget(event => {
    if ('direction' in event) onMove(event.direction * 3);
  }, isActive);
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0} width={width}>
      {files.length > rows ? (
        <Text color={color('foregroundSubtle')} wrap="truncate-end">
          {start ? `↑ ${start} more above · ` : ''}
          {up} · {pageUp}
        </Text>
      ) : null}
      {files.slice(start, start + rows).map((file, at) => (
        <MouseRow key={`${file.path}:${start + at}`} isActive={isActive} onHighlight={() => onSelect(start + at)}>
          <DiffFileRow file={file} width={width} selected={start + at === selected} />
        </MouseRow>
      ))}
      {group?.count ? (
        <DiffFileGroup count={group.count} hidden={group.hidden} onToggle={group.onToggle} isActive={isActive} />
      ) : null}
      {files.length > rows ? (
        <Text color={color('foregroundSubtle')} wrap="truncate-end">
          {below ? `↓ ${below} more below · ` : ''}
          {down} · {pageDown}
        </Text>
      ) : null}
    </Box>
  );
}

export function DiffFileGroup({
  count,
  hidden,
  onToggle,
  isActive = true,
}: {
  count: number;
  hidden: boolean;
  onToggle: () => void;
  isActive?: boolean;
}) {
  const {color} = useTheme();
  const toggle = useBindingLabel('DiffDialog', 'diff:toggleGenerated');
  return (
    <MouseRow isActive={isActive} onHighlight={onToggle}>
      <Text color={color('foregroundSubtle')} italic wrap="truncate-end">
        {hidden ? '▸' : '▾'} {count} tests/generated ({hidden ? 'show' : 'hide'}) · {toggle}
      </Text>
    </MouseRow>
  );
}
/** A display filter only; never changes the workspace report or its totals. */
export function useDiffFiles(all: WorkspaceDiffFile[]) {
  const [hidden, setHidden] = useState(false);
  const count = useMemo(() => all.filter(file => file.path.startsWith('tests/generated/')).length, [all]);
  const files = useMemo(
    () => (hidden ? all.filter(file => !file.path.startsWith('tests/generated/')) : all),
    [all, hidden],
  );
  return {files, group: {count, hidden}, toggle: () => setHidden(value => !value)};
}
