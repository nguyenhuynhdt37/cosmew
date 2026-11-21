/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useStatus} from '../../hooks';
import {useTheme} from '../../theme';
import {TextLine} from '../../ui';
import {CosmewMascot} from '../../ui/cosmew-mascot';
import type {FutrynClient} from '@cosmew/sdk';
export const useHeader = () => useStatus();
export interface HeaderProps {
  status: ReturnType<FutrynClient['status']>;
  version: string;
  width?: number;
  preview?: boolean;
  stateLabel?: string;
  reactiveEffectsEnabled?: boolean;
}

export function Header({
  status,
  version,
  width,
  preview = false,
  stateLabel,
  reactiveEffectsEnabled = true,
}: HeaderProps) {
  const {color} = useTheme();
  const phase = stateLabel ?? (reactiveEffectsEnabled ? status.phase : 'ready');
  return (
    <Box width={width} flexDirection="row" columnGap={1} minWidth={0}>
      <CosmewMascot width={width} animate={reactiveEffectsEnabled} />
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        <Box width={width} minWidth={0} flexWrap="wrap" columnGap={1}>
          <Text bold color={color('accent')}>{`✻ COSMEW${version ? ` ${version}` : ''}`}</Text>
          <Text color={color('foregroundMuted')}>{`· ${phase}`}</Text>
          {preview ? <Text color={color('info')}>· preview</Text> : null}
        </Box>
        <TextLine color={color('foregroundMuted')} width={width}>
          {`${status.workspace} · ${status.selection?.modelId ?? 'No model selected'}`}
        </TextLine>
      </Box>
    </Box>
  );
}
