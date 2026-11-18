import type {Message, ModelEvent, ToolCall, ToolResult, Usage} from '@futryn/contracts';
export type TranscriptPart =
  {kind: 'text'; text: string} | {kind: 'reasoning'; text: string} | {kind: 'tools'; callIds: string[]};
export interface TranscriptItem {
  id: string;
  role: Message['role'];
  content: string;
  parts?: TranscriptPart[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  toolOutput?: Record<string, string>;
  reasoning?: string;
  streaming?: boolean;
  awaitingModel?: boolean;
  startedAt?: number;
  usage?: Usage | null;
  durationMs?: number;
  errorText?: string;
  notices?: string[];
}
export function transcriptParts(item: TranscriptItem): TranscriptPart[] {
  return item.parts?.length
    ? item.parts
    : [
        ...(item.reasoning ? [{kind: 'reasoning' as const, text: item.reasoning}] : []),
        ...(item.toolCalls?.length ? [{kind: 'tools' as const, callIds: item.toolCalls.map(call => call.id)}] : []),
        ...(item.content ? [{kind: 'text' as const, text: item.content}] : []),
      ];
}
function appendText(item: TranscriptItem, kind: 'text' | 'reasoning', text: string) {
  const parts = (item.parts ??= []);
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({kind, text});
}
function appendCall(item: TranscriptItem, call: ToolCall) {
  item.toolCalls ??= [];
  if (item.toolCalls.some(existing => existing.id === call.id)) return;
  item.toolCalls.push(call);
  const parts = (item.parts ??= []);
  const last = parts.at(-1);
  if (last?.kind === 'tools' && last.callIds.some(id => !item.toolResults?.some(result => result.callId === id)))
    last.callIds.push(call.id);
  else parts.push({kind: 'tools', callIds: [call.id]});
}
/** Stored errors/denials and command exit codes survive replay. */
function storedResult(message: Message): ToolResult {
  const prefix = /^\[(denied|error)(?:: ([A-Z_]+))?\] /.exec(message.content);
  const content = prefix ? message.content.slice(prefix[0].length) : message.content;
  const exit = ['exec_command', 'write_stdin'].includes(message.toolName ?? '')
    ? /^Exit code: (-?\d+)\n/.exec(content)
    : null;
  return {
    callId: message.toolCallId ?? '',
    name: message.toolName ?? '',
    status: (prefix?.[1] as ToolResult['status']) ?? 'ok',
    content,
    ...(prefix?.[2] ? {code: prefix[2]} : {}),
    ...(exit ? {exitCode: Number(exit[1])} : {}),
  };
}
export function messagesToTranscript(messages: readonly Message[], idPrefix = 'history'): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let pending: TranscriptItem | undefined;
  const flush = () => {
    if (pending) items.push(pending);
    pending = undefined;
  };
  messages.forEach((message, index) => {
    if (message.role === 'tool') {
      if (pending) (pending.toolResults ??= []).push(storedResult(message));
      return;
    }
    if (message.role !== 'assistant') {
      flush();
      items.push({id: `${idPrefix}-${index}`, role: message.role, content: message.content});
      return;
    }
    pending ??= {id: `${idPrefix}-${index}`, role: 'assistant', content: '', parts: []};
    if (message.content) {
      pending.content += message.content;
      appendText(pending, 'text', message.content);
    }
    for (const call of message.toolCalls ?? []) appendCall(pending, call);
    if (!message.toolCalls?.length) flush();
  });
  flush();
  return items;
}
export function toolArgument(call: ToolCall): string {
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  for (const key of ['cmd', 'path', 'pattern', 'description', 'url', 'name', 'id', 'session_id'])
    if (input[key] !== undefined) return String(input[key]);
  if (call.name === 'apply_patch' && typeof input.patch === 'string')
    return [...input.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File): (.+)$/gm)]
      .map(match => match[1])
      .join(', ');
  return JSON.stringify(input).slice(0, 500);
}
export function toolState(result: ToolResult | undefined, live: boolean): string {
  if (!result) return live ? 'running' : 'stopped · no result';
  if (result.status === 'denied') return `denied${result.code ? ` · ${result.code}` : ''}`;
  if (
    result.status === 'error' ||
    (typeof result.exitCode === 'number' && result.exitCode !== 0) ||
    result.exitCode === null
  )
    return `error${result.code ? ` · ${result.code}` : ''}${result.exitCode !== undefined ? ` · exit ${result.exitCode ?? 'signal'}` : ''}`;
  return `${result.sessionId ? 'running' : 'ok'}${result.truncated ? ' · partial output' : ''}${result.sessionId ? ` · session ${result.sessionId}` : ''}${result.exitCode !== undefined ? ` · exit ${result.exitCode}` : ''}`;
}
interface ResponseMark {
  parts: TranscriptPart[];
  content: string;
  reasoning: string;
}
export interface TranscriptState {
  items: TranscriptItem[];
  responseMark?: ResponseMark;
}
export type TranscriptAction =
  | {type: 'reset'; items: TranscriptItem[]}
  | {type: 'begin'; id: string; prompt: string; now: number}
  | {type: 'event'; event: ModelEvent; now: number}
  | {type: 'finish'; error?: string; cancelled?: boolean; now: number}
  | {type: 'notice'; text: string};
