/** @jsxImportSource react */
import {Box, Text} from 'ink';
import type {ReactNode} from 'react';
import {useTheme} from '../theme';
import {useUiTheme} from './ui-theme';
import {safeText} from './text-line';
import {MouseRow} from './mouse-row';
import {useMouseTarget} from '../hooks/use-terminal-wheel';
export interface OptionItem {
  id: string;
  label: string;
  /** Rich label (bold fragments); `label` stays the plain text for tests and accessibility. */
  content?: ReactNode;
  /** Indented muted line under the label (question options, rule that will be saved). */
  description?: string;
  /** Left of the number, e.g. a checkbox of a multi-select option. */
  prefix?: string;
  /** Unnumbered row. */
  numbered?: boolean;
  /** Muted label while not highlighted (`Type something.`). */
  muted?: boolean;
}
export interface OptionListProps {
  items: readonly OptionItem[];
  cursor: number;
  /** Pointer input changes the highlight; Enter remains the explicit confirmation. */
  onCursorChange?: (index: number) => void;
  isActive?: boolean;
  /** Split lists can keep wheel navigation across all of their sections. */
  onWheel?: (direction: -1 | 1) => void;
  /** Columns left of the pointer (permission dialogs use 1, questions 0). */
  indent?: number;
  width?: number;
  /** Number of the first row (a list split by a rule continues the numbering). */
  start?: number;
}
/** Numbered, wrapping choice list of permission, question and plan dialogs: `❯ 1. Yes`. */
export function OptionList({
  items,
  cursor,
  indent = 0,
  width,
  start = 1,
  onCursorChange,
  isActive = true,
  onWheel,
}: OptionListProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const muted = color('foregroundMuted');
  const mouseRef = useMouseTarget(event => {
    if ('direction' in event && items.length) {
      if (onWheel) onWheel(event.direction);
      else onCursorChange?.(Math.max(0, Math.min(items.length - 1, cursor + event.direction)));
    }
  }, isActive && !!onCursorChange);
  let number = start - 1;
  return (
    <Box ref={mouseRef} flexDirection="column" width={width} minWidth={0}>
      {items.map((item, index) => {
        const active = index === cursor;
        const shown = item.numbered === false ? '' : `${++number}. `;
        return (
          <MouseRow
            key={item.id}
            flexDirection="column"
            minWidth={0}
            paddingLeft={indent}
            onHighlight={onCursorChange ? () => onCursorChange(index) : undefined}
            isActive={isActive}
          >
            <Box minWidth={0}>
              <Box flexShrink={0}>
                <Text color={active ? ui.color('selected') : undefined}>{active ? '❯ ' : '  '}</Text>
                <Text color={muted}>{shown}</Text>
              </Box>
              <Box flexShrink={1} minWidth={0}>
                <Text color={active ? ui.color('selected') : item.muted ? muted : undefined} wrap="wrap">
                  {item.prefix ?? ''}
                  {item.content ?? safeText(item.label)}
                </Text>
              </Box>
            </Box>
            {item.description ? (
              <Box paddingLeft={2 + shown.length} minWidth={0}>
                <Text color={muted} wrap="wrap">
                  {safeText(item.description)}
                </Text>
              </Box>
            ) : null}
          </MouseRow>
        );
      })}
    </Box>
  );
}
