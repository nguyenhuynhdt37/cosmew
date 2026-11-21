/** @jsxImportSource react */
import {useMemo, useState} from 'react';
import {Box, Text} from 'ink';
import type {WorkspaceDiffReport, WorkspaceDiffBase} from '@cosmew/sdk';
import {useKeybindings} from '../../hooks';
import {useBindingLabel} from '../../hooks/keymap';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {MouseRow} from '../../ui/mouse-row';
import {DiffView, TextLine} from '../../ui';
import {graphemes, safeText, stringCells} from '../../ui/text-line';
import {DiffFileList, useDiffFiles} from './file-list';
import {diffLanguage, workspaceViewRows} from './logic';
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

export interface DiffSidePanelProps {
  report: WorkspaceDiffReport;
  width?: number;
  height?: number;
  isActive?: boolean;
  /** Dialog keys only when deliberately focused; modified panel keys work beside the composer. */
  focused?: boolean;
  onClose?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
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
  onFocus,
  onBlur,
  onChangeBase,
}: DiffSidePanelProps) {
  const ui = useUiTheme();
  const inner = Math.max(1, width - 2);
  const rows = Math.max(1, height);
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [baseNotice, setBaseNotice] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const {files, group, toggle} = useDiffFiles(report.files);
  const toggleGroup = () => {
    toggle();
    setIndex(0);
    setOffset(0);
  };
  const selected = Math.min(index, Math.max(0, files.length - 1));
  const file = files[selected];
  const listRows = expanded ? 0 : Math.min(8, files.length, Math.max(1, rows - 14));
  const diffRows = useMemo(() => (file ? workspaceViewRows(file) : []), [file]);
  const [physicalRows, setPhysicalRows] = useState(0);
  const listControls = files.length > listRows && !expanded ? 2 : 0;
  const bodyRows = Math.max(
    1,
    rows - listRows - listControls - (group.count && !expanded ? 1 : 0) - 9 - (baseNotice ? 1 : 0),
  );
  const maxOffset = Math.max(0, physicalRows - bodyRows);
  const move = (step: number) => {
    setIndex(value => Math.max(0, Math.min(files.length - 1, Math.min(value, files.length - 1) + step)));
    setOffset(0);
  };
  const changeBase = (direction = 1) => {
    if (!report.capabilities || !onChangeBase) {
      setBaseNotice(report.message ?? DIFF_BASE_UNSUPPORTED);
      return;
    }
    const bases: WorkspaceDiffBase[] = ['session', 'uncommitted', 'branch'];
    const start = bases.indexOf(report.base ?? 'session');
    const skipped: string[] = [];
    for (let step = 1; step <= bases.length; step++) {
      const next = bases[(start + direction * step + bases.length) % bases.length]!;
      const capability = report.capabilities[next];
      if (capability.available) {
        setIndex(0);
        setOffset(0);
        const message = skipped.length ? skipped.join('; ') : undefined;
        setBaseNotice(message);
        onChangeBase(next);
        return;
      }
      skipped.push(`${DIFF_BASE_LABELS[next]} unavailable: ${capability.reason ?? 'Unsupported'}`);
    }
    const reasons = [...new Set(bases.map(base => report.capabilities![base].reason ?? 'Unsupported'))];
    const message = reasons.length === 1 ? reasons[0]! : skipped.join('; ');
    setBaseNotice(message);
  };
  useKeybindings(
    {
      DiffPanel: {
        'app:cycleDiffBase': () => changeBase(),
        'diff:changeBase': () => changeBase(),
        'diff:scrollUp': () => move(-1),
        'diff:scrollDown': () => move(1),
      },
    },
    {isActive},
  );
  useKeybindings(
    {
      DiffDialog: {
        'diff:toggleGenerated': toggleGroup,
        'diff:previousFile': () => (expanded ? setOffset(value => Math.max(0, value - 1)) : move(-1)),
        'diff:nextFile': () => (expanded ? setOffset(value => Math.min(maxOffset, value + 1)) : move(1)),
        'diff:previousSource': () => changeBase(-1),
        'diff:nextSource': () => changeBase(),
        'diff:open': () => {
          setExpanded(value => !value);
          setOffset(0);
        },
        'diff:back': () => {
          if (expanded) {
            setExpanded(false);
            setOffset(0);
          } else (onBlur ?? onClose)?.();
        },
        'diff:pageUp': () =>
          expanded ? setOffset(value => Math.max(0, value - Math.max(1, Math.floor(bodyRows / 2)))) : move(-listRows),
        'diff:fullPageUp': () => (expanded ? setOffset(value => Math.max(0, value - bodyRows)) : move(-listRows)),
        'diff:pageDown': () =>
          expanded
            ? setOffset(value => Math.min(maxOffset, value + Math.max(1, Math.floor(bodyRows / 2))))
            : move(listRows),
        'diff:fullPageDown': () =>
          expanded ? setOffset(value => Math.min(maxOffset, value + bodyRows)) : move(listRows),
        'diff:top': () => (expanded ? setOffset(0) : move(-files.length)),
        'diff:bottom': () => (expanded ? setOffset(maxOffset) : move(files.length)),
      },
    },
    {isActive: isActive && focused},
  );
  const mouse = useMouseTarget(event => {
    if ('direction' in event) {
      onFocus?.();
      setOffset(value => Math.max(0, Math.min(maxOffset, value + event.direction * 3)));
    } else onFocus?.();
  }, isActive);
  const focusKey = useBindingLabel('DiffPanel', 'diff:focus');
  const fileKey = useBindingLabel('DiffDialog', 'diff:nextFile');
  const openKey = useBindingLabel('DiffDialog', 'diff:open');
  const backKey = useBindingLabel('DiffDialog', 'diff:back');
  const blurKey = useBindingLabel('DiffPanel', 'diff:blur');
  const sourceKey = useBindingLabel('DiffPanel', 'app:cycleDiffBase');
  const pageKey = useBindingLabel('DiffDialog', 'diff:pageDown');
  const pair = (left: string, right: string) => {
    const clean = safeText(left).replace(/\n/g, ' ');
    const available = Math.max(0, inner - stringCells(right) - 1);
    if (stringCells(clean) <= available)
      return clean + ' '.repeat(inner - stringCells(clean) - stringCells(right)) + right;
    let clipped = '';
    let remaining = Math.max(0, available - 1);
    for (const {segment} of graphemes.segment(clean)) {
      remaining -= stringCells(segment);
      if (remaining < 0) break;
      clipped += segment;
    }
    if (available > 0) clipped += '…';
    return clipped + ' '.repeat(Math.max(1, inner - stringCells(clipped) - stringCells(right))) + right;
  };
  return (
    <Box width={width} height={rows} flexShrink={0} backgroundColor={ui.color('panel')} overflow="hidden">
      <Box width={1} flexDirection="column" flexShrink={0}>
        <Text>{Array(rows).fill('│').join('\n')}</Text>
      </Box>
      <Box width={inner} flexDirection="column" flexShrink={0}>
        <Box justifyContent="flex-end" width={inner} flexShrink={0}>
          <MouseRow isActive={isActive} onHighlight={onClose}>
            <Text color={ui.color('dim')}>✕</Text>
          </MouseRow>
        </Box>
        <MouseRow isActive={isActive} onHighlight={() => changeBase()}>
          <TextLine width={inner} wrap="truncate-end">
            {pair(
              `${report.files.length} ${report.files.length === 1 ? 'file' : 'files'} changed +${report.totalAdditions} -${report.totalDeletions}`,
              `source: ${DIFF_BASE_LABELS[report.base ?? 'session']} ▾`,
            )}
          </TextLine>
        </MouseRow>
        <Text> </Text>
        {!expanded ? (
          <DiffFileList
            group={{...group, onToggle: toggleGroup}}
            files={files}
            selected={selected}
            rows={listRows}
            width={inner}
            isActive={isActive}
            onMove={step => {
              move(step);
              onFocus?.();
            }}
            onSelect={at => {
              setIndex(at);
              setOffset(0);
              onFocus?.();
            }}
          />
        ) : null}
        <Text> </Text>
        <Text color={ui.color('dim')}>{'─'.repeat(inner)}</Text>
        <TextLine width={inner} wrap="truncate-end">
          {pair(`${files.length ? selected + 1 : 0}/${files.length} ${file?.path ?? 'Workspace diff'}`, '[ ask ]')}
        </TextLine>
        <Text color={ui.color('dim')}>{'─'.repeat(inner)}</Text>
        <Box
          flexDirection="column"
          flexGrow={1}
          flexBasis={0}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          ref={mouse}
        >
          <Box flexDirection="column" flexShrink={0}>
            {file ? (
              file.binary ? (
                <TextLine width={inner}>Binary diff unavailable</TextLine>
              ) : file.lines.length ? (
                <DiffView
                  lines={diffRows}
                  width={inner}
                  offset={offset}
                  viewportRows={bodyRows}
                  onRowCount={setPhysicalRows}
                  showHunks
                  language={diffLanguage(file.path)}
                />
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
            ? `${fileKey} ${expanded ? 'scroll' : 'files'} · ${openKey} ${expanded ? 'list' : 'open'} · ${expanded ? backKey : blurKey} ${expanded ? 'back' : 'prompt'}`
            : `${focusKey} focus · ↓/j files · PgDn`}
        </TextLine>
        <TextLine
          width={inner}
          color={ui.color('dim')}
          wrap="truncate-end"
        >{`${sourceKey} source · ${pageKey} scroll`}</TextLine>
      </Box>
    </Box>
  );
}
