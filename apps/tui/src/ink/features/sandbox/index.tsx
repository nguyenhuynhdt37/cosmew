/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {Box} from 'ink';
import {MouseRow} from '../../ui/mouse-row';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {useFutrynClient, useKeybindings} from '../../hooks';
import {Panel, PanelTabs, TextLine} from '../../ui';
import {useDialogRefresh, useDialogSize, type DialogProps} from '../picker';
import {SANDBOX_TABS, SANDBOX_MODES, activeSandboxMode, dependencyRows} from './logic';
export function SandboxDialog(props: DialogProps) {
  const client = useFutrynClient();
  const {refresh} = useDialogRefresh();
  const size = useDialogSize(props);
  const sandbox = client.permissionSettings().sandbox;
  const [tab, setTab] = useState(0);
  const [cursor, setCursor] = useState(() => activeSandboxMode(sandbox));
  const [error, setError] = useState('');
  const [dependencies, setDependencies] = useState<string[]>(['Checking sandbox dependencies…']);
  useEffect(() => {
    if (tab !== 1 || !sandbox.enabled) return;
    let active = true;
    setDependencies(['Checking sandbox dependencies…']);
    void client
      .sandboxDependencies()
      .then(report => {
        if (active) setDependencies(dependencyRows(report));
      })
      .catch(() => {
        if (active) setDependencies(['Sandbox dependency report unavailable.']);
      });
    return () => {
      active = false;
    };
  }, [client, tab, sandbox.enabled]);
  const moveTab = (delta: number) => {
    setTab(at => (at + delta + SANDBOX_TABS.length) % SANDBOX_TABS.length);
    setCursor(0);
  };
  const count = tab === 0 ? 3 : tab === 2 ? 2 : 1;
  useKeybindings({
    Tabs: {'tabs:next': () => moveTab(1), 'tabs:previous': () => moveTab(-1)},
    Select: {
      'select:next': () => setCursor(at => (at + 1) % count),
      'select:previous': () => setCursor(at => (at + count - 1) % count),
      'select:accept': () => {
        try {
          if (tab === 0) client.updateSandbox(SANDBOX_MODES[cursor]!.patch);
          else if (tab === 2) client.updateSandbox({allowUnsandboxedCommands: cursor === 0});
          setError('');
          refresh();
        } catch {
          setError('Could not save user sandbox settings.');
        }
      },
    },
  });
  const mouseRef = useMouseTarget(
    event => {
      if ('direction' in event) setCursor(at => Math.max(0, Math.min(count - 1, at + event.direction)));
    },
    tab === 0 || tab === 2,
  );
  const rows =
    tab === 0
      ? SANDBOX_MODES.map(
          (mode, at) =>
            `${cursor === at ? '❯' : ' '} ${mode.label}${activeSandboxMode(sandbox) === at ? ' (active)' : ''}`,
        )
      : tab === 2
        ? ['Allow unsandboxed fallback', 'Strict sandbox mode'].map(
            (label, at) =>
              `${cursor === at ? '❯' : ' '} ${label}${sandbox.allowUnsandboxedCommands === (at === 0) ? ' (active)' : ''}`,
          )
        : tab === 3
          ? [
              'excludedCommands',
              ...sandbox.excludedCommands.map(value => `  ${value}`),
              'network.allowedDomains',
              ...sandbox.allowedDomains.map(value => `  ${value}`),
            ]
          : sandbox.enabled
            ? dependencies
            : ['Sandbox is off; dependencies are not needed.'];
  return (
    <Panel width={size.width} ruleStyle="dialog">
      <Box flexDirection="column" minWidth={0}>
        <PanelTabs
          title="Sandbox"
          tabs={SANDBOX_TABS}
          selected={SANDBOX_TABS[tab]!}
          onSelect={value => {
            setTab(SANDBOX_TABS.indexOf(value as (typeof SANDBOX_TABS)[number]));
            setCursor(0);
          }}
        />
        <Box ref={mouseRef} flexDirection="column">
          {rows.map((row, at) => (
            <MouseRow key={at} onHighlight={() => setCursor(at)} isActive={tab === 0 || tab === 2}>
              <TextLine>{row}</TextLine>
            </MouseRow>
          ))}
        </Box>
        {error ? <TextLine>{error}</TextLine> : null}
        <TextLine>Tab to switch · ↑/↓ to choose · Enter to apply · Esc to close</TextLine>
      </Box>
    </Panel>
  );
}
