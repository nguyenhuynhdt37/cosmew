/** @jsxImportSource react */
import {Box, Text} from 'ink';
import type {ReactNode} from 'react';
import {useTheme} from '../theme';
import {safeText} from './text-line';
export interface PanelProps {
  children: ReactNode;
  title?: string;
  width?: number;
  focused?: boolean;
  padding?: number;
}
export function Panel({children, title, width, focused = false, padding = 1}: PanelProps) {
  const {color} = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color(focused ? 'borderFocused' : 'border')}
      width={width}
      paddingX={padding}
      minWidth={0}
    >
      {title ? (
        <Text bold color={color('foreground')}>
          {safeText(title)}
        </Text>
      ) : null}
      {children}
    </Box>
  );
}
