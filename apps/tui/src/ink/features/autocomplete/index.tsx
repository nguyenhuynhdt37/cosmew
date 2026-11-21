/** @jsxImportSource react */
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useState} from 'react';
import {Box} from 'ink';
import {SLASH_COMMANDS, normalizeSlashCommandName, type FutrynClient} from '@cosmew/sdk';
import {Pointer, TextLine, safeText} from '../../ui';
import {graphemes, textWidth, wrapWords} from '../../../input/text';
import {useUiTheme} from '../../ui/ui-theme';

export interface Completion {
  label: string;
  description: string;
  replacement: string;
  kind: 'command' | 'skill' | 'file';
}
export interface CompletionContext {
  start: number;
  query: string;
  prefix: '/' | '@' | '$';
}
export function completionContext(value: string, cursor: number): CompletionContext | null {
  const before = value.slice(0, cursor);
  const mention = /(?:^|\s)([@$])([^\s@$]*)$/.exec(before);
  if (mention)
    return {start: before.length - mention[2]!.length - 1, query: mention[2]!, prefix: mention[1] as '@' | '$'};
  const slash = /^\s*\/([^\s]*)$/.exec(before);
  return slash ? {start: before.indexOf('/'), query: slash[1]!, prefix: '/'} : null;
}

export function getCompletions(
  context: CompletionContext | null,
  skills: ReturnType<FutrynClient['skills']>['skills'] = [],
  files: readonly string[] = [],
): Completion[] {
  if (!context) return [];
  const q = context.query.toLowerCase();
  if (context.prefix === '@')
    return files
      .filter(file => file.toLowerCase().includes(q))
      .map(file => ({label: `@${file}`, description: 'Workspace file', replacement: `@${file} `, kind: 'file'}));
  const skillItems: Completion[] = skills
    .filter(skill => skill.name.toLowerCase().startsWith(q))
    .map(skill => ({
      label: `${context.prefix}${skill.name}`,
      description: skill.description,
      replacement: `${context.prefix}${skill.name} `,
      kind: 'skill',
    }));
  if (context.prefix === '$') return skillItems;
  const normalizedQuery = normalizeSlashCommandName(q);
  const rank = (command: (typeof SLASH_COMMANDS)[number]) =>
    normalizeSlashCommandName(command.command) === normalizedQuery
      ? 0
      : normalizeSlashCommandName(command.command).startsWith(normalizedQuery)
        ? 1
        : command.aliases.some(alias => normalizeSlashCommandName(alias) === normalizedQuery)
          ? 2
          : 3;
  const commands: Completion[] = SLASH_COMMANDS.filter(
    command =>
      command.autocomplete !== false &&
      (normalizeSlashCommandName(command.command).includes(normalizedQuery) ||
        command.aliases.some(alias => normalizeSlashCommandName(alias).includes(normalizedQuery)) ||
        command.title.toLowerCase().includes(q)),
  )
    .sort((a, b) => rank(a) - rank(b))
    .map(command => ({
      label: command.command,
      description: `${command.unavailable ? 'Unavailable · ' : ''}${command.description}`,
      replacement: command.command,
      kind: 'command',
    }));
  return [
    ...commands,
    ...skillItems.filter(
      skill =>
        !SLASH_COMMANDS.some(command => command.command === skill.label || command.aliases.includes(skill.label)),
    ),
  ];
}
export function useAutocomplete() {
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  return {
    selected,
    setSelected,
    dismissed,
    setDismissed,
    reset: () => {
      setSelected(0);
      setDismissed(false);
    },
  };
}
export interface AutocompleteProps {
  items: readonly Completion[];
  selected?: number;
  visibleRows?: number;
  width?: number;
}
/** Cell-aware two-line descriptions, with explicit truncation instead of hidden overflow. */
export function descriptionLines(text: string, width: number): string[] {
  const lines = wrapWords(safeText(text), width);
  if (lines.length <= 2) return lines;
  let last = lines[1]!;
  while (last && textWidth(last + '…') > Math.max(1, width))
    last = last.includes(' ')
      ? last.slice(0, last.lastIndexOf(' '))
      : [...graphemes(last)]
          .slice(0, -1)
          .map(x => x.segment)
          .join('');
  return [lines[0]!, last.trimEnd() + '…'];
}
/** Rows one item takes: files are one line, commands and skills wrap their description to at most two. */
export function itemRows(item: Completion, descriptionWidth: number): number {
  return item.kind === 'file' ? 1 : Math.max(1, descriptionLines(item.description, descriptionWidth).length);
}
/** First item of the window that keeps `selected` visible inside a budget of terminal rows (reference: 5). */
export function menuWindow(
  items: readonly Completion[],
  selected: number,
  descriptionWidth: number,
  rowBudget = 5,
): {start: number; end: number} {
  if (!items.length) return {start: 0, end: 0};
  const index = Math.max(0, Math.min(selected, items.length - 1));
  let start = 0;
  for (;;) {
    let rows = 0,
      end = start;
    while (end < items.length && (end === start || rows + itemRows(items[end]!, descriptionWidth) <= rowBudget)) {
      rows += itemRows(items[end]!, descriptionWidth);
      end++;
    }
    if (index < end || start >= index) return {start, end: Math.max(end, start + 1)};
    start++;
  }
}
/** Spec 2: name column 42 cells from the pointer, accent on the selected row, files as `+ path`. */
export function Autocomplete({items, selected = 0, visibleRows = 5, width}: AutocompleteProps) {
  const ui = useUiTheme();
  const {columns} = useTerminalSize();
  const room = Math.max(1, width ?? columns ?? 80);
  const nameWidth = Math.min(40, Math.max(1, Math.floor((room - 4) * 0.45)));
  const descriptionWidth = Math.max(1, room - 4 - nameWidth);
  const index = Math.max(0, Math.min(selected, items.length - 1));
  const {start, end} = menuWindow(items, index, descriptionWidth, Math.max(1, visibleRows));
  return (
    <Box flexDirection="column" width={room} minWidth={0}>
      {items.slice(start, end).map((item, offset) => {
        const active = start + offset === index;
        const tint = active ? ui.color('selected') : ui.color('dim');
        if (item.kind === 'file')
          return (
            <Box key={`${item.kind}:${item.label}`} paddingLeft={2} minWidth={0}>
              <Pointer selected={active} />
              <TextLine width={Math.max(1, room - 4)} color={tint} wrap="truncate-end">
                {`+ ${safeText(item.label.replace(/^@/, ''))}`}
              </TextLine>
            </Box>
          );
        return (
          <Box key={`${item.kind}:${item.label}`} paddingLeft={2} minWidth={0}>
            <Pointer selected={active} />
            <TextLine width={nameWidth} color={tint} wrap="truncate-end">
              {safeText(item.label)}
            </TextLine>
            <Box flexDirection="column" width={descriptionWidth} minWidth={0}>
              {descriptionLines(item.description, descriptionWidth).map((line, n) => (
                <TextLine key={n} width={descriptionWidth} color={tint} wrap="truncate-end">
                  {line}
                </TextLine>
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
