/** @jsxImportSource react */
import {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Box, Text, type DOMElement} from 'ink';
import type {FutrynClient} from '@cosmew/sdk';
import type {SubagentSummaryView, ToolCall, ToolResult} from '@cosmew/contracts';
import {useFutrynClient, useKeybindings} from '../../hooks';
import {useOverlay} from '../../core';
import {useBindingLabel} from '../../hooks/keymap';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {ScrollViewport, useScrollback, rowWithin} from '../../screen';
import {Rule, TextLine, safeText, useDialogRows} from '../../ui';
import {useUiTheme} from '../../ui/ui-theme';
import {TranscriptItem} from '../transcript';
import {messagesToTranscript, type TranscriptItem as Item} from '../transcript/logic';
import {useTranscriptViewport} from '../transcript/viewport';
import {ActivityNavigation, type ActivityAnchor} from '../transcript/activity';
import {taskStatusLabel, type VisibleTask} from './tasks';

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

export interface AgentPresentation {
  detailed: boolean;
  expanded: Set<string>;
  focused?: string;
  top: number;
  following: boolean;
}

interface AgentComposeState {
  draft: string;
  composing: boolean;
  delivery: string;
  pending: AbortController | null;
}
// Permission dialogs replace the task overlay. Keep only bounded, in-memory, owner-scoped drafts/results.
const composeCaches = new WeakMap<
  FutrynClient,
  Map<
    string,
    {
      value: AgentComposeState;
      listeners: Set<() => void>;
    }
  >
>();
function useAgentCompose(client: FutrynClient, agentId: string) {
  let cache = composeCaches.get(client);
  if (!cache) {
    composeCaches.set(client, (cache = new Map()));
    const ownedCache = cache;
    client.onReactiveEvent(() => {
      const parent = client.activeSession()?.id ?? '';
      for (const [id, item] of ownedCache) {
        if (!client.toolsEnabled() || JSON.parse(id)[0] !== parent) {
          item.value.pending?.abort();
          item.value = {draft: '', composing: false, delivery: '', pending: null};
          ownedCache.delete(id);
          for (const listener of item.listeners) listener();
        }
      }
    });
  }
  const key = JSON.stringify([client.activeSession()?.id ?? '', agentId]);
  let entry = cache.get(key);
  if (!entry) {
    entry = {value: {draft: '', composing: false, delivery: '', pending: null}, listeners: new Set()};
    cache.set(key, entry);
    if (cache.size > 32) {
      const stale =
        [...cache].find(([id, item]) => id !== key && !item.value.pending) ?? [...cache].find(([id]) => id !== key);
      if (stale) {
        stale[1].value.pending?.abort();
        stale[1].value = {draft: '', composing: false, delivery: '', pending: null};
        cache.delete(stale[0]);
      }
    }
  }
  const current = entry;
  const value = useSyncExternalStore(
    listener => {
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    },
    () => current.value,
  );
  const update = (patch: Partial<AgentComposeState>) => {
    current.value = {...current.value, ...patch};
    for (const listener of current.listeners) listener();
  };
  return {value, update};
}

