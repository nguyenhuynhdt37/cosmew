/** @jsxImportSource react */
import {useRef, useState} from 'react';
import {Box, Text} from 'ink';
import type {ToolResult, WorkspaceDiffReport, WorkspaceDiffBase} from '@cosmew/sdk';
import {useEvents, useFutrynClient, useKeybindings, useKeymap, useTextInput} from '../../hooks';
import {useUiTheme} from '../../ui/ui-theme';
import {useTheme} from '../../theme';
import {DiffView, TextLine, Truncate} from '../../ui';
import {changeReceipt, workspaceUnifiedDiff} from './logic';
export * from './logic';
export * from './panel';
export interface ToolDiffProps {
  result?: ToolResult;
  expanded?: boolean;
  width?: number;
  /** Rows of a changed file before `… +N lines` (a created file previews 10, like the reference). */
  maxLines?: number;
}
/** Rows of a created file shown in the transcript before `… +N lines` (reference: `Wrote 60 lines` + 10 rows). */
export const NEW_FILE_PREVIEW_ROWS = 10;
export const UPDATE_PREVIEW_ROWS = 40;
/** The body under `⎿  Added 1 line, removed 1 line`: numbered rows with add/remove backgrounds. */
export function ToolDiff({result, expanded = false, width, maxLines}: ToolDiffProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const receipt = changeReceipt(result);
  const rowWidth = Math.max(8, width ?? 80);
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
          {receipt.changes.length > 1 ? (
            <TextLine width={width} color={ui.color('path')}>{`${change.path} · ${change.action}`}</TextLine>
          ) : null}
          {change.action === 'delete' ? null : (
            <DiffView
              diff={change.diff}
              width={rowWidth}
              variant={change.action === 'add' ? 'new' : 'update'}
              maxLines={
                expanded
                  ? undefined
                  : (maxLines ?? (change.action === 'add' ? NEW_FILE_PREVIEW_ROWS : UPDATE_PREVIEW_ROWS))
              }
            />
          )}
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
  const base = useRef<WorkspaceDiffBase>('session');
  const generation = useRef(0);
  const session = useRef(client.activeSession()?.id);
  const read = (): WorkspaceDiffReport => {
    try {
      return client.getWorkspaceDiff({base: base.current});
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
  useEvents({
    reactive: () => {
      const current = client.activeSession()?.id;
      if (session.current !== current) {
        session.current = current;
        base.current = 'session';
        generation.current++;
      }
      setReport(read());
    },
  });
  const refresh = async (nextBase: WorkspaceDiffBase = base.current) => {
    base.current = nextBase;
    const request = ++generation.current;
    const sessionId = client.activeSession()?.id;
    try {
      const next = await client.refreshWorkspaceDiff({base: nextBase});
      if (request !== generation.current || client.activeSession()?.id !== sessionId) return;
      setReport(next);
      setError(undefined);
    } catch {
      if (request === generation.current) setError('Workspace diff refresh failed');
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
  const ui = useUiTheme();
  const [layer, setLayer] = useState<'all' | 'staged' | 'unstaged' | 'untracked'>('all');
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const files = report.files.filter(file => layer === 'all' || file.layer === layer);
  const selected = Math.min(index, Math.max(0, files.length - 1));
  const file = files[selected];
  const lines = file?.lines ?? [];
  const start = Math.min(offset, Math.max(0, lines.length - maxLines));
  const LAYERS = ['all', 'staged', 'unstaged', 'untracked'] as const;
  const maxStart = Math.max(0, lines.length - maxLines);
  const goFile = (step: number) => {
    setIndex((selected + step + files.length) % Math.max(1, files.length));
    setOffset(0);
  };
  const goSource = (step: number) => {
    setLayer(LAYERS[(LAYERS.indexOf(layer) + step + LAYERS.length) % LAYERS.length]!);
    setIndex(0);
    setOffset(0);
  };
  useKeymap({expand: () => setExpanded(value => !value)}, {isActive});
  // DiffDialog keys: ↑/↓ and J/K pick a file, ←/→ the source, Enter shows the whole file, PgUp/PgDn/Space/B page, G/g ends.
  useKeybindings(
    {
      DiffDialog: {
        'diff:previousFile': () => goFile(-1),
        'diff:nextFile': () => goFile(1),
        'diff:previousSource': () => goSource(-1),
        'diff:nextSource': () => goSource(1),
        'diff:open': () => setExpanded(value => !value),
        'diff:back': () => (expanded ? setExpanded(false) : false),
        'diff:pageUp': () => setOffset(Math.max(0, start - maxLines)),
        'diff:pageDown': () => setOffset(Math.min(maxStart, start + maxLines)),
        'diff:top': () => setOffset(0),
        'diff:bottom': () => setOffset(maxStart),
      },
    },
    {isActive},
  );
  useTextInput(
    (input, key) => {
      if (key.ctrl || key.meta || key.shift || key.eventType === 'release') return;
      const target = ({a: 'all', s: 'staged', u: 'unstaged', n: 'untracked'} as const)[input.toLowerCase() as 'a'];
      if (target) {
        setLayer(target);
        setIndex(0);
        setOffset(0);
      }
      if (input.toLowerCase() === 'r') onRefresh?.();
      if (input.toLowerCase() === 'c' && file) onCopy?.(`${file.path}\n${workspaceUnifiedDiff(file)}`);
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
              backgroundColor={
                line.type === 'add' ? ui.color('diffAdded') : line.type === 'del' ? ui.color('diffRemoved') : undefined
              }
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
