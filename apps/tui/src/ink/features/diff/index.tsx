/** @jsxImportSource react */
import {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text} from 'ink';
import type {ToolResult, WorkspaceDiffReport, WorkspaceDiffBase} from '@cosmew/sdk';
import {useEvents, useFutrynClient, useKeybindings, useKeymap} from '../../hooks';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {MouseRow} from '../../ui/mouse-row';
import {useBindingLabel} from '../../hooks/keymap';
import {useUiTheme} from '../../ui/ui-theme';
import {useTheme} from '../../theme';
import {DiffView, TextLine, Truncate} from '../../ui';
import {DiffFileList, useDiffFiles} from './file-list';
import {changeReceipt, diffLanguage, workspaceUnifiedDiff, workspaceViewRows} from './logic';
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
              language={diffLanguage(change.path)}
              variant={change.action === 'add' ? 'new' : 'update'}
              windowRows={expanded}
              tailLines={maxLines === undefined ? 0 : Math.floor(maxLines / 2)}
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
export function useDiff(open = false) {
  const client = useFutrynClient();
  const base = useRef<WorkspaceDiffBase>('uncommitted');
  const toolsEnabled = useRef(client.toolsEnabled());
  const generation = useRef(0);
  const pending = useRef(false);
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
  const refresh = async (nextBase: WorkspaceDiffBase = base.current) => {
    base.current = nextBase;
    const request = ++generation.current;
    const sessionId = client.activeSession()?.id;
    pending.current = true;
    // Keep the inspected source/capabilities until its replacement is ready.
    setReport(previous => (previous.files.length ? previous : {...previous, message: 'Loading diff…'}));
    try {
      const next = await client.refreshWorkspaceDiff({base: nextBase});
      if (request !== generation.current || client.activeSession()?.id !== sessionId) return;
      setReport(next);
      setError(undefined);
    } catch (cause) {
      if (request !== generation.current || client.activeSession()?.id !== sessionId) return;
      const message = cause instanceof Error ? cause.message : 'Workspace diff refresh failed';
      setError(message);
      setReport({...read(), state: 'error', message, files: [], totalAdditions: 0, totalDeletions: 0});
    } finally {
      if (request === generation.current) pending.current = false;
    }
  };
  const reconcile = () => {
    const current = client.activeSession()?.id;
    const enabled = client.toolsEnabled();
    const consentChanged = toolsEnabled.current !== enabled;
    const changed = session.current !== current || consentChanged;
    if (session.current !== current) base.current = 'uncommitted';
    session.current = current;
    toolsEnabled.current = enabled;
    // A consent transition invalidates even a refresh that already captured a denied SDK report.
    if (changed) {
      generation.current++;
      pending.current = false;
    }
    if (!pending.current) setReport(read());
    if (changed) {
      setError(undefined);
      // A hidden pane must not compete with an in-flight /review refresh on session changes.
      // Consent changes still refresh to replace a cached denial.
      if (enabled && (open || consentChanged)) void refresh();
    }
  };
  useEvents({reactive: reconcile});
  // Reconcile after subscribing: startup may enable tools between render and passive effects.
  useEffect(() => {
    reconcile();
    return () => {
      generation.current++;
    };
  }, [client]);
  useEffect(() => {
    if (open) void refresh();
  }, [client, open]);
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
  const layered = useMemo(
    () => report.files.filter(file => layer === 'all' || file.layer === layer),
    [report.files, layer],
  );
  const {files, group, toggle} = useDiffFiles(layered);
  const toggleGroup = () => {
    toggle();
    setIndex(0);
    setOffset(0);
  };
  const selected = Math.min(index, Math.max(0, files.length - 1));
  const file = files[selected];
  const diffRows = useMemo(() => (file ? workspaceViewRows(file) : []), [file]);
  const [physicalRows, setPhysicalRows] = useState(0);
  const start = Math.min(offset, Math.max(0, physicalRows - maxLines));
  const LAYERS = ['all', 'staged', 'unstaged', 'untracked'] as const;
  const maxStart = Math.max(0, physicalRows - maxLines);
  const goFile = (step: number) => {
    setIndex(value => Math.max(0, Math.min(files.length - 1, Math.min(value, files.length - 1) + step)));
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
        'diff:toggleGenerated': toggleGroup,
        ...Object.fromEntries(
          (['all', 'staged', 'unstaged', 'untracked'] as const).map(target => [
            `diff:${target}`,
            () => {
              setLayer(target);
              setIndex(0);
              setOffset(0);
            },
          ]),
        ),
        'diff:refresh': () => onRefresh?.(),
        'diff:copy': () => {
          if (file) onCopy?.(`${file.path}\n${workspaceUnifiedDiff(file)}`);
        },
        'diff:previousFile': () => (expanded ? setOffset(Math.max(0, start - 1)) : goFile(-1)),
        'diff:nextFile': () => (expanded ? setOffset(Math.min(maxStart, start + 1)) : goFile(1)),
        'diff:previousSource': () => goSource(-1),
        'diff:nextSource': () => goSource(1),
        'diff:open': () => setExpanded(value => !value),
        'diff:back': () => (expanded ? setExpanded(false) : false),
        'diff:pageUp': () =>
          expanded ? setOffset(Math.max(0, start - Math.max(1, Math.floor(maxLines / 2)))) : goFile(-8),
        'diff:fullPageUp': () => (expanded ? setOffset(Math.max(0, start - maxLines)) : goFile(-8)),
        'diff:pageDown': () =>
          expanded ? setOffset(Math.min(maxStart, start + Math.max(1, Math.floor(maxLines / 2)))) : goFile(8),
        'diff:fullPageDown': () => (expanded ? setOffset(Math.min(maxStart, start + maxLines)) : goFile(8)),
        'diff:top': () => (expanded ? setOffset(0) : goFile(-files.length)),
        'diff:bottom': () => (expanded ? setOffset(maxStart) : goFile(files.length)),
      },
    },
    {isActive},
  );
  const mouse = useMouseTarget(event => {
    if ('direction' in event) setOffset(value => Math.max(0, Math.min(maxStart, value + event.direction * 3)));
  }, isActive);
  const fileKeys = useBindingLabel('DiffDialog', 'diff:nextFile');
  const sourceKeys = useBindingLabel('DiffDialog', 'diff:nextSource');
  const pageKeys = useBindingLabel('DiffDialog', 'diff:pageDown');
  const openKeys = useBindingLabel('DiffDialog', 'diff:open');
  const backKeys = useBindingLabel('DiffDialog', 'diff:back');
  return (
    <Box width={width} minWidth={0} flexDirection="column">
      <MouseRow isActive={isActive} onHighlight={() => goSource(1)}>
        <Text color={color('foregroundMuted')}>
          /diff · {layer} · {files.length} files +{files.reduce((n, file) => n + file.additions, 0)} -
          {files.reduce((n, file) => n + file.deletions, 0)}
          {report.truncated ? ' · bounded' : ''}
        </Text>
      </MouseRow>
      {!expanded ? (
        <DiffFileList
          group={{...group, onToggle: toggleGroup}}
          files={files}
          selected={selected}
          width={width ?? 80}
          isActive={isActive}
          onMove={goFile}
          onSelect={at => {
            setIndex(at);
            setOffset(0);
          }}
        />
      ) : null}
      {file ? (
        <>
          <TextLine
            width={width}
          >{`${selected + 1}/${files.length} ${file.path}${file.oldPath ? ` ← ${file.oldPath}` : ''} · ${file.layer ?? file.status}${file.binary ? ' · binary' : ''}${file.truncated ? ' · bounded' : ''}`}</TextLine>
          <Box ref={mouse} flexDirection="column">
            <DiffView
              lines={diffRows}
              width={width ?? 80}
              offset={offset}
              viewportRows={maxLines}
              onRowCount={setPhysicalRows}
              showHunks
              language={diffLanguage(file.path)}
            />
            {!file.lines.length ? <Text>Empty or binary diff</Text> : null}
          </Box>
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
        {`${fileKeys} ${expanded ? 'scroll' : 'files'} · ${sourceKeys} source · ${openKeys} open · ${backKeys} back · ${pageKeys} scroll`}
      </Text>
    </Box>
  );
}
