/** @jsxImportSource react */
import {Text} from 'ink';
import {useTheme} from '../theme';
import {safeText} from './text-line';
export interface KeyHintProps {
  keys: string;
  label: string;
}
export function KeyHint({keys, label}: KeyHintProps) {
  const {color} = useTheme();
  return <Text color={color('foregroundMuted')}>{`${safeText(keys)} ${safeText(label)}`}</Text>;
}
