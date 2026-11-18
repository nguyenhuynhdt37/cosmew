/** @jsxImportSource react */
import {useState} from 'react';
import {Box} from 'ink';
import {SLASH_COMMANDS, type FutrynClient} from '@futryn/sdk';
import {TextLine} from '../../ui';
import {useTheme} from '../../theme';

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
  const rank = (command: (typeof SLASH_COMMANDS)[number]) =>
    command.command.toLowerCase() === `/${q}`
      ? 0
      : command.command.toLowerCase().startsWith(`/${q}`)
        ? 1
        : command.aliases.some(alias => alias.toLowerCase() === `/${q}`)
          ? 2
          : 3;
  const commands: Completion[] = SLASH_COMMANDS.filter(
    command =>
      command.autocomplete !== false &&
      (command.command.toLowerCase().includes(q) ||
        command.aliases.some(alias => alias.toLowerCase().startsWith(`/${q}`)) ||
        command.title.toLowerCase().includes(q)),
  )
    .sort((a, b) => rank(a) - rank(b))
    .map(command => ({
      label: command.command,
      description: `${command.unavailable ? 'Unavailable · ' : ''}${command.description}${command.shortcut ? ` [${command.shortcut}]` : ''}`,
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
export function Autocomplete({items, selected = 0, visibleRows = 5, width}: AutocompleteProps) {
  const {color} = useTheme();
  const limit = Math.max(1, visibleRows);
  const index = Math.max(0, Math.min(selected, items.length - 1));
  const start = Math.max(0, index - limit + 1);
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {items.slice(start, start + limit).map((item, offset) => (
        <TextLine
          key={`${item.kind}:${item.label}`}
          width={width}
          color={color(start + offset === index ? 'accent' : 'foregroundMuted')}
          wrap="truncate-end"
        >{`${start + offset === index ? '›' : ' '} ${item.label}  ${item.description}`}</TextLine>
      ))}
    </Box>
  );
}
