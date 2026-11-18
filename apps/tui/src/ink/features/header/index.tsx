/** @jsxImportSource react */
import {Box} from 'ink';
import {useStatus} from '../../hooks';
import {useTheme} from '../../theme';
import {TextLine} from '../../ui';
import type {FutrynClient} from '@futryn/sdk';
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
  return (
    <Box width={width} flexDirection="column">
      <TextLine
        bold
        color={color('accent')}
      >{`✻ FUTRYN ${version} · ${stateLabel ?? (reactiveEffectsEnabled ? status.phase : 'ready')}${preview ? ' · preview' : ''}`}</TextLine>
      <TextLine
        color={color('foregroundMuted')}
      >{`${status.workspace} · ${status.selection?.modelId ?? 'No model selected'}`}</TextLine>
    </Box>
  );
}
