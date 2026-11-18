/** @jsxImportSource react */
import {Box} from 'ink';
import {useStatus} from '../../hooks';
import {TextLine} from '../../ui';
import {useTheme} from '../../theme';
import type {FutrynClient} from '@futryn/sdk';
export const useWelcome = () => useStatus();
export interface WelcomeProps {
  status: ReturnType<FutrynClient['status']>;
  width?: number;
  greeting?: string;
}
export function Welcome({status, width, greeting = 'Quiet desk. Clear answers.'}: WelcomeProps) {
  const {color} = useTheme();
  return (
    <Box width={width} flexDirection="column">
      <TextLine color={color('foregroundMuted')}>{greeting}</TextLine>
      <TextLine>
        {!status.activeAccount
          ? 'Connect a provider to start · /login · /help'
          : !status.selection
            ? 'Choose a model to start · /model · /help'
            : `${status.selection.modelId} · ${status.activeAccount.alias}`}
      </TextLine>
      <TextLine color={color('foregroundMuted')}>
        Tips: /help · @ files · $ skills · Shift+Enter new line · Shift+Tab permissions
      </TextLine>
    </Box>
  );
}
