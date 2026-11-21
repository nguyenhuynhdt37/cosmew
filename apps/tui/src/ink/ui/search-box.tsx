/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useTerminalSize} from '../hooks/use-terminal-size';
import {useTheme} from '../theme';
import {useUiTheme} from './ui-theme';
import {safeText} from './text-line';
export interface SearchBoxProps {
  /** Text typed so far; empty shows the muted placeholder. */
  value?: string;
  /** Shown after `⌕ ` while empty (`Search…`, `Search settings…`, `Filter history…`). */
  placeholder?: string;
  /** Total width of the framed box; defaults to the terminal width minus the 2-column indent on both sides. */
  width?: number;
  /** Show the caret (the box owns the keyboard). */
  focused?: boolean;
}
/** The bordered `⌕` search box of the command panels (spec 7): rounded frame in the selection colour. */
export function SearchBox({value = '', placeholder = 'Search…', width, focused = true}: SearchBoxProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const {columns} = useTerminalSize();
  const clean = safeText(value).replace(/\n/g, ' ');
  return (
    <Box
      borderStyle="round"
      borderColor={ui.color('selected')}
      width={Math.max(6, width ?? columns - 4)}
      paddingX={1}
      minWidth={0}
    >
      <Text color={color('foregroundMuted')}>{'⌕ '}</Text>
      {clean ? (
        <Text>
          {clean}
          {focused ? '▏' : ''}
        </Text>
      ) : (
        <Text color={color('foregroundMuted')}>{safeText(placeholder)}</Text>
      )}
    </Box>
  );
}
