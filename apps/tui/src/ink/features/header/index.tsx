/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useStatus} from '../../hooks';
import {useTheme} from '../../theme';
import {safeText} from '../../ui';
import {cosmewMascotWidth} from '../../../theme/cosmew-mascot';
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
  const phase = safeText(stateLabel ?? (reactiveEffectsEnabled ? status.phase : 'ready')).replace(/\n/g, ' ');
  const mascotWidth = cosmewMascotWidth(width ?? 80);
  const compact = mascotWidth === 3;
  const model = status.selection?.modelId ?? 'No model selected';
  const title = `✻ COSMEW${version ? ` ${version}` : ''}`;
  const context = safeText(compact ? model : `${status.workspace} · ${model}`).replace(/\n/g, ' ');
  return (
    <Box width={width} flexDirection="row" columnGap={1} minWidth={0}>
      <Box width={mascotWidth} flexShrink={0}>
        <CosmewMascot width={width} animate={reactiveEffectsEnabled} />
      </Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        <Text wrap="truncate-end" color={color('foregroundMuted')}>
          <Text bold color={color('accent')}>
            {title}
          </Text>
          {compact ? null : ` · ${phase}`}
          {!compact && preview ? <Text color={color('info')}> · preview</Text> : null}
        </Text>
        {compact ? (
          <Text wrap="truncate-end" color={color('foregroundMuted')}>
            {phase}
            {preview ? <Text color={color('info')}> · preview</Text> : null}
          </Text>
        ) : null}
        <Text wrap="truncate-end" color={color('foregroundMuted')}>
          {context}
        </Text>
      </Box>
    </Box>
  );
}
