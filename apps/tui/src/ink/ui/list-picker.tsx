/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useState} from 'react';
import {useKeymap, useTextInput} from '../hooks';
import {useTheme} from '../theme';
import {KeyHint} from './key-hint';
import {safeText, TextLine} from './text-line';
export interface PickerItem {
  id: string;
  label: string;
  description?: string;
  keywords?: string;
  disabled?: boolean;
}
export interface ListPickerProps<T extends PickerItem = PickerItem> {
  items: readonly T[];
  onSelect(item: T): void;
  onCancel?: () => void;
  visibleRows?: number;
  isActive?: boolean;
  placeholder?: string;
  initialQuery?: string;
}
export function ListPicker<T extends PickerItem>({
  items,
  onSelect,
  onCancel,
  visibleRows = 8,
  isActive = true,
  placeholder = 'Type to filter',
  initialQuery = '',
}: ListPickerProps<T>) {
  const {color} = useTheme();
  const [query, setQuery] = useState(() => safeText(initialQuery).replace(/\n/g, '').slice(0, 512));
  const [cursor, setCursor] = useState(0);
  const filtered = items.filter(item =>
    `${item.label} ${item.description ?? ''} ${item.keywords ?? ''}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const index = Math.max(0, Math.min(cursor, filtered.length - 1));
  const rows = Math.max(1, Math.floor(visibleRows));
  const top = Math.max(0, index - rows + 1);
  useKeymap(
    {
      previous: () => setCursor(Math.max(0, index - 1)),
      next: () => setCursor(Math.min(filtered.length - 1, index + 1)),
      submit: () => {
        const item = filtered[index];
        if (item && !item.disabled) onSelect(item);
      },
    },
    {isActive},
  );
  // Escape belongs to the overlay router when embedded; onCancel is for standalone pickers.
  useKeymap({close: onCancel}, {isActive: isActive && Boolean(onCancel)});
  useTextInput(
    (input, key) => {
      if (key.ctrl || key.meta || key.escape || key.return || key.upArrow || key.downArrow || key.tab) return;
      if (key.backspace || key.delete) {
        setQuery(value => Array.from(value).slice(0, -1).join(''));
        setCursor(0);
      } else if (input) {
        const clean = safeText(input).replace(/\n/g, '');
        if (clean) {
          setQuery(value => (value + clean).slice(0, 512));
          setCursor(0);
        }
      }
    },
    {isActive},
  );
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text color={color('foregroundMuted')}>{query ? `Filter: ${query}` : safeText(placeholder)}</Text>
      {!filtered.length ? <Text color={color('foregroundMuted')}>No matches</Text> : null}
      {filtered.slice(top, top + rows).map((item, offset) => (
        <Box key={item.id} flexDirection="column">
          <Text color={color(top + offset === index ? 'accent' : 'foreground')} dimColor={item.disabled}>
            {top + offset === index ? '›' : ' '} {top + offset + 1}. {safeText(item.label)}
            {item.disabled ? ' (unavailable)' : ''}
          </Text>
          {item.description ? (
            <Box paddingLeft={4}>
              <TextLine color={color('foregroundMuted')}>{item.description}</TextLine>
            </Box>
          ) : null}
        </Box>
      ))}
      <Text color={color('foregroundMuted')}>{filtered.length ? `${index + 1}/${filtered.length}` : '0/0'}</Text>
      <KeyHint keys="↑↓ Enter Esc" label="navigate · select · close" />
    </Box>
  );
}
