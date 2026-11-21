/** @jsxImportSource react */
import {useState} from 'react';
import {Box, Text} from 'ink';
import type {RewindScope} from '@cosmew/sdk';
import {useFutrynClient, useKeybindings, useKeymap, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {useTheme} from '../../theme';
import {OptionList, Panel, TextLine, safeText, useUiTheme} from '../../ui';
import {useDialogRows} from '../../ui/dialog-layout';
import {useDialogRefresh, useDialogSize, useDialogTask, type DialogProps} from '../picker';
import {mcpRowText, rewindRows} from './logic';
export * from './logic';
/** Read-only metadata: no endpoint, environment or header values cross the snapshot. */
export function McpDialog(props: DialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const {color} = useTheme();
  const ui = useUiTheme();
  const size = useDialogSize(props);
  const report = client.mcpServers();
  const servers = [...report.servers].sort((a, b) => a.source.localeCompare(b.source));
  const availableRows = useDialogRows();
  const listRows = Math.max(1, Math.min(size.visibleRows, Math.floor(((availableRows ?? 24) - 8) / 2)));
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState(false);
  useKeymap({
    previous: () => {
      setCursor(n => Math.max(0, n - 1));
      setDetail(false);
    },
    next: () => {
      // Keep the cursor valid while an initially empty report is refreshed asynchronously.
      setCursor(n => Math.max(0, Math.min(report.servers.length - 1, n + 1)));
      setDetail(false);
    },
    submit: () => setDetail(v => !v),
  });
  const muted = color('foregroundMuted');
  const first = Math.max(0, cursor - listRows + 1);
  const selected = servers[cursor];
  return (
    <Panel width={size.width}>
      <Text bold color={ui.color('rule')}>
        MCP servers
      </Text>
      <TextLine>{`${report.servers.length} servers`}</TextLine>
      {report.servers.length === 0 ? <TextLine>No servers configured.</TextLine> : null}
      {servers.slice(first, first + listRows).map((server, index) => (
        <Box key={`${server.source}:${server.name}`} flexDirection="column">
          {index === 0 || servers[first + index - 1]?.source !== server.source ? (
            <TextLine color={muted}>{server.source || 'Unknown source'}</TextLine>
          ) : null}
          <OptionList
            width={size.width - 4}
            cursor={cursor === first + index ? 0 : -1}
            items={[
              {
                id: server.name,
                label: mcpRowText({name: server.name, state: server.status, tools: server.toolCount}),
                numbered: false,
              },
            ]}
          />
        </Box>
      ))}
      {detail && selected ? <TextLine color={muted}>{`Source: ${selected.source}`}</TextLine> : null}
      <TextLine color={muted}>Project files are not started.</TextLine>
      {!report.supported.stdioManagement ? <TextLine color={muted}>Stdio management: Not implemented</TextLine> : null}
      {!report.supported.oauthManagement ? <TextLine color={muted}>OAuth management: Not implemented</TextLine> : null}
      <TextLine color={muted}>↑/↓ to navigate · Enter to view · Esc to close</TextLine>
    </Panel>
  );
}
export function HooksDialog(props: DialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const {color} = useTheme();
  const ui = useUiTheme();
  const size = useDialogSize(props);
  const snapshot = client.hooks();
  return (
    <Panel width={size.width}>
      <Text bold color={ui.color('rule')}>
        Hooks
      </Text>
      <TextLine>This menu is read-only.</TextLine>
      {snapshot.hooks.length === 0 ? <TextLine>No hooks configured.</TextLine> : null}
      {!snapshot.supported ? <TextLine>Not implemented</TextLine> : null}
      <TextLine color={color('foregroundMuted')}>Hook execution is not supported by this backend.</TextLine>
      <TextLine color={color('foregroundMuted')}>Esc to close</TextLine>
    </Panel>
  );
}
/** SDK owns restore policy, conflict checks, dispatcher writes and conversation forks. */
export function RewindDialog({onCancel, ...props}: DialogProps & {onCancel?: () => void}) {
  const client = useFutrynClient();
  const router = useOverlay();
  const task = useDialogTask();
  useDialogRefresh();
  const {color} = useTheme();
  const ui = useUiTheme();
  const size = useDialogSize(props);
  const checkpoints = client.checkpoints();
  const availableRows = useDialogRows();
  const rows = rewindRows(checkpoints);
  const [cursor, setCursor] = useState(rows.length);
  const [confirm, setConfirm] = useState(false);
  const [scopeCursor, setScopeCursor] = useState(0);
  const [summaryFocus, setSummaryFocus] = useState(false);
  const [instructions, setInstructions] = useState('');
  const max = rows.length;
  const at = Math.min(cursor, max);
  const checkpoint = checkpoints[at];
  const scopes: {scope: RewindScope | 'cancel'; label: string; disabled?: boolean}[] = [
    {
      scope: 'both',
      label: `Restore code and conversation${checkpoint?.restorable ? '' : ' (unavailable: no code restore)'}`,
      disabled: !checkpoint?.restorable,
    },
    {scope: 'conversation', label: 'Restore conversation only'},
    {
      scope: 'code',
      label: `Restore code only${checkpoint?.restorable ? '' : ' (unavailable: no code restore)'}`,
      disabled: !checkpoint?.restorable,
    },
    {scope: 'summarize', label: 'Summarize from here'},
    {scope: 'cancel', label: 'Never mind'},
  ];
  const activate = () => {
    if (task.busy) return;
    if (!checkpoint) {
      task.setMessage('Nothing to rewind to.');
      return;
    }
    if (!confirm) {
      setScopeCursor(checkpoint.restorable ? 0 : 1);
      setConfirm(true);
      return;
    }
    const choice = scopes[scopeCursor];
    if (!choice) return;
    if (choice.disabled) {
      task.setMessage('Code restore is unavailable for this checkpoint.');
      return;
    }
    const scope = choice.scope;
    if (scope === 'cancel') {
      router.close();
      return;
    }
    if (scope === 'summarize' && !summaryFocus) {
      setSummaryFocus(true);
      task.setMessage('');
      return;
    }
    void task.run(async signal => {
      const result = await client.rewind(
        {checkpointId: checkpoint.id, scope, ...(scope === 'summarize' ? {instructions} : {})},
        signal,
      );
      if (!result.restored) {
        task.setMessage(`Restore failed${result.code ? `: ${result.code}` : '.'}`);
        return;
      }
      router.close();
    });
  };
  useKeybindings({
    MessageSelector: {
      'rewind:previous': () =>
        summaryFocus ? undefined : confirm ? setScopeCursor(n => Math.max(0, n - 1)) : setCursor(Math.max(0, at - 1)),
      'rewind:next': () =>
        summaryFocus
          ? undefined
          : confirm
            ? setScopeCursor(n => Math.min(scopes.length - 1, n + 1))
            : setCursor(Math.min(max, at + 1)),
      'rewind:first': () => (summaryFocus ? undefined : confirm ? setScopeCursor(0) : setCursor(0)),
      'rewind:last': () => (summaryFocus ? undefined : confirm ? setScopeCursor(scopes.length - 1) : setCursor(max)),
      'rewind:accept': activate,
      'rewind:cancel': () => {
        if (task.busy) router.close();
        else if (summaryFocus) setSummaryFocus(false);
        else if (confirm) setConfirm(false);
        else if (onCancel) onCancel();
        else router.close();
      },
    },
  });
  useTextInput((input, key) => {
    if (
      !summaryFocus ||
      task.busy ||
      key.eventType === 'release' ||
      key.ctrl ||
      key.meta ||
      key.escape ||
      key.return ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow
    )
      return;
    if (key.backspace || key.delete) setInstructions(s => Array.from(s).slice(0, -1).join(''));
    else if (input) setInstructions(s => (s + safeText(input).replace(/\n/g, ' ')).slice(0, 4000));
  });
  const muted = color('foregroundMuted');
  const room = Math.max(1, Math.min(Math.floor(size.visibleRows / 2), Math.floor(((availableRows ?? 24) - 6) / 2)));
  const first = Math.max(0, Math.min(at - room + 1, max - room));
  return (
    <Panel width={size.width}>
      <Text bold color={ui.color('rule')}>
        Rewind
      </Text>
      <TextLine>Restore the code and/or conversation to the point before…</TextLine>
      {summaryFocus ? (
        <>
          <TextLine>Summarize from this checkpoint onward into a new conversation.</TextLine>
          <TextLine color={muted}>Optional focus (leave blank for a general handoff):</TextLine>
          <TextLine>{`${instructions}▏`}</TextLine>
        </>
      ) : confirm ? (
        <>
          <TextLine>{checkpoint?.text || checkpoint?.prompt || ''}</TextLine>
          <TextLine color={muted}>Shell, MCP and subagent changes are not restored.</TextLine>
          <OptionList
            width={size.width - 4}
            cursor={scopeCursor}
            items={scopes.map(item => ({id: item.scope, label: item.label, muted: item.disabled}))}
          />
        </>
      ) : (
        <>
          {rows.slice(first, first + room).map((row, index) => (
            <Box key={row.id} flexDirection="column">
              <Text
                wrap="truncate-end"
                color={first + index === at ? ui.color('selected') : undefined}
              >{`${first + index === at ? '❯' : ' '} ${row.prompt}`}</Text>
              <Text wrap="truncate-end" color={muted}>{`    ${row.detail}`}</Text>
            </Box>
          ))}
          <OptionList
            width={size.width - 4}
            cursor={at === max ? 0 : -1}
            items={[{id: 'current', label: '(current)', numbered: false}]}
          />
        </>
      )}
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      {task.busy ? <TextLine color={muted}>{summaryFocus ? 'Summarizing…' : 'Restoring…'}</TextLine> : null}
      <TextLine color={muted}>Enter to continue · Esc to cancel</TextLine>
    </Panel>
  );
}
