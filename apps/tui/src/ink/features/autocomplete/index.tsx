/** @jsxImportSource react */
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useState} from 'react';
import {Box} from 'ink';
import {SLASH_COMMANDS, normalizeSlashCommandName, type FutrynClient, type McpPromptView} from '@cosmew/sdk';
import {Pointer, TextLine, safeText} from '../../ui';
import {graphemes, textWidth, wrapWords} from '../../../input/text';
import {useUiTheme} from '../../ui/ui-theme';
import {EMOJI} from '../composer/logic';

export interface Completion {
  label: string;
  description: string;
  replacement: string;
  kind: 'command' | 'skill' | 'mcp-prompt' | 'file' | 'emoji';
  /** Fuzzy matches remain selectable but need an explicit Tab or arrow key. */
  autoSelect?: boolean;
}
export interface CompletionContext {
  start: number;
  query: string;
  prefix: '/' | '@' | '$' | ':';
  midPrompt?: boolean;
  previousSkills?: string[];
}
export function completionContext(value: string, cursor: number): CompletionContext | null {
  const before = value.slice(0, cursor);
  if (/^\s*[!#]/.test(before)) return null;
  const mention = /(?:^|\s)([@$])([^\s@$]*)$/.exec(before);
  if (mention)
    return {start: before.length - mention[2]!.length - 1, query: mention[2]!, prefix: mention[1] as '@' | '$'};
  const emoji = /(?:^|\s):([a-z0-9_+-]{2,})$/i.exec(before);
  if (emoji) return {start: before.length - emoji[1]!.length - 1, query: emoji[1]!, prefix: ':'};
  const slash = /^\s*((?:\/[\w-]+[ \t]+)*)\/([^\s/]*)$/.exec(before);
  if (!slash) {
    const inline = /\s\/([a-z0-9_:-]*)$/i.exec(before);
    if (!inline || !before.slice(0, inline.index).trim()) return null;
    return {start: before.lastIndexOf('/'), query: inline[1]!, prefix: '/', midPrompt: true};
  }
  const previousSkills = slash[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  return {
    start: before.lastIndexOf('/'),
    query: slash[2]!,
    prefix: '/',
    ...(previousSkills.length ? {previousSkills} : {}),
  };
}

export function getCompletions(
  context: CompletionContext | null,
  skills: ReturnType<FutrynClient['skills']>['skills'] = [],
  files: readonly string[] = [],
  mcpPrompts: readonly McpPromptView[] = [],
): Completion[] {
  if (!context) return [];
  const q = context.query.toLowerCase();
  if (context.prefix === ':')
    return Object.entries(EMOJI).flatMap(([name, emoji]) =>
      name.startsWith(q) ? [{label: `:${name}:`, description: emoji, replacement: emoji, kind: 'emoji'}] : [],
    );
  if (context.prefix === '@')
    return files
      .filter(file => file.toLowerCase().includes(q))
      .map(file => ({label: `@${file}`, description: 'Workspace file', replacement: `@${file} `, kind: 'file'}));
  const reserved = (label: string) =>
    SLASH_COMMANDS.some(command => command.command === label || command.aliases.includes(label));
  const skillItems: Completion[] = skills
    .filter(skill => skill.visibility !== 'off' && (context.prefix === '$' || !reserved(`/${skill.name}`)))
    .map(skill => ({
      label: `${context.prefix}${skill.name}`,
      description: skill.description,
      replacement: `${context.prefix}${skill.name} `,
      kind: 'skill',
    }));
  if (context.prefix === '$') return skillItems.filter(item => item.label.slice(1).toLowerCase().startsWith(q));
  const names = new Set(skillItems.map(item => item.label));
  if (
    context.previousSkills &&
    (context.previousSkills.length >= 6 || !context.previousSkills.every(name => names.has(name)))
  )
    return [];
  const query = normalizeSlashCommandName(q);
  const commands = context.previousSkills
    ? []
    : SLASH_COMMANDS.flatMap(command => {
        const names = [command.command, ...command.aliases];
        const exact = names.find(name => name.slice(1).toLowerCase() === q);
        if (command.autocomplete === false && (!exact || command.unavailable || command.handler === 'unavailable'))
          return [];
        return [
          {
            names,
            item: {
              label: command.command,
              description: `${command.unavailable ? 'Unavailable · ' : ''}${command.description}`,
              replacement: exact ?? command.command,
              kind: 'command' as const,
            },
          },
        ];
      });
  const mcpPromptItems = context.previousSkills
    ? []
    : mcpPrompts.map(prompt => {
        const label = `/${prompt.qualifiedName}`;
        const argHint = prompt.arguments.map(a => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
        const desc = [prompt.description || `MCP prompt (${prompt.server})`, argHint].filter(Boolean).join(' · ');
        return {
          names: [label, `/${prompt.name}`],
          item: {
            label,
            description: desc,
            replacement: prompt.arguments.length ? `${label} ` : label,
            kind: 'mcp-prompt' as const,
          },
        };
      });
  return [...commands, ...mcpPromptItems, ...skillItems.map(item => ({names: [item.label], item}))]
    .map(({names, item}) => ({
      item,
      rank: Math.min(
        ...names.map(name =>
          context.midPrompt && !normalizeSlashCommandName(name).startsWith(query) ? Infinity : slashRank(name, query),
        ),
      ),
    }))
    .filter(entry => entry.rank < Infinity)
    .sort((a, b) => a.rank - b.rank)
    .map(({item, rank}) => ({...item, autoSelect: !context.midPrompt && rank < 3}));
}

function slashRank(name: string, query: string): number {
  const normalized = normalizeSlashCommandName(name);
  if (normalized === query) return 0;
  if (normalized.startsWith(query)) return 1;
  const words = name.toLowerCase().slice(1).split(/[-_:]/);
  if (words.some(word => word.startsWith(query))) return 2;
  if (normalized.includes(query)) return 3;
  return query.length >= 3 && nearTypo(normalized, query) ? 4 : Infinity;
}

/** One insertion, deletion, replacement or adjacent transposition. */
function nearTypo(name: string, query: string): boolean {
  if (Math.abs(name.length - query.length) > 1) return false;
  let index = 0;
  while (index < name.length && name[index] === query[index]) index++;
  const a = name.slice(index);
  const b = query.slice(index);
  if (a.length !== b.length) return a.length > b.length ? a.slice(1) === b : b.slice(1) === a;
  return a.slice(1) === b.slice(1) || (a[0] === b[1] && a[1] === b[0] && a.slice(2) === b.slice(2));
}

export function useAutocomplete() {
  const [selected, setSelected] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return {
    selected,
    setSelected,
    dismissed,
    setDismissed,
    expanded,
    setExpanded,
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
/** Name column 42 cells from the pointer, accented selection, files as `+ path`. */
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
        const active = selected >= 0 && start + offset === index;
        const tint = active ? ui.color('selected') : ui.color('dim');
        if (item.kind === 'file')
          return (
            <Box key={`${item.kind}:${item.label}`} paddingLeft={2} minWidth={0}>
              <Pointer selected={active} />
              <TextLine width={Math.max(1, room - 4)} color={active ? tint : ui.color('path')} wrap="truncate-end">
                {`+ ${safeText(item.label.replace(/^@/, ''))}`}
              </TextLine>
            </Box>
          );
        return (
          <Box key={`${item.kind}:${item.label}`} paddingLeft={2} minWidth={0}>
            <Pointer selected={active} />
            <TextLine
              width={nameWidth}
              color={
                active ? tint : ui.color(item.kind === 'skill' || item.kind === 'mcp-prompt' ? 'thinking' : 'command')
              }
              wrap="truncate-end"
            >
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