/** Full-height child conversation, rendered by the same components as the main chat. */
export function AgentConversation({
  task,
  width,
  onBack,
  onStop,
  message,
  backLabel = 'Main chat',
  onSwitch,
  agentPosition,
  presentation,
  onPresentation,
}: {
  task: VisibleTask;
  width: number;
  onBack(): void;
  onStop(): void;
  message?: string;
  backLabel?: string;
  onSwitch?(delta: number): void;
  agentPosition?: string;
  presentation?: AgentPresentation;
  onPresentation?(value: AgentPresentation): void;
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
  const [detailed, setDetailed] = useState(presentation?.detailed ?? false);
  const [expanded, setExpanded] = useState(() => presentation?.expanded ?? new Set<string>());
  const [focused, setFocused] = useState(presentation?.focused);
  const compose = useAgentCompose(client, task.id);
  useLayoutEffect(() => {
    compose.update({composing: false});
  }, []);
  const {draft, composing, delivery, pending} = compose.value;
  const sending = !!pending;
  const setDraft = (next: string | ((value: string) => string)) =>
    compose.update({draft: typeof next === 'function' ? next(draft) : next});
  const setComposing = (value: boolean) => compose.update({composing: value});
  const setDelivery = (value: string) => compose.update({delivery: value});
  const sendMessage = async () => {
    if (sending || !draft.trim()) return;
    const controller = new AbortController();
    compose.update({pending: controller, delivery: 'Sending…'});
    try {
      const result = await client.sendSubagentMessage(task.id, draft, controller.signal);
      if (result.status === 'ok') compose.update({draft: '', composing: false, delivery: safeText(result.content)});
      else compose.update({delivery: `${result.code ?? result.status}: ${safeText(result.content)}`});
    } catch (error) {
      // Error objects may contain backend input; show only the public code, never arbitrary exception text.
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'SEND_FAILED';
      const safeCode = /^[A-Z_]{1,64}$/.test(code) ? code : 'SEND_FAILED';
      compose.update({
        delivery: controller.signal.aborted ? 'Send cancelled; draft retained.' : `${safeCode}; draft retained.`,
      });
    } finally {
      compose.update({pending: null});
    }
  };
  const activityAnchors = useRef(new Map<string, ActivityAnchor>());
  const saved = useRef<AgentPresentation | undefined>(undefined);
  saved.current = {detailed, expanded, focused, top: scroll.topRow, following: scroll.atBottom};
  useEffect(
    () => () => {
      if (saved.current) onPresentation?.(saved.current);
    },
    [],
  );
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !scroll.maxBack) return;
    restored.current = true;
    if (presentation && !presentation.following) scroll.showRow(presentation.top);
  }, [scroll.maxBack]);
  const toggleActivity = (_itemId: string, id: string) => {
    setFocused(id);
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        if (next.size > 512) next.delete(next.values().next().value!);
      }
      return next;
    });
  };
  const focusActivity = (delta: number) => {
    const root = scroll.content.current;
    const entries = [...activityAnchors.current].sort((a, b) =>
      root ? rowWithin(a[1].node, root) - rowWithin(b[1].node, root) : 0,
    );
    if (!entries.length) return false;
    const index = entries.findIndex(([id]) => id === focused);
    const target = entries[index < 0 ? (delta > 0 ? 0 : entries.length - 1) : index + delta];
    if (!target) return;
    setFocused(target[0]);
    if (root) {
      const row = rowWithin(target[1].node, root);
      if (row < scroll.topRow || row >= scroll.topRow + scroll.viewRows) scroll.showRow(row);
    }
  };
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
  const toggleKey = useBindingLabel('Transcript', 'transcript:toggleItem');
  const nextToolKey = useBindingLabel('Transcript', 'transcript:focusNext');
  const nextAgentKey = useBindingLabel('Footer', 'footer:next');
  const previousAgentKey = useBindingLabel('Footer', 'footer:previous');
  const followKey = useBindingLabel('Select', 'select:last');
  const composeSendKey = useBindingLabel('AgentCompose', 'agentCompose:submit');
  const composeCancelKey = useBindingLabel('AgentCompose', 'agentCompose:cancel');
  const composeKey = useBindingLabel('Footer', 'footer:messageAgent');
  const stopKey = useBindingLabel('Footer', 'footer:close');
  const mouse = useMouseTarget(event => {
    if ('direction' in event) scroll.scrollBy(-event.direction);
  });
  useKeybindings(
    composing
      ? {
          AgentCompose: {
            'agentCompose:cancel': () => {
              pending?.abort();
              setComposing(false);
            },
            'agentCompose:submit': () => {
              void sendMessage();
            },
            'agentCompose:delete': () => {
              if (!sending) setDraft(value => Array.from(value).slice(0, -1).join(''));
            },
            'agentCompose:navigation': () => {},
          },
        }
      : {
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
          Transcript: {
            'transcript:focusPrevious': () => focusActivity(-1),
            'transcript:focusNext': () => focusActivity(1),
            'transcript:toggleItem': () => {
              if (!focused) return false;
              const anchor = activityAnchors.current.get(focused);
              if (!anchor) return false;
              toggleActivity(anchor.itemId, focused);
            },
          },
          Global: {'app:toggleTranscript': () => setDetailed(value => !value)},
          Footer: {
            'footer:messageAgent': () => {
              if (owned && owned.status !== 'closed') {
                setDelivery('');
                setComposing(true);
              }
            },
            'footer:close': onStop,
            'footer:stop': onStop,
            'footer:next': () => onSwitch?.(1),
            'footer:previous': () => onSwitch?.(-1),
          },
        },
    {
      rawFirst: true,
      onKey: (input, key) => {
        if (composing) {
          if (key.escape) {
            pending?.abort();
            setComposing(false);
          } else if (key.return) void sendMessage();
          else if (!sending && (key.backspace || key.delete))
            setDraft(value => Array.from(value).slice(0, -1).join(''));
          else if (
            !sending &&
            !key.ctrl &&
            !key.meta &&
            !key.upArrow &&
            !key.downArrow &&
            !key.leftArrow &&
            !key.rightArrow &&
            !key.tab &&
            input
          )
            setDraft(value => (value + safeText(input).replace(/\n/g, ' ')).slice(0, 100_000));
          return true;
        }
        return false;
      },
    },
  );
  return (
    <Box width={width} height={height} flexDirection="column" minWidth={0} overflow="hidden">
      <Box height={3} flexShrink={0} flexDirection="column">
        <TextLine
          width={width}
          wrap="truncate-end"
          bold
        >{`← ${backLabel} / Agent · ${safeText(owned?.agentType ?? task.kind)} · ${taskStatusLabel(task)}`}</TextLine>
        <TextLine width={width} wrap="truncate-end" color={ui.color('dim')}>
          {task.description}
        </TextLine>
        <Rule width={width} />
      </Box>
      <ActivityNavigation.Provider
        value={{anchors: activityAnchors.current, toggle: toggleActivity, expandHint: toggleKey}}
      >
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
                    focusedId={focused}
                    expandedIds={expanded}
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
      </ActivityNavigation.Provider>
      <Box height={3} flexShrink={0} flexDirection="column">
        <Rule width={width} />
        <TextLine width={width} wrap="truncate-end" color={ui.color('dim')}>
          {delivery ||
            message ||
            `${owned?.toolCount ?? 0} tools · ${scroll.atBottom ? 'following' : `${followKey} follow`}${conversation.snapshot ? ' · activity snapshot' : ''}${agentPosition ? ` · agent ${agentPosition} (${previousAgentKey}/${nextAgentKey})` : ''}`}
        </TextLine>
        <TextLine width={width} wrap="truncate-end">
          {composing
            ? `${sending ? 'Sending…' : `Message: ${draft}`} · ${composeSendKey} send · ${composeCancelKey} cancel`
            : `${backKey} back · ${composeKey} message · ${nextToolKey} tool · ${toggleKey} toggle · ${expandKey} ${detailed ? 'collapse' : 'expand tools'}${task.status === 'running' ? ` · ${stopKey} stop` : ''}`}
        </TextLine>
      </Box>
    </Box>
  );
}
