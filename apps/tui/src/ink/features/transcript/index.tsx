/** @jsxImportSource react */
import {memo, useMemo, useState} from 'react';
import {Box, Static, Text, useWindowSize} from 'ink';
import {isFileChangeTool} from '@futryn/contracts';
import {parseMemoryCitations} from '@futryn/sdk';
import {useKeymap} from '../../hooks';
import {useTheme} from '../../theme';
import {Markdown, Spinner, TextLine, Truncate, safeText} from '../../ui';
import {ToolDiff} from '../diff';
import {Notices} from '../notices';
import {toolArgument, toolState, transcriptParts, transcriptWindow, type TranscriptItem as Item} from './logic';
export * from './logic';
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
export interface TranscriptItemProps {
  item: Item;
  width?: number;
  focusedId?: string;
  expandedIds?: ReadonlySet<string>;
  animate?: boolean;
}
export const TranscriptItem = memo(function TranscriptItem({
  item,
  width = 80,
  focusedId,
  expandedIds = new Set(),
  animate = true,
}: TranscriptItemProps) {
  const {color} = useTheme();
  const {rows} = useWindowSize();
  const liveRows = Math.max(8, (rows || 24) - 12);
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
  let textPrefix = '';
  let renderedTextLength = 0;
  const calls = new Map(item.toolCalls?.map(call => [call.id, call]));
  const results = new Map(item.toolResults?.map(result => [result.callId, result]));
  return (
    <Box width={width} minWidth={0} flexDirection="column" marginBottom={1}>
      {item.role === 'user' ? (
        <TextLine width={width} bold>{`> ${item.content}`}</TextLine>
      ) : item.role !== 'assistant' ? (
        <TextLine width={width}>{item.content}</TextLine>
      ) : (
        parts.map((part, index) => {
          if (part.kind === 'text') {
            textPrefix += part.text;
            const cleanPrefix = parseMemoryCitations(textPrefix, true).content;
            const full = cleanPrefix.slice(renderedTextLength);
            renderedTextLength = cleanPrefix.length;
            // A live item re-renders every frame: keep it to a viewport-sized tail so cost and latency stay bounded
            // while a long answer streams; the finished item is committed in full.
            const text = item.streaming ? liveTail(full, liveRows) : full;
            return text ? (
              <Box key={index} minWidth={0}>
                <Text color={color('accent')}>⏺ </Text>
                <Markdown text={text} width={bodyWidth} />
              </Box>
            ) : null;
          }
          if (part.kind === 'reasoning') {
            const id = `${item.id}:reasoning:${index}`;
            const open = expandedIds.has(id);
            return (
              <Box key={index} flexDirection="column" minWidth={0}>
                <Text color={color('foregroundMuted')}>
                  {focusedId === id ? '› ' : ''}✻ Thinking… {open ? '▾' : '▸'}
                  {focusedId === id ? ' (Ctrl+O)' : ''}
                </Text>
                {open ? <Markdown text={part.text} width={width} /> : null}
              </Box>
            );
          }
          return (
            <Box key={index} flexDirection="column" minWidth={0}>
              {part.callIds.map(callId => {
                const call = calls.get(callId);
                if (!call) return null;
                const result = results.get(callId);
                const state = toolState(result, !!item.streaming);
                const id = `${item.id}:tool:${callId}`;
                const open = expandedIds.has(id);
                const failed = state.startsWith('error') || state.startsWith('denied');
                const output =
                  result?.content ??
                  item.toolOutput?.[callId] ??
                  (item.streaming ? 'Awaiting result…' : 'Stopped without a result');
                return (
                  <Box key={callId} flexDirection="column" minWidth={0}>
                    <TextLine
                      width={width}
                      color={color(failed ? 'error' : result ? 'success' : 'accent')}
                    >{`${focusedId === id ? '› ' : ''}⏺ ${call.name}(${toolArgument(call)}) · ${state}${focusedId === id ? ' · Ctrl+O' : ''}`}</TextLine>
                    <Box minWidth={0}>
                      <Text color={color('foregroundMuted')}> ⎿ </Text>
                      <Box minWidth={0} width={Math.max(1, width - 4)} flexDirection="column">
                        {isFileChangeTool(call.name) ? (
                          <ToolDiff result={result} expanded={open} width={Math.max(1, width - 4)} />
                        ) : (
                          <Truncate
                            text={safeText(output).slice(0, 262144)}
                            expanded={open}
                            maxLines={4}
                            width={Math.max(1, width - 4)}
                          />
                        )}
                        {result?.attachments?.map((attachment, at) => (
                          <TextLine key={at} width={bodyWidth}>{`[${attachment.mime}] ${attachment.name}`}</TextLine>
                        ))}
                        {result?.durationMs !== undefined ? (
                          <Text dimColor>{(result.durationMs / 1000).toFixed(1)}s</Text>
                        ) : null}
                      </Box>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          );
        })
      )}
      {citations.files.length ? (
        <TextLine
          width={width}
          color={color('foregroundMuted')}
        >{`Ký ức đã dùng: ${citations.files.join(', ')}`}</TextLine>
      ) : null}
      {item.streaming ? (
        <Spinner
          verb={
            item.awaitingModel
              ? 'Waiting'
              : item.toolCalls?.some(call => !results.has(call.id))
                ? 'Working'
                : parts.at(-1)?.kind === 'reasoning'
                  ? 'Thinking'
                  : 'Responding'
          }
          startedAt={item.startedAt}
          tokens={
            item.usage?.inputTokens == null && item.usage?.outputTokens == null
              ? undefined
              : (item.usage?.inputTokens ?? 0) + (item.usage?.outputTokens ?? 0)
          }
          animate={animate}
        />
      ) : null}
      {item.errorText ? (
        <TextLine width={width} color={color('error')}>
          {item.errorText}
        </TextLine>
      ) : null}
      <Notices notices={(item.notices ?? []).map((text, at) => ({id: `${at}`, text}))} width={width} />
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
}: TranscriptProps) {
  const terminal = useWindowSize();
  const width = Math.max(1, requestedWidth ?? terminal.columns);
  const [localFocus, setFocus] = useState<string>();
  const [expandedIds, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const window = useMemo(() => transcriptWindow(items, liveItems), [items, liveItems]);
  const count = Math.max(1, liveItems);
  const end = Math.max(0, items.length - Math.max(0, historyOffset ?? 0));
  const live = historyOffset === undefined ? window.live : items.slice(Math.max(0, end - count), end);
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
      {historyOffset === undefined ? (
        <Static key={historyKey} items={window.settled}>
          {item => <TranscriptItem key={item.id} item={item} width={width} animate={false} />}
        </Static>
      ) : (
        <Text dimColor>
          History · {live.length} of {items.length} messages
        </Text>
      )}
      {live.map(item => (
        <TranscriptItem
          key={item.id}
          item={item}
          width={width}
          focusedId={selected}
          expandedIds={expandedIds}
          animate={animate}
        />
      ))}
    </Box>
  );
}
