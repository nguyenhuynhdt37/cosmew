/** @jsxImportSource react */
import {useEffect, useRef, useState} from 'react';
import {Box} from 'ink';
import {useFutrynClient, useKeymap} from '../../hooks';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useTheme} from '../../theme';
import {useUiTheme} from '../../ui/ui-theme';
import {wrapWords} from '../../../input/text';
import {Panel, TextLine} from '../../ui';
import {Onboarding, useOnboarding} from '../onboarding';

export interface StartupGateOptions {
  onReady(): void;
  onExit(): void;
}

export function useStartupGate({onReady, onExit}: StartupGateOptions) {
  const client = useFutrynClient();
  const onboarding = useOnboarding();
  const [trusted, setTrusted] = useState(() => client.workspaceTrusted());
  const [index, setIndex] = useState(0);
  const opened = useRef(false);
  const exiting = useRef(false);
  const showTrust = !onboarding.step && !trusted && !exiting.current;
  useEffect(() => {
    client.setToolsEnabled(false);
    return () => {
      opened.current = false;
      client.setToolsEnabled(false);
    };
  }, [client]);
  useEffect(() => {
    if (!trusted || onboarding.step || exiting.current || opened.current) return;
    opened.current = true;
    client.setToolsEnabled(true);
    onReady();
  }, [client, trusted, onboarding.step, onReady]);

  const exit = () => {
    exiting.current = true;
    client.setToolsEnabled(false);
    onExit();
  };
  useKeymap(
    {
      previous: () => setIndex(i => 1 - i),
      next: () => setIndex(i => 1 - i),
      submit: () => {
        if (index === 0) return exit();
        client.trustWorkspace();
        setTrusted(true);
      },
    },
    {isActive: showTrust},
  );
  return {onboarding, showTrust, index, exit, workspace: client.workspace()};
}

export interface StartupGateProps {
  state: ReturnType<typeof useStartupGate>;
  width?: number;
}

export function StartupGate({state, width}: StartupGateProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const {columns} = useTerminalSize();
  const wrap = (text: string) => wrapWords(text, Math.max(1, (width ?? columns) - 2)).join('\n');
  if (state.onboarding.step)
    return <Onboarding step={state.onboarding.step} finish={state.onboarding.finish} width={width} />;
  if (!state.showTrust) return null;

  const choice = (label: string, i: number) => (
    <TextLine key={label} color={state.index === i ? ui.color('selected') : undefined}>
      {`${state.index === i ? '❯' : ' '} ${label}`}
    </TextLine>
  );
  const muted = color('foregroundMuted');
  return (
    <Panel width={width} ruleStyle="dialog" accent={color('warning')} title="Accessing workspace:">
      <Box height={1} />
      <TextLine bold>{state.workspace}</TextLine>
      <Box height={1} />
      <TextLine>
        {wrap(
          "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
        )}
      </TextLine>
      <Box height={1} />
      <TextLine>Cosmew will be able to read, edit, and execute files here.</TextLine>
      <Box height={1} />
      <TextLine color={muted}>
        {wrap('Consent is remembered for this workspace and does not grant individual tool permissions.')}
      </TextLine>
      <Box height={1} />
      <TextLine color={muted}>Security guide</TextLine>
      <Box height={1} />
      {['No, exit', 'Yes, I trust this folder'].map(choice)}
      <Box height={1} />
      <TextLine color={muted}>Enter to confirm · Esc to cancel</TextLine>
    </Panel>
  );
}
