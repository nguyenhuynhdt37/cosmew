/** @jsxImportSource react */
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import {Box, Static, Text, type DOMElement} from 'ink';
import {isFileChangeTool, type ToolCall, type ToolResult} from '@cosmew/contracts';
import {parseMemoryCitations} from '@cosmew/sdk';
import {useKeymap} from '../../hooks';
import {useTheme} from '../../theme';
import {
  Markdown,
  ResultLine,
  Spinner,
  TextLine,
  emphasizeDigits,
  formatElapsed,
  safeText,
  turnVerb,
  wrapRuns,
  stringCells,
  type WrapRun,
} from '../../ui';
import {useUiTheme} from '../../ui/ui-theme';
import {TodoItems, todosFromInput} from '../plan';
import {ToolDiff} from '../diff';
import {Notices} from '../notices';
import {ContextBlockView} from '../usage';
import {toolDisplay, transcriptParts, transcriptWindow, type TranscriptItem as Item} from './logic';
import {segmentTools} from './summary';
/** The detailed-transcript viewer jumps between prompts (`{` / `}`): user items register their box here. */
export const PromptAnchors = createContext<Map<string, DOMElement> | null>(null);
/** Row of `el` inside `root`, summed from Yoga's computed tops. */
export function rowWithin(el: DOMElement, root: DOMElement): number {
  let top = 0;
  for (let node: DOMElement | undefined = el; node && node !== root; node = node.parentNode as DOMElement | undefined)
    top += node.yogaNode?.getComputedTop() ?? 0;
  return top;
}
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
/** Last `rows` lines of a streaming answer, with a marker for the hidden head. */
export function liveTail(text: string, rows: number): string {
  const lines = text.split('\n');
  if (lines.length <= rows) return text;
  return `… ${lines.length - rows} earlier lines (shown in full when the answer completes)\n${lines.slice(-rows).join('\n')}`;
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
/** `code` spans of a user prompt render in the path colour without their backticks (reference L01). */
function promptRuns(text: string): WrapRun[] {
  return text
    .split(/(`[^`\n]+`)/)
    .filter(part => part !== '')
    .map(part => (/^`[^`\n]+`$/.test(part) ? {text: part.slice(1, -1), code: true} : {text: part}));
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
              <Text key={at} color={run.code ? ui.color('path') : queued ? ui.color('dim') : theme.color('foreground')}>
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
function SummaryLine({text, width}: {text: string; width: number}) {
  const ui = useUiTheme();
  return (
    <Box width={width} minWidth={0}>
      <Text color={ui.color('dim')} wrap="wrap">
        {'  '}
        {emphasizeDigits(safeText(text)).map((part, index) => (
          <Text key={index} bold={part.bold}>
            {part.text}
          </Text>
        ))}
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
}
/** One tool, as `⏺ Name(argument)` with `  ⎿  ` result lines (Update/Write with their diff). */
function ToolEntry({call, result, streaming, streamed, expanded, width, animate}: ToolEntryProps) {
  const {color} = useTheme();
  const display = toolDisplay(call, result, streaming, expanded, streamed);
  const failed = display.status === 'error' || display.status === 'denied';
  const fileChange = isFileChangeTool(call.name);
  const applied = fileChange && (result?.status === 'ok' || result?.code === 'PARTIAL_APPLY');
  const pending = fileChange && !result && streaming;
  const paren = display.title.indexOf('(');
  const name = paren < 0 ? display.title : display.title.slice(0, paren);
  const argument = paren < 0 ? '' : display.title.slice(paren);
  const plain = fileChange || display.title.startsWith('Answered');
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      <Text wrap="wrap">
        <ToolDot status={display.status} animate={animate} />
        <Text bold>{safeText(name)}</Text>
        {safeText(argument)}
      </Text>
      {pending ? null : (
        <ResultLine width={width}>
          {call.name === 'update_plan' && result?.status === 'ok' ? (
            <TodoItems items={todosFromInput(call.input)} width={Math.max(1, width - 5)} />
          ) : (
            display.lines.map((line, at) => (
              <Emphasis
                key={at}
                line={safeText(line)}
                color={
                  failed &&
                  (display.status === 'denied' ||
                    !['exec_command', 'write_stdin'].includes(call.name) ||
                    line.startsWith('Error:'))
                    ? color('error')
                    : plain
                      ? undefined
                      : color('foregroundMuted')
                }
              />
            ))
          )}
          {applied ? <ToolDiff result={result} expanded={expanded} width={Math.max(1, width - 5)} /> : null}
          {result?.attachments?.map((attachment, at) => (
            <TextLine key={at} width={Math.max(1, width - 5)}>{`[${attachment.mime}] ${attachment.name}`}</TextLine>
          ))}
        </ResultLine>
      )}
    </Box>
  );
}
type Block =
  | {kind: 'hook'; index: number; name: string; text: string}
  | {kind: 'text'; index: number; text: string; at?: number}
  | {kind: 'reasoning'; index: number; text: string}
  | {kind: 'tools'; index: number; callIds: string[]};
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
  /** Model name for the detailed header when the item does not carry one. */
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
  model,
  formatTime = formatClock,
}: TranscriptItemProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const anchors = useContext(PromptAnchors);
  const {rows} = useTerminalSize();
  const liveRows = liveRowBudget ?? Math.max(8, (rows || 24) - 12);
  const bodyWidth = Math.max(1, width - 2);
  const parts = transcriptParts(item);
  // Parse the joined assistant text once so a citation split between deltas is still hidden.
  const citations =
    item.role === 'assistant'
      ? parseMemoryCitations(
          parts
            .filter(part => part.kind === 'text')
            .map(part => part.text)
            .join(''),
          !!item.streaming,
        )
      : {content: item.content, files: []};
  const calls = new Map(item.toolCalls?.map(call => [call.id, call]));
  const results = new Map(item.toolResults?.map(result => [result.callId, result]));
  const label = model ?? item.model;
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
    let textPrefix = '';
    let renderedTextLength = 0;
    const blocks: Block[] = [];
    parts.forEach((part, index) => {
      if (part.kind === 'text') {
        textPrefix += part.text;
        const cleanPrefix = parseMemoryCitations(textPrefix, true).content;
        const full = cleanPrefix.slice(renderedTextLength);
        renderedTextLength = cleanPrefix.length;
        // A live item re-renders every frame: keep it to a viewport-sized tail so cost and latency stay bounded
        // while a long answer streams; the finished item is committed in full.
        const text = item.streaming ? liveTail(full, liveRows) : full;
        if (text) blocks.push({kind: 'text', index, text, at: part.at});
      } else if (part.kind === 'reasoning') blocks.push({kind: 'reasoning', index, text: part.text});
      else if (part.kind === 'hook') {
        if (detailed) blocks.push({kind: 'hook', index, name: part.event.name, text: part.event.summary});
      } else {
        const last = blocks.at(-1);
        if (last?.kind === 'tools') last.callIds.push(...part.callIds);
        else blocks.push({kind: 'tools', index, callIds: [...part.callIds]});
      }
    });
    for (const block of blocks) {
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
              <Text color={color('foreground')}>⏺ </Text>
              <Markdown text={block.text} width={bodyWidth} />
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
        entries.push({
          key: id,
          node: (
            <Box flexDirection="column" minWidth={0}>
              <Text dimColor italic color={color('foregroundMuted')}>
                {focusedId === id ? '› ' : ''}✻ Thinking… {open ? '▾' : '▸'}
                {focusedId === id ? ' (Ctrl+O)' : ''}
              </Text>
              {open ? <Markdown text={block.text} width={width} /> : null}
            </Box>
          ),
        });
      } else {
        const toolId = (callId: string) => `${item.id}:tool:${callId}`;
        const segments = segmentTools(block.callIds, {
          calls,
          results,
          live: !!item.streaming,
          isolated: callId => detailed || isUserShell(callId) || expandedIds.has(toolId(callId)),
        });
        segments.forEach((segment, at) => {
          if (segment.kind === 'summary')
            entries.push({
              key: `tools:${block.index}:${at}`,
              node: <SummaryLine text={segment.text} width={width} />,
            });
          else {
            const call = calls.get(segment.callId)!;
            entries.push({
              key: toolId(segment.callId),
              node: (
                <ToolEntry
                  call={call}
                  result={results.get(segment.callId)}
                  streaming={!!item.streaming}
                  streamed={item.toolOutput?.[segment.callId]}
                  expanded={detailed || isUserShell(segment.callId) || expandedIds.has(toolId(segment.callId))}
                  width={width}
                  animate={animate}
                />
              ),
            });
          }
        });
      }
    }
    const postHooks = parts.filter(part => part.kind === 'hook' && part.event.event === 'PostToolUse').length;
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
    if (citations.files.length)
      entries.push({
        key: 'memory',
        node: (
          <TextLine
            width={width}
            color={color('foregroundMuted')}
          >{`Ký ức đã dùng: ${citations.files.join(', ')}`}</TextLine>
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
    if (!item.streaming && !item.interrupted && !item.errorText && item.durationMs !== undefined && item.finishedAt) {
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
      marginBottom={1}
      ref={
        anchors && item.role === 'user'
          ? (el: DOMElement | null) => {
              if (el) anchors.set(item.id, el);
              else anchors.delete(item.id);
            }
          : undefined
      }
    >
      {entries.map((entry, index) => (
        <Box
          key={entry.key}
          width={width}
          minWidth={0}
          flexDirection="column"
          marginTop={index && !entry.attached ? 1 : 0}
        >
          {entry.node}
        </Box>
      ))}
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
  model?: string;
  formatTime?: (ms: number) => string;
}
export function Transcript({
  items,
  width: requestedWidth,
  isActive = false,
  liveItems = 8,
  historyKey = 'transcript',
  focusedId,
  onFocusChange,
  animate = true,
  historyOffset,
  bounded = false,
  showSpinner = true,
  liveRows,
  detailed = false,
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
  const shown = bounded && historyOffset === undefined ? items : live;
  const useStatic = !bounded && historyOffset === undefined;
  const ids = live.flatMap(activityIds);
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
          focusedId={selected}
          expandedIds={expandedIds}
          liveRows={liveRows}
          showSpinner={showSpinner}
          animate={animate}
          detailed={detailed}
          model={model}
          formatTime={formatTime}
        />
      ))}
    </Box>
  );
}
