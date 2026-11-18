/** @jsxImportSource react */
import {Box, Text, useApp, useWindowSize} from 'ink';
import type {ReactNode} from 'react';
import type {FutrynClient} from '@futryn/sdk';
import {ThemeEngine} from '../theme/theme';
import {OverlayProvider, useOverlay} from './core/overlay';
import {FutrynClientProvider, InputScope, useKeymap} from './hooks';
import {ThemeProvider} from './theme';
import {IntegratedShell, type IntegratedShellProps} from './integrated-shell';

export interface AppSlots {
  transcript?: ReactNode;
  plan?: ReactNode;
  composer?: ReactNode;
  status?: ReactNode;
}
export interface InkAppProps extends IntegratedShellProps {
  client: FutrynClient;
  themeEngine?: ThemeEngine;
  slots?: AppSlots;
  width?: number;
  onInterrupt?: () => void;
}
const defaultTheme = new ThemeEngine({systemDarkPreference: true});
function Shell({slots = {}, width, onInterrupt}: Omit<InkAppProps, 'client' | 'themeEngine'>) {
  const {active, close} = useOverlay();
  const {exit} = useApp();
  const {columns} = useWindowSize();
  useKeymap({
    close: () => {
      if (active) close();
      else onInterrupt?.();
    },
    exit: () => exit(),
  });
  return (
    <Box flexDirection="column" width={Math.max(1, width ?? columns ?? 80)} minWidth={0}>
      <InputScope active={!active}>
        <Box flexDirection="column" minWidth={0}>
          {slots.transcript}
        </Box>
        <Box flexDirection="column" minWidth={0}>
          {slots.plan}
        </Box>
        <Box flexDirection="column" minWidth={0}>
          {slots.composer}
        </Box>
        <Box flexDirection="column" minWidth={0}>
          {slots.status}
        </Box>
      </InputScope>
      {active?.content}
    </Box>
  );
}
/** Slots run inside all providers. Features use useOverlay rather than importing this root. */
export function InkApp({client, themeEngine = defaultTheme, ...props}: InkAppProps) {
  return (
    <FutrynClientProvider client={client}>
      <ThemeProvider engine={themeEngine}>
        <OverlayProvider>{props.slots ? <Shell {...props} /> : <IntegratedShell {...props} />}</OverlayProvider>
      </ThemeProvider>
    </FutrynClientProvider>
  );
}
export function FoundationNotice({initialCommand, warning}: {initialCommand?: string; warning?: string}) {
  return (
    <Box flexDirection="column">
      <Text>Futryn · Ink preview</Text>
      <Text>Non-TTY preview · workspace access and interactive input are disabled.</Text>
      {warning ? <Text>{warning}</Text> : null}
      {initialCommand ? (
        <Text>Initial command skipped: folder consent and account verification require a TTY.</Text>
      ) : null}
    </Box>
  );
}
