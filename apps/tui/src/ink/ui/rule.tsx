/** @jsxImportSource react */
import {useTerminalSize} from '../hooks/use-terminal-size';
import {Text} from 'ink';
import {useUiTheme} from './ui-theme';
/** `─` frames the composer and permission/question dialogs; `▔` opens panels (spec 7). */
export function Rule({width, color, glyph = '─'}: {width?: number; color?: string; glyph?: '─' | '▔' | '╌'}) {
  const {columns} = useTerminalSize();
  const theme = useUiTheme();
  return (
    <Text color={color ?? (theme.colors ? theme.tokens.border : undefined)}>
      {glyph.repeat(Math.max(0, Math.floor(width ?? columns)))}
    </Text>
  );
}
