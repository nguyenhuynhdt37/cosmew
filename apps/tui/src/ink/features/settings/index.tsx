import {useOverlay} from '../../core';
import {ThemesDialog} from '../themes';
import {SandboxDialog} from '../sandbox';
/** @jsxImportSource react */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text} from 'ink';
import {useFutrynClient, useKeybindings, useTextInput} from '../../hooks';
import {useTheme} from '../../theme';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {ListPicker, Panel, PanelTabs, safeText, TextLine, useUiTheme} from '../../ui';
import {useDialogRefresh, useDialogSize, useDialogTask, type DialogProps} from '../picker';
import {reportRows, usageSummaryRows} from '../usage/logic';
import {
  configurationRows,
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  clampStep,
  statusFields,
  statsFields,
  usageMeters,
  type SettingsSection,
  type SettingsTab,
  type ConfigurationAction,
} from './logic';
export {configurationRows, SETTINGS_SECTIONS, settingsRows, clampStep} from './logic';
export interface SettingsDialogProps extends DialogProps {
  onNavigate?: (action: ConfigurationAction) => void;
  isStreaming?: boolean;
  /** Kept for the host: every section is one searchable list now (spec 7). */
  initialSection?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  /** Tab shown first: `/config` Config, `/status` Status, `/usage` Usage, `/cost` Stats. */
  initialTab?: SettingsTab;
}
export function SettingsDialog({
  onNavigate = () => {},
  isStreaming = false,
  initialTab = 'Config',
  ...props
}: SettingsDialogProps) {
  const client = useFutrynClient();
  const router = useOverlay();
  const {engine, mode, color} = useTheme();
  const ui = useUiTheme();
  const {rows: terminalRows} = useTerminalSize();
  const size = useDialogSize(props);
  const {refresh, revision} = useDialogRefresh();
  const task = useDialogTask();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [focus, setFocus] = useState<'tabs' | 'list'>(initialTab === 'Config' ? 'list' : 'tabs');
  const [cursor, setCursor] = useState(0);
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [details, setDetails] = useState(false);
  const [offset, setOffset] = useState(0);
  const quotaRequest = useRef<AbortController | null>(null);
  const refreshQuota = useCallback(() => {
    if (quotaRequest.current) return;
    const abort = new AbortController();
    quotaRequest.current = abort;
    void client
      .refreshLimits(abort.signal)
      .catch(() => {})
      .finally(() => {
        if (quotaRequest.current === abort) quotaRequest.current = null;
        if (!abort.signal.aborted) refresh();
      });
  }, [client, refresh]);
  useEffect(
    () => () => {
      quotaRequest.current?.abort();
      quotaRequest.current = null;
    },
    [client],
  );
  useEffect(() => {
    if (tab === 'Usage') refreshQuota();
  }, [tab, refreshQuota]);
  useEffect(() => {
    if (tab !== 'Usage') return;
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [tab, refresh]);
  const switchTab = (delta: number) => {
    const next = SETTINGS_TABS[(SETTINGS_TABS.indexOf(tab) + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length]!;
    setTab(next);
    setFocus('tabs');
    setDetails(false);
    setOffset(0);
  };
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'g') setScope(s => (s === 'global' ? 'project' : 'global'));
    else if (!key.ctrl && !key.meta && input.toLowerCase() === 'd' && (tab === 'Status' || tab === 'Usage')) {
      setDetails(v => !v);
      setOffset(0);
    } else if (!key.ctrl && !key.meta && input.toLowerCase() === 'r' && tab === 'Usage') refreshQuota();
  });
  // Tabs: Tab/Shift+Tab always; ←/→ when the tab row has focus or the tab is not the editable Config list.
  const arrowsSwitch = focus === 'tabs' || tab !== 'Config';
  useKeybindings({
    Tabs: {
      'tabs:next': stroke => (stroke.key === 'right' && !arrowsSwitch ? false : switchTab(1)),
      'tabs:previous': stroke => (stroke.key === 'left' && !arrowsSwitch ? false : switchTab(-1)),
    },
  });
  // Keep the list's own Select handler reachable. When the settings parent does not own the key, it must decline
  // rather than consume it; otherwise Up/Down stop moving once the list has focus.
  useKeybindings({
    Select: {
      'select:previous': () => {
        if (tab === 'Config' && focus === 'list') {
          if (cursor === 0) {
            setFocus('tabs');
            return;
          }
          return false;
        }
        if (details || tab === 'Usage') {
          setOffset(n => Math.max(0, n - 1));
          return;
        }
        return false;
      },
      'select:next': () => {
        if (tab === 'Config' && focus === 'tabs') {
          setFocus('list');
          return;
        }
        if (details || tab === 'Usage') {
          setOffset(n => n + 1);
          return;
        }
        return false;
      },
    },
  });
  const usage = useMemo(
    () =>
      tab === 'Usage' && !details ? {meters: usageMeters(client), summary: usageSummaryRows(client.usage())} : null,
    [client, tab, details, revision],
  );
  const detail = useMemo(
    () =>
      details && (tab === 'Status' || tab === 'Usage')
        ? reportRows(client, tab === 'Status' ? 'status' : 'usage', '', true)
        : null,
    [client, tab, details, revision],
  );
  const rows =
    tab === 'Config'
      ? SETTINGS_SECTIONS.flatMap(section => configurationRows(client, section, engine.getActiveAppearance(), mode))
      : [];
  const activate = (index: number) =>
    void task.run(async () => {
      const row = rows[index];
      if (!row) return;
      if (row.disabled) {
        task.setMessage(row.disabled);
        return;
      }
      const action = row.action;
      if (!action) return;
      if (action === 'autoCompact' || action === 'verbose' || action === 'showTurnDuration') {
        client.updateUserPreferences({[action]: !client.userPreferences()[action]});
        task.setMessage(client.appearanceNotices().join(' '));
        refresh();
        return;
      }
      if (isStreaming && action !== 'sandbox' && !action.startsWith('appearance-')) {
        task.setMessage('Wait for the active turn before changing agent settings.');
        return;
      }
      if (action === 'sandbox') {
        router.push('sandbox', <SandboxDialog width={size.width} />);
        return;
      }
      if (action === 'mode') client.cycleMode();
      else if (action.startsWith('budget-')) {
        const choices = {
          'budget-steps': {key: 'maxSteps', values: [undefined, 8, 16, 32, 64]},
          'budget-calls': {key: 'maxToolCalls', values: [undefined, 16, 32, 64, 128]},
          'budget-tokens': {key: 'maxTokens', values: [undefined, 10000, 50000, 100000]},
          'budget-time': {key: 'maxDurationMs', values: [undefined, 60000, 300000, 900000]},
          'budget-cost': {key: 'maxCostUSD', values: [undefined, 1, 5, 10, 50]},
        } as const;
        const preset = choices[action as keyof typeof choices];
        const budget = {...client.turnBudget()};
        const at = (preset.values as readonly (number | undefined)[]).indexOf(budget[preset.key]);
        const value = preset.values[(at + 1) % preset.values.length];
        if (value === undefined) delete budget[preset.key];
        else budget[preset.key] = value;
        client.setDefaultTurnBudget(budget);
      } else if (action.startsWith('appearance-')) {
        const app = engine.getActiveAppearance();
        const a = app.animations;
        switch (Number(action.slice(11))) {
          case 0: {
            router.push('themes', <ThemesDialog {...props} scope={scope} />);
            break;
          }
          case 1: {
            const values = ['dark', 'light', 'system'] as const;
            await engine.setMode(values[(values.indexOf(app.mode) + 1) % 3]!, scope);
            break;
          }
          case 3:
            await engine.updateAnimation({enabled: !a.enabled}, scope);
            break;
          case 4:
            await engine.updateAnimation({motion: a.motion === 'smooth' ? 'grid' : 'smooth'}, scope);
            break;
          case 5:
            await engine.updateAnimation({speed: a.speed >= 16 ? 0.1 : clampStep(a.speed, 0.25, 0.1, 16)}, scope);
            break;
          case 6:
            await engine.updateAnimation({cellSize: (a.cellSize % 4) + 1}, scope);
            break;
          case 7:
            await engine.updateAnimation({veil: a.veil >= 0.95 ? 0 : clampStep(a.veil, 0.05, 0, 0.95)}, scope);
            break;
          case 8:
            await engine.updateAnimation({reducedMotion: !a.reducedMotion}, scope);
            break;
          case 9:
            await engine.updateAnimation({pauseUnfocused: !a.pauseUnfocused}, scope);
            break;
          case 10:
            await engine.updateAnimation({reactiveEffects: !a.reactiveEffects}, scope);
            break;
          case 11:
            await engine.updateAppearance({syntaxHighlighting: !app.syntaxHighlighting}, scope);
            break;
          case 12:
            await engine.updateAppearance({sidebar: !app.sidebar}, scope);
            break;
        }
      } else onNavigate(action);
      refresh();
    });
  const muted = color('foregroundMuted');
  const valueTone = (row: (typeof rows)[number]) => {
    if (row.action === 'sandbox') return row.value === 'Enabled' ? 'success' : 'warning';
    if (row.disabled || ['OFF', 'DISABLED', 'COLLAPSED'].includes(row.value)) return 'dim';
    if (['ON', 'ENABLED', 'VISIBLE'].includes(row.value)) return 'success';
    return 'command';
  };
  const listRows = Math.max(3, Math.min(30, (terminalRows || 24) - 12));
  const lines = (fields: readonly (readonly [string, string])[]) => {
    // Two cells after the longest label (reference Stats pads to 24), never narrower than the status tab's 19.
    const pad = Math.max(19, ...fields.map(([label]) => (label ? label.length + 3 : 0)));
    return fields.map(([label, value], at) =>
      label ? (
        <Text key={at}>
          <Text bold color={color('markdownHeading')}>
            {`${label}:`.padEnd(pad)}
          </Text>
          <Text color={value === 'Not reported' ? muted : ui.color('command')}>{safeText(value)}</Text>
        </Text>
      ) : (
        <Text key={at}> </Text>
      ),
    );
  };
  return (
    <Panel width={size.width}>
      <PanelTabs
        title="Settings"
        tabs={SETTINGS_TABS}
        selected={tab}
        onSelect={value => {
          setTab(value as SettingsTab);
          setFocus('tabs');
          setDetails(false);
          setOffset(0);
        }}
      />
      <Box height={1} />
      {tab === 'Config' ? (
        <>
          <ListPicker
            settingsKeys
            items={rows.map((r, index) => ({
              id: String(index),
              label: r.label,
              description: r.value,
              descriptionTone: valueTone(r),
            }))}
            placeholder="Search settings…"
            visibleRows={listRows}
            isActive={focus === 'list'}
            cursor={cursor}
            onCursorChange={setCursor}
            hint={false}
            onSelect={item => activate(Number(item.id))}
          />
          {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
          <Box height={1} />
          <TextLine
            color={muted}
          >{`↓ to navigate · ↑ to switch tabs · Esc to go back · Ctrl+G appearance scope: ${scope === 'project' ? 'project (session only)' : scope}`}</TextLine>
        </>
      ) : (
        <>
          {detail ? (
            <DetailRows rows={detail} offset={offset} room={listRows} />
          ) : tab === 'Status' ? (
            lines(statusFields(client))
          ) : tab === 'Stats' ? (
            lines(statsFields(client))
          ) : usage ? (
            <UsageMeters
              meters={usage.meters}
              summary={usage.summary}
              offset={offset}
              room={listRows}
              width={size.width}
              rule={ui.color('rule')}
              track={ui.color('userMessage')}
            />
          ) : null}
          <Box height={1} />
          <TextLine
            color={muted}
          >{`←/→ to switch · ${tab === 'Usage' || (tab === 'Status' && details) ? `d for ${details ? 'summary' : 'details'} · ` : ''}Esc to close${tab === 'Usage' ? ' · ↑/↓ scroll · r refresh quota' : ''}`}</TextLine>
        </>
      )}
    </Panel>
  );
}
function DetailRows({rows, offset, room}: {rows: string[]; offset: number; room: number}) {
  const start = Math.min(offset, Math.max(0, rows.length - room));
  return (
    <>
      {rows.slice(start, start + room).map((row, at) => (
        <TextLine key={start + at}>{row}</TextLine>
      ))}
    </>
  );
}
/** Keep the normal Usage view within the terminal and show bars only for current windows. */
function UsageMeters({
  meters,
  summary,
  offset,
  room,
  width,
  rule,
  track,
}: {
  meters: ReturnType<typeof usageMeters>;
  summary: string[];
  offset: number;
  room: number;
  width: number;
  rule?: string;
  track?: string;
}) {
  const {color} = useTheme();
  const bar = Math.max(4, Math.min(16, width - 12));
  const rows = [
    ...summary.map(line => <TextLine key={line}>{line}</TextLine>),
    <TextLine key="quota-heading" bold>
      Provider quota
    </TextLine>,
    ...(meters.length
      ? meters.flatMap((meter, at) => {
          const cells = meter.percent == null ? null : Math.round((Math.min(100, meter.percent) / 100) * bar);
          return [
            <Text key={`value-${at}`} wrap="truncate-end">
              <Text bold>{safeText(meter.label)}</Text>
              {' · '}
              {cells === null ? null : (
                <Text color={rule} backgroundColor={track}>
                  {'█'.repeat(cells) + ' '.repeat(bar - cells)}
                </Text>
              )}
              {cells === null ? '' : '  '}
              {safeText(meter.text)}
            </Text>,
            ...(meter.reset
              ? [
                  <TextLine key={`snapshot-${at}`} color={color('foregroundMuted')} wrap="truncate-end">
                    {meter.historical ? 'Current quota unknown · historical value above' : 'Last reported by provider'}
                  </TextLine>,
                ]
              : []),
          ];
        })
      : [<TextLine key="no-accounts">No connected accounts.</TextLine>]),
  ];
  const start = Math.min(offset, Math.max(0, rows.length - room));
  return <>{rows.slice(start, start + room)}</>;
}
