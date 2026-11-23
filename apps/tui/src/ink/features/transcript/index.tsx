/** @jsxImportSource react */
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {Box, Static, Text, type DOMElement} from 'ink';
import {isFileChangeTool, type ToolCall, type ToolResult} from '@cosmew/contracts';
import {parseMemoryCitations} from '@cosmew/sdk';
import {keyLabels, keymapStore, useKeymap} from '../../hooks';
import {useTheme} from '../../theme';
import {
  Markdown,
  CodeBlock,
  ResultLine,
  Spinner,
  TextLine,
  emphasizeDigits,
  formatElapsed,
  leadingSlashCommand,
  safeText,
  turnVerb,
  wrapRuns,
  stringCells,
  type WrapRun,
} from '../../ui';
import {WindowedRows} from '../../screen';
import {createPresentationCache} from './presentation-cache';
import {useUiTheme} from '../../ui/ui-theme';
import {TodoItems, todosFromInput} from '../plan';
import {ToolDiff} from '../diff';
import {changeReceipt} from '../diff/logic';
import {Notices} from '../notices';
import {ContextBlockView} from '../usage';
import {toolDisplay, transcriptParts, transcriptWindow, type TranscriptItem as Item} from './logic';
import {ActivityNavigation, ActivityRow} from './activity';
import {segmentTools} from './summary';
import {TRANSCRIPT_ITEM_GAP} from './viewport';
import {DETAILED_RECENT_LIMIT, visibleWindow} from './show-all';
/** The detailed-transcript viewer jumps between prompts (`{` / `}`): user items register their box here. */
export const SearchAnchors = createContext<Map<string, DOMElement> | null>(null);
export const PromptAnchors = createContext<Map<string, DOMElement> | null>(null);
export {rowWithin} from '../../screen';
export * from './logic';
export * from './summary';
export type TranscriptItem = Item;
export * from './use-transcript';
export function activityIds(item: Item): string[] {
  return transcriptParts(item).flatMap((part, index) =>
    part.kind === 'reasoning'
      ? [`${item.id}:reasoning:${index}`]
      : part.kind === 'tools'
        ? part.callIds.map(id => `${item.id}:tool:${id}`)
        : [],
  );
}
/** Bound live Markdown work by both lines and viewport width, including unbroken paragraphs. */
export function liveTail(text: string, rows: number, width = 80): string {
  const lineLimit = Math.max(1, Math.floor(rows));
  // Two UTF-16 units per cell accommodate astral characters without passing a huge
  // single paragraph to Markdown/Ink on every delta. The source item stays intact.
  const characterLimit = lineLimit * Math.max(1, Math.floor(width)) * 2;
  let lineStart = 0;
  let scan = text.length;
  for (let line = 0; line < lineLimit; line++) {
    const newline = scan > 0 ? text.lastIndexOf('\n', scan - 1) : -1;
    if (newline < 0) {
      lineStart = 0;
      break;
    }
    lineStart = newline + 1;
    scan = newline;
  }
  let start = Math.max(lineStart, text.length - characterLimit, 0);
  if (!start) return text;
  if (/[\uDC00-\uDFFF]/.test(text[start]!)) start++;
  let hiddenLines = 0;
  if (start === lineStart) {
    for (let at = text.indexOf('\n'); at >= 0 && at < start; at = text.indexOf('\n', at + 1)) hiddenLines++;
  }
  const label = start === lineStart ? `${hiddenLines} earlier lines` : 'earlier text';
  return `… ${label} (shown in full when the answer completes)\n${text.slice(start)}`;
}
/** `11:00 PM` from local time (12-hour, no locale data: ICU spacing differs between runtimes). */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}
/** Ctrl+O: the shell binds `toggleDetailed` and passes `detailed` to `Transcript`. */
export function useDetailedTranscript(initial = false) {
  const [detailed, setDetailed] = useState(initial);
  return {detailed, setDetailed, toggleDetailed: useCallback(() => setDetailed(value => !value), [])};
}
export function ToolDot({
  status,
  animate = true,
}: {
  status: ReturnType<typeof toolDisplay>['status'];
  animate?: boolean;
}) {
  const theme = useTheme();
  const ui = useUiTheme();
  const [pulse, setPulse] = useState(false);
  const running = status === 'running';
  useEffect(() => {
    if (!running || !animate || !theme.animate) return;
    const timer = setInterval(() => setPulse(value => !value), 500);
    return () => clearInterval(timer);
  }, [running, animate, theme.animate]);
  return (
    <Text
      color={
        status === 'ok'
          ? ui.color('toolSuccess')
          : theme.color(status === 'error' || status === 'denied' ? 'error' : 'foregroundMuted')
      }
    >
      {running && animate && theme.animate && pulse ? '  ' : '⏺ '}
    </Text>
  );
}
const MAX_USER_ROWS = 200;
/** Preserve the command name and inline code styling through line wrapping. */
function promptRuns(text: string): WrapRun[] {
  const slash = leadingSlashCommand(text);
  const runs: WrapRun[] = slash ? [{text: slash[1]!}, {text: slash[2]!, style: 'command'}] : [];
  return runs.concat(
    text
      .slice(slash?.[0].length ?? 0)
      .split(/(`[^`\n]+`)/)
      .filter(part => part !== '')
      .map(part => (/^`[^`\n]+`$/.test(part) ? {text: part.slice(1, -1), style: 'code' as const} : {text: part})),
  );
}
/** Calls the user started with `!command` keep their own entry and output, as in Claude Code's bash mode. */
const isUserShell = (callId: string) => callId.startsWith('shell-');
export interface UserMessageProps {
  text: string;
  width?: number;
  /** Dim text for a message that is still queued. */
  queued?: boolean;
}
/** `❯ text` on the user-message background, full row width, continuation rows indented 2. */
export function UserMessage({text, width = 80, queued = false}: UserMessageProps) {
  const theme = useTheme();
  const ui = useUiTheme();
  const bg = ui.color('userMessage');
  const foreground = theme.color(queued ? 'foregroundMuted' : 'foreground');
  const tint = {command: ui.color('command'), code: theme.color('markdownCode')};
  const lines = useMemo(() => wrapRuns(promptRuns(safeText(text)), Math.max(1, width - 2)), [text, width]);
  const shown = lines.slice(0, MAX_USER_ROWS);
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {shown.map((line, index) => {
        const used = line.reduce((total, run) => total + stringCells(run.text), 0);
        return (
          <Text key={index} backgroundColor={bg}>
            <Text color={ui.color('dim')}>{index === 0 ? '❯ ' : '  '}</Text>
            {line.map((run, at) => (
              <Text key={at} color={run.style ? tint[run.style] : foreground}>
                {run.text}
              </Text>
            ))}
            {' '.repeat(Math.max(0, width - 2 - used))}
          </Text>
        );
      })}
      {lines.length > shown.length ? (
        <Text color={ui.color('dim')}>{`… +${lines.length - shown.length} lines`}</Text>
      ) : null}
    </Box>
  );
}
function Emphasis({line, color}: {line: string; color?: string}) {
  const wrote = /^Wrote (\d+) (lines?) to (.+)$/.exec(line);
  if (wrote)
    return (
      <Text color={color}>
        Wrote <Text bold>{wrote[1]}</Text> {wrote[2]} to <Text bold>{wrote[3]}</Text>
      </Text>
    );
  const numbered = /^(Added|Removed)\b/.test(line) || /^[^:]+: (Added|Removed)\b/.test(line);
  return (
    <Text color={color}>
      {numbered
        ? emphasizeDigits(line).map((part, index) => (
            <Text key={index} bold={part.bold}>
              {part.text}
            </Text>
          ))
        : line}
    </Text>
  );
}
/** A merged summary line: `  Ran 1 shell command · 1 failed`, dim, numbers bold. */
function SummaryLine({text, width, focused, hint}: {text: string; width?: number; focused?: boolean; hint?: string}) {
  const ui = useUiTheme();
  return (
    <Box width={width} minWidth={0}>
      <Text color={ui.color('dim')} wrap="wrap">
        {focused ? '› ' : '  '}
        {emphasizeDigits(safeText(text)).map((part, index) => (
          <Text key={index} bold={part.bold}>
            {part.text}
          </Text>
        ))}
        {hint ? ` ${hint}` : ''}
      </Text>
    </Box>
  );
}
interface ToolEntryProps {
  call: ToolCall;
  result?: ToolResult;
  streaming: boolean;
  streamed?: string;
  expanded: boolean;
  width: number;
  animate: boolean;
  itemId: string;
  activityId: string;
  focusedId?: string;
  expandHint?: string;
  fullOutput?: boolean;
}
/** One tool, as `⏺ Name(argument)` with `  ⎿  ` result lines (Update/Write with their diff). */
const ToolEntry = memo(function ToolEntry({
  call,
  result,
  streaming,
  streamed,
  expanded,
  width,
  animate,
  itemId,
  activityId,
  focusedId,
  expandHint,
  fullOutput,
}: ToolEntryProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const navigation = useContext(ActivityNavigation);
  const display = useMemo(
    () => toolDisplay(call, result, streaming, expanded, streamed),
    [call, result, streaming, expanded, streamed],
  );
  const outputId = `${activityId}:output`;
  const {head, tail, missing} = useMemo(
    () =>
      expanded
        ? previewToolLines(display.lines, display.status === 'running')
        : {head: display.lines, tail: [], missing: 0},
    [display, expanded],
  );
  const failed = display.status === 'error' || display.status === 'denied';
  const shell = call.name === 'exec_command' || call.name === 'write_stdin';
  const fileChange = isFileChangeTool(call.name);
  const applied = fileChange && (result?.status === 'ok' || result?.code === 'PARTIAL_APPLY');
  const pending = fileChange && !result && streaming;
  const paren = display.title.indexOf('(');
  const name = paren < 0 ? display.title : display.title.slice(0, paren);
  const argument = paren < 0 ? '' : display.title.slice(paren);
  const plain = fileChange || display.title.startsWith('Answered');
  const title = (
    <Text wrap="wrap">
      {focusedId === activityId ? '› ' : ''}
      <ToolDot status={display.status} animate={animate} />
      <Text bold color={shell ? ui.color('bashMode') : color('syntaxFunction')}>
        {safeText(name)}
      </Text>
      {argument ? <Text color={shell ? ui.color('command') : ui.color('path')}>{safeText(argument)}</Text> : null}
      {expandHint ? <Text dimColor> {expandHint}</Text> : null}
    </Text>
  );
  const paintLines = (lines: string[]) =>
    lines.map((line, at) => (
      <Emphasis
        key={at}
        line={safeText(line)}
        color={
          failed && (display.status === 'denied' || !shell || line.startsWith('Error:'))
            ? color('error')
            : plain
              ? undefined
              : color('foregroundMuted')
        }
      />
    ));
  const command = call.name === 'exec_command' ? (call.input as {cmd?: unknown} | null)?.cmd : undefined;
  const diffLimit = 48;
  const longDiff =
    expanded &&
    fileChange &&
    applied &&
    changeReceipt(result).changes.some(change => change.diff.split('\n', diffLimit + 1).length > diffLimit);
  const outputLabel = (
    <Text dimColor>
      {focusedId === outputId ? '› ' : ''}
      {fullOutput
        ? '(click to hide full output)'
        : missing
          ? `… +${missing} lines${navigation ? ' (click for full output)' : ''}`
          : '(click for full diff)'}
    </Text>
  );
  const outputControl = navigation ? (
    <ActivityRow id={outputId} itemId={itemId} width={Math.max(1, width - 5)}>
      {outputLabel}
    </ActivityRow>
  ) : (
    outputLabel
  );
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {expandHint ? (
        <ActivityRow id={activityId} itemId={itemId} width={width}>
          {title}
        </ActivityRow>
      ) : (
        title
      )}
      {pending ? null : (
        <ResultLine width={width}>
          {expanded && typeof command === 'string' && command.includes('\n') ? (
            <CodeBlock code={command} language="bash" label={false} width={Math.max(1, width - 5)} />
          ) : null}
          {call.name === 'update_plan' && result?.status === 'ok' ? (
            <TodoItems items={todosFromInput(call.input)} width={Math.max(1, width - 5)} />
          ) : fullOutput ? (
            <>
              {outputControl}
              <WindowedOutput
                lines={display.lines}
                width={Math.max(1, width - 5)}
                color={color(failed ? 'error' : 'foregroundMuted')}
              />
            </>
          ) : (
            <>
              {paintLines(head)}
              {missing || longDiff ? outputControl : null}
              {paintLines(tail)}
            </>
          )}
          {applied ? (
            <ToolDiff
              result={result}
              expanded={fullOutput}
              maxLines={expanded ? diffLimit : undefined}
              width={Math.max(1, width - 5)}
            />
          ) : null}
          {result?.attachments?.map((attachment, at) => (
            <TextLine key={at} width={Math.max(1, width - 5)}>{`[${attachment.mime}] ${attachment.name}`}</TextLine>
          ))}
        </ResultLine>
      )}
    </Box>
  );
});
/** Expanded output keeps its full logical height and mounts only rows near the terminal viewport. */
function WindowedOutput({lines, width, color}: {lines: string[]; width: number; color?: string}) {
  const rows = useMemo(
    () =>
      lines.flatMap(line => {
        const safe = safeText(line);
        return stringCells(safe) <= width
          ? [safe || ' ']
          : wrapRuns([{text: safe}], width).map(row => row.map(run => run.text).join('') || ' ');
      }),
    [lines, width],
  );
  return (
    <WindowedRows count={rows.length}>
      {(first, end) => <Text color={color}>{rows.slice(first, end).join('\n')}</Text>}
    </WindowedRows>
  );
}
function previewToolLines(lines: string[], live: boolean) {
  const limit = 12;
  if (lines.length <= limit) return {head: lines, tail: [], missing: 0};
  const head = live ? 0 : limit / 2;
  return {head: lines.slice(0, head), tail: lines.slice(-(limit - head)), missing: lines.length - limit};
}
type Block =
  | {kind: 'hook'; index: number; name: string; text: string}
  | {kind: 'text'; index: number; text: string; at?: number}
  | {kind: 'reasoning'; index: number; text: string}
  | {kind: 'tools'; index: number; callIds: string[]};
