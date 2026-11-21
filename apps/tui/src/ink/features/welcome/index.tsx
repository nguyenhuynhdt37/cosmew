/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useStatus} from '../../hooks';
import {safeText, useUiTheme} from '../../ui';
import type {FutrynClient} from '@cosmew/sdk';
import {version} from '../../../../package.json';
import {CosmewMascot} from '../../ui/cosmew-mascot';
import {cosmewMascotWidth} from '../../../theme/cosmew-mascot';
export const useWelcome = () => useStatus();
export interface WelcomeProps {
  status: ReturnType<FutrynClient['status']>;
  width?: number;
}
/** Keep the final directory visible, using terminal cell width (including wide characters). */
export function welcomePath(path: string, width: number): string {
  const clean = safeText(path).replace(/\n/g, ' ');
  if (Bun.stringWidth(clean) <= width) return clean;
  let tail = clean.split('/').filter(Boolean).at(-1) ?? '';
  while (tail && Bun.stringWidth(`/…/${tail}`) > width) tail = Array.from(tail).slice(1).join('');
  return width >= 3 ? `/…/${tail}` : '…'.slice(0, width);
}
export function Welcome({status, width = 80}: WelcomeProps) {
  const {color} = useUiTheme();
  const mascotWidth = cosmewMascotWidth(width);
  const textWidth = Math.max(1, width - mascotWidth - 2);
  const effort = status.reasoningEffort;
  const model = status.selection?.modelId ?? 'No model selected';
  return (
    <Box width={width} marginBottom={1}>
      <Box width={mascotWidth} flexShrink={0} flexDirection="column" marginRight={2}>
        <CosmewMascot width={width} />
      </Box>
      <Box width={textWidth} flexDirection="column">
        <Text bold wrap="truncate-end">{`Cosmew v${version}`}</Text>
        <Text color={color('dim')} wrap="truncate-end">
          {safeText(
            mascotWidth === 3
              ? model
              : `${model}${effort ? ` with ${effort} effort` : ''} · ${status.activeAccount?.alias ?? 'no account'}`,
          ).replace(/\n/g, ' ')}
        </Text>
        <Text color={color('dim')} wrap="truncate-end">
          {welcomePath(status.workspace, textWidth)}
        </Text>
      </Box>
    </Box>
  );
}
