/** @jsxImportSource react */
import {Text} from 'ink';
import {useUiTheme} from './ui-theme';
export function Pointer({selected = false}: {selected?: boolean}) {
  const {color} = useUiTheme();
  return <Text color={selected ? color('selected') : undefined}>{selected ? '❯ ' : '  '}</Text>;
}
