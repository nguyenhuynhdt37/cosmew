/** @jsxImportSource react */
import {useState} from 'react';
import {Box, Text} from 'ink';
import type {WorkspaceDiffFile, WorkspaceDiffReport, WorkspaceDiffBase} from '@cosmew/sdk';
import {useKeybindings} from '../../hooks';
import {DiffView, TextLine} from '../../ui';
import {safeText, stringCells, wrapText} from '../../ui/text-line';
import {parseUnifiedDiff} from '../../ui/diff';
import {useUiTheme} from '../../ui/ui-theme';

export const DIFF_PANEL_MIN_COLUMNS = 110;
export const DIFF_PANEL_WIDTH = 54;
export const DIFF_PANEL_RESIZE_MESSAGE = 'Resize your terminal to at least 110 columns to show the diff panel';
export const DIFF_BASE_UNSUPPORTED = 'Comparison bases unavailable: this host does not expose diff base capabilities.';
export const DIFF_BASE_LABELS = {session: 'Current', uncommitted: 'Uncommitted', branch: 'Branch'} as const;
/** Includes the vertical separator and one trailing cell: the reference body is 52 cells at 120 columns. */
export function diffPanelLayout(columns: number, open: boolean) {
  const visible = open && columns >= DIFF_PANEL_MIN_COLUMNS;
  return {
    visible,
    mainWidth: Math.max(1, columns - (visible ? DIFF_PANEL_WIDTH : 0)),
    panelWidth: visible ? DIFF_PANEL_WIDTH : 0,
  };
}

/** Reconstruct hunk ranges from the SDK's numbered rows, including snapshots with no hunk header. */
export function workspaceViewDiff(file: WorkspaceDiffFile): string {
  const chunks: WorkspaceDiffFile['lines'][] = [];
  let chunk: WorkspaceDiffFile['lines'] = [];
  let oldNext: number | undefined;
  let newNext: number | undefined;
  const flush = () => {
    if (chunk.length) chunks.push(chunk);
    chunk = [];
    oldNext = newNext = undefined;
  };
  for (const line of file.lines) {
    if (line.type === 'hunk') {
      flush();
      continue;
    }
    if (
      (line.oldLine !== null && oldNext !== undefined && line.oldLine !== oldNext) ||
      (line.newLine !== null && newNext !== undefined && line.newLine !== newNext)
    )
      flush();
    chunk.push(line);
    if (line.oldLine !== null) oldNext = line.oldLine + 1;
    if (line.newLine !== null) newNext = line.newLine + 1;
  }
  flush();
  return chunks
    .map(lines => {
      const oldStart = lines.find(line => line.oldLine !== null)?.oldLine ?? 0;
      const newStart = lines.find(line => line.newLine !== null)?.newLine ?? 0;
      return [
        `@@ -${oldStart},${lines.filter(line => line.type !== 'add').length} +${newStart},${lines.filter(line => line.type !== 'del').length} @@`,
        ...lines.map(line => `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.content}`),
      ].join('\n');
    })
    .join('\n');
}

