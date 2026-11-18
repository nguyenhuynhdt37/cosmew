/** @jsxImportSource react */
import {useState} from 'react';
import {Box, Text} from 'ink';
import type {ToolResult, WorkspaceDiffReport} from '@futryn/contracts';
import {useEvents, useFutrynClient, useKeymap, useTextInput} from '../../hooks';
import {useTheme} from '../../theme';
import {Diff as UnifiedDiff, TextLine, Truncate} from '../../ui';
import {changeReceipt, workspaceUnifiedDiff} from './logic';
export * from './logic';
export interface ToolDiffProps {
  result?: ToolResult;
  expanded?: boolean;
  width?: number;
}
export function ToolDiff({result, expanded = false, width}: ToolDiffProps) {
  const {color} = useTheme();
  const receipt = changeReceipt(result);
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {receipt.partial ? <Text color={color('error')}>Partially applied</Text> : null}
      {receipt.details.map((detail, index) => (
        <TextLine key={index} width={width}>
          {detail}
        </TextLine>
      ))}
      {receipt.changes.map((change, index) => (
        <Box key={index} flexDirection="column">
          <TextLine width={width}>{`${change.path} · ${change.action} · applied diff`}</TextLine>
          <UnifiedDiff diff={change.diff} width={width} maxLines={8} expanded={expanded} />
        </Box>
      ))}
      {receipt.diagnostics.map((diagnostic, index) => (
        <TextLine key={index} color={color('error')} width={width}>
          {diagnostic}
        </TextLine>
      ))}
      {!receipt.changes.length ? (
        <Truncate
          text={result?.content ?? 'Proposed change · awaiting result'}
          maxLines={4}
          expanded={expanded}
          width={width}
        />
      ) : null}
    </Box>
  );
}
export function useDiff() {
  const client = useFutrynClient();
  const read = (): WorkspaceDiffReport => {
    try {
      return client.getWorkspaceDiff();
    } catch {
      return {
        workspace: '',
        gitAvailable: false,
        state: 'error',
        message: 'Workspace diff unavailable',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };
    }
  };
  const [report, setReport] = useState(read);
  const [error, setError] = useState<string>();
  useEvents({reactive: () => setReport(read())});
  const refresh = async () => {
    try {
      await client.refreshWorkspaceDiff();
      setError(undefined);
    } catch {
      setError('Workspace diff refresh failed');
    } finally {
      setReport(read());
    }
  };
  return {report, error, refresh};
}
export interface DiffProps {
  report: WorkspaceDiffReport;
  width?: number;
  maxLines?: number;
  isActive?: boolean;
  onRefresh?: () => void;
  onCopy?: (text: string) => void;
}
/** Workspace /diff view; host owns clipboard and overlay lifecycle. */
export function Diff({report, width, maxLines = 30, isActive = false, onRefresh, onCopy}: DiffProps) {
  const {color} = useTheme();
  const [layer, setLayer] = useState<'all' | 'staged' | 'unstaged' | 'untracked'>('all');
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const files = report.files.filter(file => layer === 'all' || file.layer === layer);
  const selected = Math.min(index, Math.max(0, files.length - 1));
  const file = files[selected];
  const lines = file?.lines ?? [];
  const start = Math.min(offset, Math.max(0, lines.length - maxLines));
  useKeymap(
    {
      previous: () => setOffset(Math.max(0, start - 1)),
      next: () => setOffset(Math.min(Math.max(0, lines.length - maxLines), start + 1)),
      expand: () => setExpanded(value => !value),
    },
    {isActive},
  );
  useTextInput(
    (input, key) => {
      if (key.ctrl || key.meta || key.shift || key.eventType === 'release') return;
      if (key.leftArrow || key.rightArrow || key.tab) {
        setIndex((selected + (key.leftArrow ? -1 : 1) + files.length) % Math.max(1, files.length));
        setOffset(0);
      }
      const target = ({a: 'all', s: 'staged', u: 'unstaged', n: 'untracked'} as const)[input.toLowerCase() as 'a'];
      if (target) {
        setLayer(target);
        setIndex(0);
        setOffset(0);
      }
      if (input.toLowerCase() === 'r') onRefresh?.();
      if (input.toLowerCase() === 'c' && file) onCopy?.(`${file.path}\n${workspaceUnifiedDiff(file)}`);
      if (key.pageDown) setOffset(Math.min(Math.max(0, lines.length - maxLines), start + maxLines));
      if (key.pageUp) setOffset(Math.max(0, start - maxLines));
    },
    {isActive},
  );
  return (
    <Box width={width} minWidth={0} flexDirection="column">
      <Text color={color('foregroundMuted')}>
        /diff · {layer} · {files.length} files +{files.reduce((n, file) => n + file.additions, 0)} -
        {files.reduce((n, file) => n + file.deletions, 0)}
        {report.truncated ? ' · bounded' : ''}
      </Text>
      {file ? (
        <>
          <TextLine
            width={width}
          >{`${selected + 1}/${files.length} ${file.path}${file.oldPath ? ` ← ${file.oldPath}` : ''} · ${file.layer ?? file.status}${file.binary ? ' · binary' : ''}${file.truncated ? ' · bounded' : ''}`}</TextLine>
          {(expanded ? lines : lines.slice(start, start + maxLines)).map((line, at) => (
            <TextLine
              key={at}
              width={width}
              color={color(
                line.type === 'add'
                  ? 'diffAdded'
                  : line.type === 'del'
                    ? 'diffRemoved'
                    : line.type === 'hunk'
                      ? 'accent'
                      : 'diffContext',
              )}
            >{`${String(line.oldLine ?? '').padStart(4)} ${String(line.newLine ?? '').padStart(4)} │ ${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.content}`}</TextLine>
          ))}
          {!lines.length ? <Text>Empty or binary diff</Text> : null}
        </>
      ) : (
        <TextLine width={width}>
          {report.message ??
            (report.gitAvailable
              ? 'No changes in this view'
              : `Workspace diff unavailable (${report.state ?? 'unknown'})`)}
        </TextLine>
      )}
      <Text dimColor>
        ←/→ File · ↑/↓ Scroll · A All · S Staged · U Unstaged · N New · R Refresh · C Copy · Ctrl+O Expand
      </Text>
    </Box>
  );
}
