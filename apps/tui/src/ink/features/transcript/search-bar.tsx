/** @jsxImportSource react */
import {Box, Text, type Key} from 'ink';
import {useKeybindings} from '../../hooks/keymap/react';
import {Rule, safeText} from '../../ui';

export function SearchBar({
  query,
  onChange,
  onClose,
  width,
  badge,
  count = 0,
}: {
  query: string;
  onChange(query: string): void;
  onClose(keep: boolean): void;
  width: number;
  badge?: string | null;
  count?: number;
}) {
  const edit = (input: string, key: Key) => {
    if (key.escape) onClose(false);
    else if (key.return) onClose(true);
    else if (key.backspace || key.delete) onChange(Array.from(query).slice(0, -1).join(''));
    else if (!key.ctrl && !key.meta && input) onChange(query + safeText(input));
    else if (key.ctrl && input === 'u') onChange('');
    return true;
  };
  useKeybindings(
    {Transcript: {'transcript:exit': () => onClose(false)}, Chat: {'chat:submit': () => onClose(true)}},
    {rawFirst: true, onKey: edit},
  );
  useKeybindings({}, {onKey: edit});
  const hints = [badge, width >= 70 && count > 0 ? 'enter to keep' : null, width >= 50 ? 'esc to cancel' : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Rule width={width} />
      <Box paddingLeft={2} width={width}>
        <Box flexGrow={1} flexShrink={1} width={0}>
          <Text>{`⌕ ${query || 'Search transcript…'}`}</Text>
        </Box>
        <Box flexShrink={0} paddingX={2}>
          <Text dimColor>{hints}</Text>
        </Box>
      </Box>
    </Box>
  );
}
