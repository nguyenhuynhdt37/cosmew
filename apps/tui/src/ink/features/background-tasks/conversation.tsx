/** @jsxImportSource react */
import {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, type DOMElement} from 'ink';
import type {FutrynClient} from '@cosmew/sdk';
import type {SubagentSummaryView, ToolCall, ToolResult} from '@cosmew/contracts';
import {useFutrynClient, useKeybindings} from '../../hooks';
import {useOverlay} from '../../core';
import {useBindingLabel} from '../../hooks/keymap';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {ScrollViewport, useScrollback} from '../../screen';
import {Rule, TextLine, safeText, useDialogRows} from '../../ui';
import {useUiTheme} from '../../ui/ui-theme';
import {TranscriptItem} from '../transcript';
import {messagesToTranscript, type TranscriptItem as Item} from '../transcript/logic';
import {useTranscriptViewport} from '../transcript/viewport';
import type {VisibleTask} from './tasks';

/** Prefer actual stored/recovered child messages; reading never resumes or selects that session. */
export function childConversation(
  client: FutrynClient,
  child: SubagentSummaryView,
): {items: Item[]; snapshot: boolean} {
  const record = client.getSession(child.id);
  const messages = record?.recovery?.messages ?? record?.messages ?? [];
  const items = messagesToTranscript(messages, `child-${child.id}`);
  const calls = new Map(items.flatMap(item => item.toolCalls?.map(call => [call.id, item] as const) ?? []));
  for (const [index, step] of child.steps.entries()) {
    if (step.kind === 'text') {
      if (step.text && !items.some(item => item.content.includes(step.text!)))
        items.push({id: `step-${index}`, role: 'assistant', content: step.text});
      continue;
    }
    const id = step.callId ?? `step-${index}`;
    const existing = calls.get(id);
    if (existing) {
      if (step.status && step.status !== 'running' && !existing.toolResults?.some(result => result.callId === id))
        (existing.toolResults ??= []).push({
          callId: id,
          name: step.toolName ?? 'Tool',
          status: step.status,
          content: step.output ?? '',
        });
      continue;
    }
    // The fallback exposes only the recorded target, never claims to reconstruct full tool arguments.
    const name = step.toolName ?? 'Tool';
    const key = name === 'exec_command' ? 'cmd' : name === 'web_fetch' ? 'url' : 'description';
    const call: ToolCall = {id, name, input: {[key]: step.target ?? ''}};
    const result: ToolResult | undefined =
      step.status && step.status !== 'running'
        ? {callId: id, name, status: step.status, content: step.output ?? ''}
        : undefined;
    items.push({
      id: `activity-${id}`,
      role: 'assistant',
      content: '',
      toolCalls: [call],
      ...(result ? {toolResults: [result]} : {}),
      streaming: child.status === 'running' && !result,
    });
  }
  if (child.summary && !items.some(item => item.content.includes(child.summary)))
    items.push({id: 'child-summary', role: 'assistant', content: child.summary});
  for (const item of items) {
    if (item.toolCalls?.some(call => !item.toolResults?.some(result => result.callId === call.id)))
      item.streaming = child.status === 'running';
  }
  return {items, snapshot: !messages.length};
}