export interface DiffSidePanelProps {
  report: WorkspaceDiffReport;
  width?: number;
  height?: number;
  isActive?: boolean;
  /** Dialog keys only when deliberately focused; modified panel keys work beside the composer. */
  focused?: boolean;
  onClose?: () => void;
  onNotice?: (message: string) => void;
  onChangeBase?: (base: WorkspaceDiffBase) => void;
}
/** Read-only current workspace pane. It never presents staged/unstaged layers as comparison bases. */
export function DiffSidePanel({
  report,
  width = DIFF_PANEL_WIDTH,
  height = 30,
  isActive = true,
  focused = false,
  onClose,
  onNotice,
  onChangeBase,
}: DiffSidePanelProps) {
  const ui = useUiTheme();
  const inner = Math.max(1, width - 2);
  const rows = Math.max(1, height);
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [baseNotice, setBaseNotice] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const selected = Math.min(index, Math.max(0, report.files.length - 1));
  const file = report.files[selected];
  const listRows = expanded ? 0 : Math.min(4, report.files.length, Math.max(1, rows - 12));
  const listStart = Math.max(0, selected - listRows + 1);
  const unified = file ? workspaceViewDiff(file) : '';
  const metadata = file?.lines.filter(line => line.type === 'hunk' && !line.content.startsWith('@@ ')) ?? [];
  const diffRows = parseUnifiedDiff(unified).filter(row => row.kind !== 'meta' && row.kind !== 'hunk');
  const digits = Math.max(1, ...diffRows.map(row => String(row.oldLine ?? row.newLine ?? '').length));
  const bodyRows = Math.max(1, rows - listRows - 8 - (baseNotice ? 1 : 0));
  const physicalRows =
    metadata.length +
    diffRows.reduce((sum, row) => sum + wrapText(row.text.slice(1), Math.max(1, inner - digits - 3)).length, 0) +
    Math.max(0, unified.split('\n').filter(row => row.startsWith('@@ ')).length - 1);
  const maxOffset = Math.max(0, physicalRows - bodyRows);
  const move = (step: number) => {
    setIndex(Math.max(0, Math.min(report.files.length - 1, selected + step)));
    setOffset(0);
  };
  const changeBase = () => {
    if (!report.capabilities || !onChangeBase) {
      setBaseNotice('Session/branch bases unavailable in SDK · Current');
      onNotice?.(DIFF_BASE_UNSUPPORTED);
      return;
    }
    const bases: WorkspaceDiffBase[] = ['session', 'uncommitted', 'branch'];
    const start = bases.indexOf(report.base ?? 'session');
    const skipped: string[] = [];
    for (let step = 1; step <= bases.length; step++) {
      const next = bases[(start + step) % bases.length]!;
      const capability = report.capabilities[next];
      if (capability.available) {
        setIndex(0);
        setOffset(0);
        const message = skipped.length ? skipped.join('; ') : undefined;
        setBaseNotice(message);
        if (message) onNotice?.(message);
        onChangeBase(next);
        return;
      }
      skipped.push(`${DIFF_BASE_LABELS[next]} unavailable: ${capability.reason ?? 'Unsupported'}`);
    }
    const message = skipped.join('; ');
    setBaseNotice(message);
    onNotice?.(message);
  };
  useKeybindings(
    {
      DiffPanel: {
        'app:cycleDiffBase': changeBase,
        'diff:changeBase': changeBase,
        'diff:scrollUp': () => move(-1),
        'diff:scrollDown': () => move(1),
      },
    },
    {isActive},
  );
  useKeybindings(
    {
      DiffDialog: {
        'diff:previousFile': () => move(-1),
        'diff:nextFile': () => move(1),
        'diff:previousSource': changeBase,
        'diff:nextSource': changeBase,
        'diff:open': () => {
          setExpanded(value => !value);
          setOffset(0);
        },
        'diff:back': () => {
          if (expanded) {
            setExpanded(false);
            setOffset(0);
          } else onClose?.();
        },
        'diff:pageUp': () => setOffset(value => Math.max(0, value - bodyRows)),
        'diff:pageDown': () => setOffset(value => Math.min(maxOffset, value + bodyRows)),
        'diff:top': () => setOffset(0),
        'diff:bottom': () => setOffset(maxOffset),
      },
    },
    {isActive: isActive && focused},
  );
  const pair = (left: string, right: string) => {
    const clean = safeText(left).replace(/\n/g, ' ');
    const available = Math.max(0, inner - stringCells(right) - 1);
    let clipped = '';
    for (const ch of clean) {
      if (stringCells(clipped + ch) > available) break;
      clipped += ch;
    }
    return clipped + ' '.repeat(Math.max(1, inner - stringCells(clipped) - stringCells(right))) + right;
  };
  return (
    <Box width={width} height={rows} flexShrink={0} backgroundColor={ui.color('panel')} overflow="hidden">
      <Box width={1} flexDirection="column" flexShrink={0}>
        <Text>{Array(rows).fill('│').join('\n')}</Text>
      </Box>
      <Box width={inner} flexDirection="column" flexShrink={0}>
        <Text color={ui.color('dim')}>{pair('', '✕')}</Text>
        <TextLine width={inner} wrap="truncate-end">
          {pair(
            `${report.files.length} ${report.files.length === 1 ? 'file' : 'files'} changed +${report.totalAdditions} -${report.totalDeletions}`,
            `source: ${DIFF_BASE_LABELS[report.base ?? 'session']} ▾`,
          )}
        </TextLine>
        <Text> </Text>
        {report.files.slice(listStart, listStart + listRows).map((item, at) => (
          <TextLine
            key={`${item.path}:${at}`}
            width={inner}
            color={listStart + at === selected ? ui.color('selected') : ui.color('dim')}
            wrap="truncate-end"
          >
            {pair(item.path, `+${item.additions} -${item.deletions}`)}
          </TextLine>
        ))}
        <Text> </Text>
        <Text color={ui.color('dim')}>{'─'.repeat(inner)}</Text>
        <TextLine width={inner} wrap="truncate-end">
          {pair(file?.path ?? 'Workspace diff', '[ ask ]')}
        </TextLine>
        <Text color={ui.color('dim')}>{'─'.repeat(inner)}</Text>
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          contentOffsetY={Math.min(offset, maxOffset)}
        >
          <Box flexDirection="column" flexShrink={0}>
            {metadata.map((line, index) => (
              <TextLine key={index} width={inner}>
                {line.content}
              </TextLine>
            ))}
            {file ? (
              file.binary ? (
                <TextLine width={inner}>Binary diff unavailable</TextLine>
              ) : file.lines.length ? (
                <DiffView diff={unified} width={inner} />
              ) : (
                <TextLine width={inner}>Empty diff</TextLine>
              )
            ) : (
              <TextLine width={inner}>
                {report.message ?? (report.gitAvailable ? 'No changes' : 'Workspace diff unavailable')}
              </TextLine>
            )}
            {file?.truncated || report.truncated ? (
              <TextLine width={inner}>Diff truncated by workspace snapshot</TextLine>
            ) : null}
          </Box>
        </Box>
        {baseNotice ? (
          <TextLine width={inner} color={ui.color('dim')}>
            {baseNotice}
          </TextLine>
        ) : null}
        <TextLine width={inner} color={ui.color('dim')} wrap="truncate-end">
          {focused
            ? `↑/↓ files · Enter ${expanded ? 'list' : 'open'} · Esc ${expanded ? 'back' : 'close'}`
            : 'opt+↑/↓ files · ctrl+x b source'}
        </TextLine>
      </Box>
    </Box>
  );
}
