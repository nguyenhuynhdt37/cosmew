/** @jsxImportSource react */
import {Box, Text, useWindowSize} from 'ink';
import {useMemo} from 'react';
import {nextGrapheme} from '../../../input/text';
import {KEYMAP} from '../../hooks';
import {useTheme} from '../../theme';
import {KeyHint, Panel, TextLine, safeText} from '../../ui';
import {Autocomplete} from '../autocomplete';
import {History} from '../history';
import {visualRows} from './logic';
import {useComposer, type ComposerController, type ComposerOptions} from './use-composer';
export {useComposer, type ComposerController, type ComposerOptions, type SubmitAcceptance} from './use-composer';
export {visualRows, moveCursor, edit, insertText, verticalMove} from './logic';

export interface ComposerViewProps {
  controller: ComposerController;
  width?: number;
  maxRows?: number;
  placeholder?: string;
  isActive?: boolean;
}
/** Controlled view lets Phase 2 share interrupt ownership with InkApp without refs. */
export function ComposerView({
  controller,
  width,
  maxRows = 6,
  placeholder = 'Ask anything…',
  isActive = true,
}: ComposerViewProps) {
  const {columns} = useWindowSize();
  const {color} = useTheme();
  const outerWidth = Math.max(1, width ?? columns ?? 80);
  const innerWidth = Math.max(1, outerWidth - 6);
  const {draft, busy, search, items, selected} = controller;
  // Reserve a cell at the wrap edge for the caret.
  const rows = useMemo(() => visualRows(draft.value, innerWidth - 1), [draft.value, innerWidth]);
  const cursorRow = Math.max(
    0,
    rows.findLastIndex(row => row.start <= draft.cursor),
  );
  const first = Math.max(0, cursorRow - Math.max(1, maxRows) + 1);
  const anchor = draft.selectionAnchor ?? draft.cursor;
  const from = Math.min(anchor, draft.cursor),
    to = Math.max(anchor, draft.cursor);
  const hints = KEYMAP.filter(item => ['submit', 'newline', 'history'].includes(item.action));
  if (outerWidth < 6)
    return (
      <TextLine width={outerWidth} wrap="truncate-end">
        {draft.value || placeholder}
      </TextLine>
    );
  return (
    <Box flexDirection="column" width={outerWidth} minWidth={0}>
      {items.length ? <Autocomplete items={items} selected={selected} width={outerWidth} /> : null}
      {search ? (
        <History
          query={search.query}
          match={search.index < 0 ? undefined : controller.history[search.index]}
          width={outerWidth}
        />
      ) : null}
      <Panel width={outerWidth} focused={isActive} padding={1}>
        {draft.value ? (
          rows.slice(first, first + Math.max(1, maxRows)).map((row, index) => {
            const caret = isActive && cursorRow === first + index;
            const caretOffset = draft.cursor - row.start;
            const boundaries = new Set([
              0,
              row.text.length,
              Math.max(0, Math.min(row.text.length, from - row.start)),
              Math.max(0, Math.min(row.text.length, to - row.start)),
            ]);
            if (caret) {
              boundaries.add(caretOffset);
              boundaries.add(nextGrapheme(row.text, caretOffset));
            }
            const points = [...boundaries].sort((a, b) => a - b);
            return (
              <Box key={first + index} minWidth={0}>
                <Text color={color('accent')}>{first + index === 0 ? '› ' : '  '}</Text>
                <Text wrap="truncate-end">
                  {points.slice(0, -1).map((start, part) => {
                    const end = points[part + 1]!;
                    const selected = row.start + start >= from && row.start + start < to;
                    return (
                      <Text key={start} inverse={selected || (caret && start === caretOffset)}>
                        {safeText(row.text.slice(start, end))}
                      </Text>
                    );
                  })}
                  {caret && caretOffset === row.text.length ? <Text inverse> </Text> : null}
                </Text>
              </Box>
            );
          })
        ) : (
          <Text wrap="truncate-end">
            <Text color={color('accent')}>› </Text>
            <Text inverse={isActive}> </Text>
            <Text color={color('foregroundSubtle')}>
              {safeText(busy ? 'Type to steer the running turn…' : placeholder)}
            </Text>
          </Text>
        )}
      </Panel>
      <Box flexWrap="wrap" columnGap={2}>
        {hints.map(hint => (
          <KeyHint
            key={hint.action}
            keys={hint.keys}
            label={hint.action === 'submit' ? (busy ? 'steer' : 'send') : hint.label.toLowerCase()}
          />
        ))}
        {busy ? <KeyHint keys="Esc" label="interrupt" /> : <KeyHint keys="/ @ $" label="commands · files · skills" />}
      </Box>
      {controller.notice || controller.completionError ? (
        <TextLine width={outerWidth} color={color('foregroundMuted')}>
          {controller.notice || controller.completionError}
        </TextLine>
      ) : null}
    </Box>
  );
}
export interface ComposerProps extends Omit<ComposerOptions, 'inputWidth'> {
  width?: number;
  maxRows?: number;
  placeholder?: string;
}
export function Composer({width, maxRows, placeholder, ...options}: ComposerProps) {
  const {columns} = useWindowSize();
  const controller = useComposer({...options, inputWidth: Math.max(1, (width ?? columns ?? 80) - 7)});
  return (
    <ComposerView
      controller={controller}
      width={width}
      maxRows={maxRows}
      placeholder={placeholder}
      isActive={options.isActive}
    />
  );
}
