/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useEffect, useRef, useState} from 'react';
import {isPrintable, useKeybindings, type Keystroke} from '../hooks';
import {useTheme} from '../theme';
import {useUiTheme, type UiThemeToken} from './ui-theme';
import {Pointer} from './pointer';
import {SearchBox} from './search-box';
import {useDialogRows} from './dialog-layout';
import {safeText} from './text-line';
import {MouseRow} from './mouse-row';
import {useMouseTarget} from '../hooks/use-terminal-wheel';
export interface PickerItem {
  id: string;
  label: string;
  labelTone?: UiThemeToken;
  description?: string;
  descriptionTone?: UiThemeToken;
  keywords?: string;
  disabled?: boolean;
  current?: boolean;
}
export interface ListPickerProps<T extends PickerItem = PickerItem> {
  items: readonly T[];
  onSelect(item: T): void;
  onCancel?: () => void;
  visibleRows?: number;
  isActive?: boolean;
  placeholder?: string;
  filterable?: boolean;
  onTextKey?: (input: string) => boolean;
  /** Draw the bordered search box even before typing (default: lists longer than eight rows). */
  showSearch?: boolean;
  initialQuery?: string;
  cursor?: number;
  initialCursor?: number;
  onCursorChange?: (index: number) => void;
  onHighlight?: (item: T) => void;
  numbered?: boolean;
  hint?: string | false;
  /** Group heading drawn under the search box (`demo2` in `/resume`). */
  heading?: string;
  /** Text shown instead of `No matches` when there are no items at all. */
  empty?: string;
  /** Settings: `/` starts a search; Space changes the highlighted value outside search. */
  settingsKeys?: boolean;
}
export function ListPicker<T extends PickerItem>({
  items,
  onSelect,
  onCancel,
  visibleRows = 8,
  isActive = true,
  placeholder = 'Search…',
  filterable = true,
  onTextKey,
  showSearch,
  initialQuery = '',
  cursor: controlledCursor,
  initialCursor = 0,
  onCursorChange,
  onHighlight,
  numbered = false,
  hint,
  heading,
  empty,
  settingsKeys = false,
}: ListPickerProps<T>) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const dialogRows = useDialogRows();
  const compact = !!dialogRows && dialogRows < 18;
  const [query, setQuery] = useState(() => safeText(initialQuery).replace(/\n/g, '').slice(0, 512));
  const [localCursor, setLocalCursor] = useState(initialCursor);
  const [searching, setSearching] = useState(false);
  const cursor = controlledCursor ?? localCursor;
  const setCursor = (value: number) => {
    setLocalCursor(value);
    onCursorChange?.(value);
  };
  const filtered = items.filter(item =>
    `${item.label} ${item.description ?? ''} ${item.keywords ?? ''}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const index = Math.max(0, Math.min(cursor, filtered.length - 1));
  const highlighted = filtered[index];
  const lastHighlight = useRef<string | undefined>(undefined);
  const highlightCallback = useRef(onHighlight);
  highlightCallback.current = onHighlight;
  useEffect(() => {
    if (highlighted && highlighted.id !== lastHighlight.current) {
      lastHighlight.current = highlighted.id;
      highlightCallback.current?.(highlighted);
    } else if (!highlighted) lastHighlight.current = undefined;
  }, [highlighted?.id]);
  const rows = Math.max(1, Math.min(Math.floor(visibleRows), compact ? Math.max(1, dialogRows - 5) : Infinity));
  const top = Math.max(0, index - rows + 1);
  const move = (to: number) => setCursor(Math.max(0, Math.min(filtered.length - 1, to)));
  const mouseRef = useMouseTarget(event => {
    if ('direction' in event) move(index + event.direction);
  }, isActive);
  // J/K navigate only when no text field is receiving letters; Ctrl+N/P and the arrows always do.
  const letter = (stroke: Keystroke) => filterable && isPrintable(stroke);
  useKeybindings(
    {
      Settings: {
        'settings:search': () => {
          setSearching(true);
        },
        'settings:toggle': stroke => {
          if (stroke.key === 'space' && searching) return false;
          if (highlighted && !highlighted.disabled) onSelect(highlighted);
        },
        'settings:close': () => {
          if (!searching && !query) return false;
          setSearching(false);
          setQuery('');
          setCursor(0);
        },
      },
    },
    {isActive: isActive && settingsKeys},
  );
  // Escape belongs to the overlay router when embedded; onCancel is for standalone pickers.
  useKeybindings(
    {
      Select: {
        'select:previous': stroke => (letter(stroke) ? false : move(index - 1)),
        'select:next': stroke => (letter(stroke) ? false : move(index + 1)),
        'select:pageUp': () => move(index - rows),
        'select:pageDown': () => move(index + rows),
        'select:first': () => move(0),
        'select:last': () => move(filtered.length - 1),
        'select:accept': () => {
          const item = filtered[index];
          if (item && !item.disabled) onSelect(item);
        },
        ...(onCancel ? {'select:cancel': () => onCancel()} : {}),
      },
    },
    {isActive},
  );
  useKeybindings(
    {},
    {
      onKey: (input, key) => {
        if (
          !filterable ||
          key.eventType === 'release' ||
          key.ctrl ||
          key.meta ||
          key.escape ||
          key.return ||
          key.upArrow ||
          key.downArrow ||
          key.leftArrow ||
          key.rightArrow ||
          key.tab
        )
          return;
        if (onTextKey?.(input)) return true;
        if (key.backspace || key.delete) {
          setQuery(value => Array.from(value).slice(0, -1).join(''));
          setCursor(0);
          return true;
        } else if (input) {
          const clean = safeText(input).replace(/\n/g, '');
          if (clean) {
            if (settingsKeys) setSearching(true);
            setQuery(value => (value + clean).slice(0, 512));
            setCursor(0);
            return true;
          }
        }
      },
      isActive,
    },
  );
  const muted = color('foregroundMuted');
  const markerSlot = items.some(item => item.current);
  const visible = filtered.slice(top, top + rows);
  const labelWidth = Math.max(0, ...visible.map(item => Array.from(safeText(item.label)).length));
  const below = Math.max(0, filtered.length - (top + rows));
  return (
    <Box ref={mouseRef} flexDirection="column" minWidth={0}>
      {filterable && (query || searching || (!compact && (showSearch ?? items.length > 8))) ? (
        <SearchBox value={query} placeholder={placeholder} />
      ) : null}
      {heading ? <Text bold>{`  ${safeText(heading)}`}</Text> : null}
      {!filtered.length ? (
        <Text color={muted}>{`  ${items.length ? 'No matches' : (empty ?? 'No matches')}`}</Text>
      ) : null}
      {top > 0 ? <Text color={muted}>{`    ↑ ${top} more`}</Text> : null}
      {visible.map((item, offset) => {
        const active = top + offset === index;
        const label = safeText(item.label);
        return (
          <MouseRow key={item.id} minWidth={0} onHighlight={() => move(top + offset)} isActive={isActive}>
            <Text wrap="truncate-end">
              <Pointer selected={active} />
              {markerSlot ? item.current ? <Text color={color('success')}>{'✔ '}</Text> : '  ' : null}
              {numbered ? <Text color={muted}>{`${top + offset + 1}. `}</Text> : null}
              <Text
                color={active ? ui.color('selected') : item.labelTone ? ui.color(item.labelTone) : undefined}
                dimColor={item.disabled}
              >
                {label}
                {item.disabled ? ' (unavailable)' : ''}
              </Text>
              {item.description && !compact ? (
                <>
                  {' '.repeat(Math.max(2, labelWidth - Array.from(label).length + 2))}
                  <Text color={ui.color(item.descriptionTone ?? 'dim')}>{safeText(item.description)}</Text>
                </>
              ) : null}
            </Text>
          </MouseRow>
        );
      })}
      {below > 0 ? <Text color={muted}>{`    ↓ ${below} more`}</Text> : null}
      {hint !== false ? (
        <>
          <Text> </Text>
          <Text color={muted}>{hint ?? '↑/↓ to navigate · Enter to select · Esc to close'}</Text>
        </>
      ) : null}
    </Box>
  );
}