/** Full-height read-only child conversation, rendered by the same components as the main chat. */
export function AgentConversation({
  task,
  width,
  onBack,
  onStop,
  message,
}: {
  task: VisibleTask;
  width: number;
  onBack(): void;
  onStop(): void;
  message?: string;
}) {
  const client = useFutrynClient();
  const overlay = useOverlay();
  const overlayId = overlay.active?.id;
  const setFullScreen = overlay.setFullScreen;
  useEffect(() => {
    if (!overlayId) return;
    setFullScreen(overlayId, true);
    return () => setFullScreen(overlayId, false);
  }, [overlayId, setFullScreen]);
  const terminal = useTerminalSize();
  const dialogRows = useDialogRows();
  const height = Math.max(6, dialogRows ?? (terminal.rows || 24) - 1);
  const ui = useUiTheme();
  const scroll = useScrollback();
  const [detailed, setDetailed] = useState(false);
  const {owned, conversation} = useMemo(() => {
    const owned = client.subagents().find(child => child.id === task.id);
    return {
      owned,
      conversation: owned
        ? childConversation(client, owned)
        : {items: [{id: 'task-output', role: 'assistant' as const, content: task.outputTail}], snapshot: true},
    };
  }, [client, task]);
  const anchors = useRef(new Map<string, DOMElement>());
  const window = useTranscriptViewport(
    conversation.items,
    width,
    detailed,
    Math.max(1, height - 6),
    scroll.back,
    anchors.current,
  );
  const backKey = useBindingLabel('Select', 'select:cancel');
  const expandKey = useBindingLabel('Global', 'app:toggleTranscript');
  const followKey = useBindingLabel('Select', 'select:last');
  const stopKey = useBindingLabel('Footer', 'footer:close');
  const mouse = useMouseTarget(event => {
    if ('direction' in event) scroll.scrollBy(-event.direction);
  });
  useKeybindings({
    Select: {
      'select:cancel': onBack,
      'select:previous': () => scroll.scrollBy(1),
      'select:next': () => scroll.scrollBy(-1),
      'select:pageUp': scroll.pageUp,
      'select:pageDown': scroll.pageDown,
      'select:first': scroll.toTop,
      'select:last': scroll.toBottom,
    },
    Scroll: {
      'scroll:lineUp': () => scroll.scrollBy(1),
      'scroll:lineDown': () => scroll.scrollBy(-1),
      'scroll:pageUp': scroll.pageUp,
      'scroll:pageDown': scroll.pageDown,
      'scroll:top': scroll.toTop,
      'scroll:bottom': scroll.toBottom,
    },
    Global: {'app:toggleTranscript': () => setDetailed(value => !value)},
    Footer: {'footer:close': onStop, 'footer:stop': onStop},
  });
  return (
    <Box width={width} height={height} flexDirection="column" minWidth={0} overflow="hidden">
      <Box height={3} flexShrink={0} flexDirection="column">
        <TextLine
          width={width}
          wrap="truncate-end"
          bold
        >{`← Main chat / Agent · ${safeText(owned?.agentType ?? task.kind)} · ${task.status}`}</TextLine>
        <TextLine width={width} wrap="truncate-end" color={ui.color('dim')}>
          {task.description}
        </TextLine>
        <Rule width={width} />
      </Box>
      <Box
        ref={mouse}
        height={Math.max(1, height - 6)}
        flexShrink={0}
        minHeight={1}
        flexDirection="column"
        overflow="hidden"
      >
        <ScrollViewport scroll={scroll}>
          {window.before > 0 ? <Box height={window.before} flexShrink={0} /> : null}
          {conversation.items.length ? (
            window.shown.map(item => (
              <Box
                key={item.id}
                flexDirection="column"
                flexShrink={0}
                marginBottom={1}
                ref={node => {
                  if (node) anchors.current.set(item.id, node);
                  else anchors.current.delete(item.id);
                }}
              >
                <TranscriptItem
                  key={item.id}
                  item={item}
                  width={width}
                  detailed={detailed}
                  showSpinner={false}
                  animate={false}
                  model={owned?.selection.modelId}
                />
              </Box>
            ))
          ) : (
            <Text dimColor>Waiting for agent activity…</Text>
          )}
          {window.after > 0 ? <Box height={window.after} flexShrink={0} /> : null}
        </ScrollViewport>
      </Box>
      <Box height={3} flexShrink={0} flexDirection="column">
        <Rule width={width} />
        <TextLine width={width} wrap="truncate-end" color={ui.color('dim')}>
          {message ||
            `${owned?.toolCount ?? 0} tools · ${scroll.atBottom ? 'following' : `${followKey} follow`}${conversation.snapshot ? ' · activity snapshot' : ''}`}
        </TextLine>
        <TextLine
          width={width}
          wrap="truncate-end"
        >{`${backKey} back · ↑/↓ scroll · ${expandKey} ${detailed ? 'collapse' : 'expand tools'}${task.status === 'running' ? ` · ${stopKey} stop` : ''}`}</TextLine>
      </Box>
    </Box>
  );
}