/** Immutable turn presentation reducer. Host feeds SDK sendMessage events; never sends commands itself. */
export function reduceTranscript(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === 'reset') return {items: action.items};
  if (action.type === 'begin')
    return {
      items: [
        ...state.items,
        {id: `${action.id}:user`, role: 'user', content: action.prompt},
        {
          id: action.id,
          role: 'assistant',
          content: '',
          parts: [],
          streaming: true,
          awaitingModel: true,
          startedAt: action.now,
        },
      ],
    };
  const previous = state.items.at(-1);
  if (!previous)
    return action.type === 'notice'
      ? {items: [{id: 'notice:0', role: 'assistant', content: '', notices: [action.text]}]}
      : state;
  const item: TranscriptItem = {
    ...previous,
    parts: transcriptParts(previous).map(part =>
      part.kind === 'tools' ? {...part, callIds: [...part.callIds]} : {...part},
    ),
    toolCalls: [...(previous.toolCalls ?? [])],
    toolResults: [...(previous.toolResults ?? [])],
    toolOutput: {...previous.toolOutput},
    notices: [...(previous.notices ?? [])],
  };
  let responseMark = state.responseMark;
  const items = state.items.slice(0, -1);
  const notice = (text: string) => {
    item.notices = [...(item.notices ?? []), text].slice(-16);
  };
  if (action.type === 'notice') notice(action.text);
  if (action.type === 'finish') {
    item.streaming = false;
    item.awaitingModel = false;
    item.durationMs = Math.max(0, action.now - (item.startedAt ?? action.now));
    if (action.cancelled) notice('Generation cancelled by user.');
    else if (action.error) item.errorText = action.error;
  }
  if (action.type === 'event') {
    const event = action.event;
    switch (event.type) {
      case 'started':
        responseMark = {
          content: item.content,
          reasoning: item.reasoning ?? '',
          parts: structuredClone(item.parts ?? []),
        };
        item.awaitingModel = true;
        break;
      case 'textDelta':
        item.content += event.text;
        appendText(item, 'text', event.text);
        item.awaitingModel = false;
        break;
      case 'reasoningDelta':
        item.reasoning = (item.reasoning ?? '') + event.text;
        appendText(item, 'reasoning', event.text);
        item.awaitingModel = false;
        break;
      case 'toolCallComplete':
        appendCall(item, event.call);
        item.awaitingModel = false;
        break;
      case 'toolOutputDelta':
        item.toolOutput![event.callId] = ((item.toolOutput![event.callId] ?? '') + event.text).slice(-262144);
        break;
      case 'toolResult':
        item.toolResults = [...item.toolResults!.filter(result => result.callId !== event.result.callId), event.result];
        delete item.toolOutput![event.result.callId];
        break;
      case 'usage':
        item.usage = event.usage;
        break;
      case 'completed':
        item.usage = event.usage;
        item.awaitingModel = false;
        if (event.endTurn !== false) item.streaming = false;
        break;
      case 'responseDiscarded': {
        const mark = responseMark ?? {parts: [], content: '', reasoning: ''};
        // Keep actual tools, including ones appended to the open group at the mark.
        const known = new Set(mark.parts.flatMap(part => (part.kind === 'tools' ? part.callIds : [])));
        const calls = (item.parts ?? []).flatMap(part =>
          part.kind === 'tools' ? part.callIds.filter(id => !known.has(id)) : [],
        );
        item.parts = structuredClone(mark.parts);
        if (calls.length) item.parts.push({kind: 'tools', callIds: calls});
        item.content = mark.content;
        item.reasoning = mark.reasoning;
        notice(
          `Response ${event.reason}${event.attempt ? ` · retry ${event.attempt}/${event.maxRetries ?? '?'}` : ''}`,
        );
        break;
      }
      case 'steered':
        items.push(
          {...item, streaming: false, awaitingModel: false},
          {id: `${event.steerId}:user`, role: 'user', content: event.content},
        );
        return {
          items: [
            ...items,
            {
              id: event.steerId,
              role: 'assistant',
              content: '',
              parts: [],
              streaming: true,
              awaitingModel: true,
              startedAt: action.now,
            },
          ],
        };
      case 'inputDeferred':
        notice(`${event.steerIds.length} accepted instruction(s) deferred (${event.reason}).`);
        break;
      case 'context.compacted':
        notice(
          `Context compacted (${event.strategy}${event.fallback ? '; fallback' : ''}): ~${event.tokensBefore} → ~${event.tokensAfter} tokens.`,
        );
        break;
      // Detailed subagent state comes from client.subagents(), not invented from tool output.
      case 'subagent.finished':
        notice(`Subagent ${event.agentType}: ${event.description} · ${event.status}`);
        break;
    }
  }
  return {items: [...items, item], ...(responseMark ? {responseMark} : {})};
}
/** Only a settled prefix may enter Static. Keep a bounded live tail for focus/expansion. */
export function transcriptWindow(items: readonly TranscriptItem[], liveItems = 8) {
  const running = items.findIndex(item => item.streaming);
  const split = Math.min(Math.max(0, items.length - Math.max(1, liveItems)), running < 0 ? items.length : running);
  return {settled: items.slice(0, split), live: items.slice(split)};
}