interface ItemPresentation {
  detailedBlocks: Block[];
  normalBlocks: Block[];
  calls: ReadonlyMap<string, ToolCall>;
  results: ReadonlyMap<string, ToolResult>;
  files: string[];
  postHooks: number;
}
const recentPresentations = createPresentationCache<ItemPresentation>();
function itemPresentation(item: Item): ItemPresentation {
  return recentPresentations(item, () => {
    const parts = item.role === 'assistant' ? transcriptParts(item) : [];
    let textPrefix = '';
    let renderedTextLength = 0;
    let postHooks = 0;
    const blocks: Block[] = [];
    parts.forEach((part, index) => {
      if (part.kind === 'text') {
        textPrefix += part.text;
        const clean = parseMemoryCitations(textPrefix, true).content;
        const text = clean.slice(renderedTextLength);
        renderedTextLength = clean.length;
        if (text) blocks.push({kind: 'text', index, text, at: part.at});
      } else if (part.kind === 'reasoning') blocks.push({kind: 'reasoning', index, text: part.text});
      else if (part.kind === 'hook') {
        if (part.event.event === 'PostToolUse') postHooks++;
        blocks.push({kind: 'hook', index, name: part.event.name, text: part.event.summary});
      } else {
        const last = blocks.at(-1);
        if (last?.kind === 'tools') last.callIds.push(...part.callIds);
        else blocks.push({kind: 'tools', index, callIds: [...part.callIds]});
      }
    });
    const normalBlocks: Block[] = [];
    for (const block of blocks) {
      if (block.kind === 'hook') continue;
      const last = normalBlocks.at(-1);
      if (block.kind === 'tools' && last?.kind === 'tools')
        normalBlocks[normalBlocks.length - 1] = {...last, callIds: [...last.callIds, ...block.callIds]};
      else normalBlocks.push(block);
    }
    // Citations can straddle text deltas or parts, so extract file names from the joined prefix.
    return {
      detailedBlocks: blocks,
      normalBlocks,
      files: parseMemoryCitations(textPrefix, !!item.streaming).files,
      calls: new Map(item.toolCalls?.map(call => [call.id, call])),
      results: new Map(item.toolResults?.map(result => [result.callId, result])),
      postHooks,
    };
  });
}
export interface TranscriptItemProps {
  item: Item;
  width?: number;
  focusedId?: string;
  expandedIds?: ReadonlySet<string>;
  animate?: boolean;
  /** Overrides the streaming tail with the host's live-row budget. */
  liveRows?: number;
  showSpinner?: boolean;
  /** Ctrl+O: every tool as `⏺ Bash(cmd)` with its full result, reasoning open and a `<time> <model>` header per answer. */
  detailed?: boolean;
  showTurnDuration?: boolean;
  /** Model name for the detailed header when the item does not carry one. */
  searchMatch?: {id: string; start: number; end: number; text: string};
  model?: string;
  /** Clock formatter for `done 11:00 PM` and the detailed header; injectable for tests. */
  formatTime?: (ms: number) => string;
}
export const TranscriptItem = memo(function TranscriptItem({
  item,
  width = 80,
  focusedId,
  expandedIds = new Set(),
  animate = true,
  liveRows: liveRowBudget,
  showSpinner = true,
  detailed = false,
  showTurnDuration = true,
  model,
  formatTime = formatClock,
  searchMatch,
}: TranscriptItemProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const navigation = useContext(ActivityNavigation);
  const expansionHint = navigation?.expandHint;
  const anchors = useContext(PromptAnchors);
  const searchAnchors = useContext(SearchAnchors);
  const {rows} = useTerminalSize();
  const liveRows = liveRowBudget ?? Math.max(8, (rows || 24) - 12);
  const bodyWidth = Math.max(1, width - 2);
  const {detailedBlocks, normalBlocks, files, calls, results, postHooks} = itemPresentation(item);
  const label = item.model ?? model;
  const entries: {key: string; node: ReactNode; attached?: boolean}[] = [];
  if (item.role === 'user') {
    entries.push({key: 'user', node: <UserMessage text={item.content} width={width} />});
    // A finished slash command: its `⎿` result sits directly under the `❯ /command` line (spec 7).
    if (item.notices?.length)
      entries.push({
        key: 'notices',
        attached: true,
        node: <Notices notices={item.notices.map((text, at) => ({id: `${at}`, text}))} width={width} />,
      });
    if (item.context)
      entries.push({key: 'context', attached: true, node: <ContextBlockView block={item.context} width={width} />});
  } else if (item.role !== 'assistant')
    entries.push({key: 'other', node: <TextLine width={width}>{item.content}</TextLine>});
  else {
    for (const block of detailed ? detailedBlocks : normalBlocks) {
      if (block.kind === 'text') {
        const stamp = [block.at !== undefined ? formatTime(block.at) : '', label ?? ''].filter(Boolean).join(' ');
        if (detailed && stamp)
          entries.push({
            key: `stamp:${block.index}`,
            node: (
              <Box width={width} justifyContent="flex-end" paddingRight={1}>
                <Text color={ui.color('dim')}>{safeText(stamp)}</Text>
              </Box>
            ),
          });
        entries.push({
          key: `text:${block.index}`,
          attached: detailed && !!stamp,
          node: (
            <Box minWidth={0}>
              <Text color={color('markdownHeading')}>⏺ </Text>
              <Markdown
                text={item.streaming ? liveTail(block.text, liveRows, bodyWidth) : block.text}
                width={bodyWidth}
              />
            </Box>
          ),
        });
      } else if (block.kind === 'hook') {
        entries.push({
          key: `hook:${block.index}`,
          attached: true,
          node: (
            <ResultLine width={width}>
              <Text color={ui.color('dim')}>{safeText(`${block.name} says: ${block.text}`)}</Text>
            </ResultLine>
          ),
        });
      } else if (block.kind === 'reasoning') {
        const id = `${item.id}:reasoning:${block.index}`;
        const open = detailed || expandedIds.has(id);
        const title = (
          <Text italic color={ui.color('thinking')}>
            {focusedId === id ? '› ' : ''}✻ Thinking… {open ? '▾' : '▸'}
            {!detailed && expansionHint
              ? open
                ? ' (click to collapse)'
                : ` ${expansionHint}`
              : focusedId === id
                ? ' (Ctrl+O)'
                : ''}
          </Text>
        );
        entries.push({
          key: id,
          node: (
            <Box flexDirection="column" minWidth={0}>
              {navigation && !detailed ? (
                <ActivityRow id={id} itemId={item.id} width={width}>
                  {title}
                </ActivityRow>
              ) : (
                title
              )}
              {open ? (
                <Box paddingLeft={Math.max(0, Math.min(2, width - 1))} minWidth={0}>
                  <Markdown
                    text={item.streaming ? liveTail(block.text, liveRows, bodyWidth) : block.text}
                    width={bodyWidth}
                    tone="thinking"
                  />
                </Box>
              ) : null}
            </Box>
          ),
        });
      } else {
        const toolId = (callId: string) => `${item.id}:tool:${callId}`;
        const segments = segmentTools(block.callIds, {
          calls,
          results,
          live: !!item.streaming,
          isolated: callId => detailed || isUserShell(callId) || (!navigation && expandedIds.has(toolId(callId))),
        });
        const tool = (callId: string, expanded: boolean, standalone: boolean) => {
          const id = toolId(callId);
          return (
            <ToolEntry
              key={id}
              itemId={item.id}
              activityId={id}
              call={calls.get(callId)!}
              result={results.get(callId)}
              streaming={!!item.streaming}
              streamed={item.toolOutput?.[callId]}
              expanded={expanded}
              fullOutput={expanded && expandedIds.has(`${id}:output`)}
              expandHint={
                standalone && navigation && !detailed && !isUserShell(callId)
                  ? expanded
                    ? '(click to collapse)'
                    : expansionHint
                  : undefined
              }
              focusedId={focusedId === id || focusedId === `${id}:output` ? focusedId : undefined}
              width={width}
              animate={animate}
            />
          );
        };
        segments.forEach(segment => {
          if (segment.kind === 'summary') {
            const id = toolId(segment.callIds[0]!);
            const open = !!navigation && expandedIds.has(id);
            const title = (
              <SummaryLine
                text={segment.text}
                width={navigation ? undefined : width}
                focused={focusedId === id && !!navigation}
                hint={open ? '(click to collapse)' : expansionHint}
              />
            );
            entries.push({
              key: id,
              node: navigation ? (
                <Box flexDirection="column">
                  <ActivityRow id={id} itemId={item.id} width={width}>
                    {title}
                  </ActivityRow>
                  {open ? segment.callIds.map(callId => tool(callId, true, false)) : null}
                </Box>
              ) : (
                title
              ),
            });
          } else
            entries.push({
              key: toolId(segment.callId),
              node: tool(
                segment.callId,
                detailed || isUserShell(segment.callId) || expandedIds.has(toolId(segment.callId)),
                true,
              ),
            });
        });
      }
    }
    if (detailed && postHooks)
      entries.push({
        key: 'hook-count',
        attached: true,
        node: (
          <ResultLine width={width}>
            <Text color={ui.color('dim')}>{`${postHooks} PostToolUse hooks ran`}</Text>
          </ResultLine>
        ),
      });
    if (files.length)
      entries.push({
        key: 'memory',
        node: (
          <TextLine width={width} color={color('foregroundMuted')}>{`Ký ức đã dùng: ${files.join(', ')}`}</TextLine>
        ),
      });
    if (item.interrupted)
      entries.push({
        key: 'interrupted',
        attached: true,
        node: (
          <ResultLine width={width}>
            <Text color={ui.color('dim')}>Interrupted · What should Cosmew do instead?</Text>
          </ResultLine>
        ),
      });
    if (item.streaming && showSpinner)
      entries.push({
        key: 'spinner',
        node: (
          <Spinner
            seed={item.startedAt ?? item.id}
            startedAt={item.startedAt}
            tokens={item.usage?.outputTokens ?? undefined}
            animate={animate}
          />
        ),
      });
    if (item.errorText)
      entries.push({
        key: 'error',
        node: (
          <TextLine width={width} color={color('error')}>
            {item.errorText}
          </TextLine>
        ),
      });
    if (item.notices?.length)
      entries.push({
        key: 'notices',
        node: <Notices notices={item.notices.map((text, at) => ({id: `${at}`, text}))} width={width} />,
      });
    if (
      showTurnDuration &&
      !item.streaming &&
      !item.interrupted &&
      !item.errorText &&
      item.durationMs !== undefined &&
      item.finishedAt
    ) {
      const verb = turnVerb(item.startedAt ?? item.id).past;
      entries.push({
        key: 'done',
        node: (
          <Text color={ui.color('dim')} wrap="wrap">
            {`✻ ${verb} for ${formatElapsed(item.durationMs)} · done ${formatTime(item.finishedAt)}`}
          </Text>
        ),
      });
    }
  }
  return (
    <Box
      width={width}
      minWidth={0}
      flexDirection="column"
      marginBottom={TRANSCRIPT_ITEM_GAP}
      ref={
        anchors || searchAnchors
          ? (el: DOMElement | null) => {
              if (item.role === 'user') {
                if (el) anchors?.set(item.id, el);
                else anchors?.delete(item.id);
              }
              if (el) searchAnchors?.set(item.id, el);
              else searchAnchors?.delete(item.id);
            }
          : undefined
      }
    >
      {searchMatch?.id === item.id ? (
        <Text>
          {searchMatch.text.slice(0, searchMatch.start)}
          <Text inverse color={ui.color('accent')}>
            {searchMatch.text.slice(searchMatch.start, searchMatch.end)}
          </Text>
          {searchMatch.text.slice(searchMatch.end)}
        </Text>
      ) : (
        entries.map((entry, index) => (
          <Box
            key={entry.key}
            width={width}
            minWidth={0}
            flexDirection="column"
            marginTop={index && !entry.attached ? 1 : 0}
          >
            {entry.node}
          </Box>
        ))
      )}
    </Box>
  );
});
export interface TranscriptProps {
  items: readonly Item[];
  width?: number;
  isActive?: boolean;
  liveItems?: number;
  /** Change on session/reset; Static is append-only. */
  historyKey?: string;
  focusedId?: string;
  onFocusChange?: (id: string) => void;
  expandedByItem?: ReadonlyMap<string, ReadonlySet<string>>;
  animate?: boolean;
  /** Explicit bounded history inspection: 0 = newest page, disables Static. */
  historyOffset?: number;
  /**
   * Render every passed item in the live tree. IntegratedShell owns the single Static
   * transcript and passes only its live items here, so this path must not archive them.
   */
  bounded?: boolean;
  liveRows?: number;
  showSpinner?: boolean;
  /** Ctrl+O detailed transcript (see `useDetailedTranscript`). */
  detailed?: boolean;
  showTurnDuration?: boolean;
  showAll?: boolean;
  /** Virtual history owns its window and disables the legacy show-all window (B4/B7). */
  virtualScroll?: boolean;
  searchMatch?: {id: string; start: number; end: number; text: string};
  model?: string;
  formatTime?: (ms: number) => string;
}
export const Transcript = memo(function Transcript({
  items,
  width: requestedWidth,
  isActive = false,
  liveItems = 8,
  historyKey = 'transcript',
  focusedId,
  onFocusChange,
  expandedByItem,
  animate = true,
  historyOffset,
  bounded = false,
  showSpinner = true,
  liveRows,
  detailed = false,
  showTurnDuration = true,
  showAll = false,
  virtualScroll = false,
  searchMatch,
  model,
  formatTime,
}: TranscriptProps) {
  const terminal = useTerminalSize();
  const width = Math.max(1, requestedWidth ?? terminal.columns);
  const [localFocus, setFocus] = useState<string>();
  const [expandedIds, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const window = useMemo(() => transcriptWindow(items, liveItems), [items, liveItems]);
  const count = Math.max(1, liveItems);
  const end = Math.max(0, items.length - Math.max(0, historyOffset ?? 0));
  const live = historyOffset === undefined ? window.live : items.slice(Math.max(0, end - count), end);
  const recent = useMemo(() => visibleWindow(items, showAll || virtualScroll), [items, showAll, virtualScroll]);
  const shown = detailed ? recent.items : bounded && historyOffset === undefined ? items : live;
  const useStatic = !detailed && !bounded && historyOffset === undefined;
  const previousCount = detailed && !virtualScroll ? Math.max(0, items.length - DETAILED_RECENT_LIMIT) : 0;
  const keymap = useSyncExternalStore(
    listener => keymapStore.subscribe(listener),
    () => keymapStore.get(),
  );
  const showAllKey = keyLabels(keymap, 'Transcript', 'transcript:toggleShowAll')[0] ?? 'unbound';
  const hintKey = showAllKey === 'ctrl+e' ? 'Ctrl+E' : showAllKey;
  const ids = isActive ? live.flatMap(activityIds) : [];
  const selected = focusedId ?? (localFocus && ids.includes(localFocus) ? localFocus : ids.at(-1));
  const focus = (delta: number) => {
    if (!ids.length) return;
    const id = ids[(Math.max(0, ids.indexOf(selected ?? '')) + delta + ids.length) % ids.length]!;
    setFocus(id);
    onFocusChange?.(id);
  };
  useKeymap(
    {
      previous: () => focus(-1),
      next: () => focus(1),
      expand: () => {
        if (selected)
          setExpanded(previous => {
            const next = new Set(previous);
            if (next.has(selected)) next.delete(selected);
            else next.add(selected);
            return next;
          });
      },
    },
    {isActive},
  );
  return (
    <Box width={width} minWidth={0} flexDirection="column">
      {previousCount > 0 ? (
        <Text dimColor wrap="truncate-end">
          {hintKey} to {showAll ? 'hide' : 'show'} <Text bold>{previousCount}</Text> previous messages
        </Text>
      ) : null}
      {useStatic ? (
        <Static key={historyKey} items={window.settled}>
          {item => (
            <TranscriptItem
              key={item.id}
              item={item}
              width={width}
              animate={false}
              model={model}
              formatTime={formatTime}
              showTurnDuration={showTurnDuration}
            />
          )}
        </Static>
      ) : historyOffset !== undefined ? (
        <Text dimColor>
          History · {live.length} of {items.length} messages
        </Text>
      ) : null}
      {shown.map(item => (
        <TranscriptItem
          key={item.id}
          item={item}
          width={width}
          focusedId={selected?.startsWith(`${item.id}:`) ? selected : undefined}
          expandedIds={expandedByItem ? expandedByItem.get(item.id) : expandedIds}
          liveRows={liveRows}
          showSpinner={showSpinner}
          animate={animate}
          detailed={detailed}
          showTurnDuration={showTurnDuration}
          searchMatch={searchMatch?.id === item.id ? searchMatch : undefined}
          model={model}
          formatTime={formatTime}
        />
      ))}
    </Box>
  );
});
