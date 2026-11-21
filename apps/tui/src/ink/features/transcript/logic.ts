import {changeReceipt} from '../diff/logic';
import {diffStats, diffSummary} from '../../ui/diff';
import type {HookRanEvent, Message, ModelEvent, ToolCall, ToolResult, Usage} from '@cosmew/contracts';
import type {ContextBlock} from '../usage/logic';
/** `at` is the arrival time (ms) of a text/reasoning part; the detailed transcript prints it with the model. */
export type TranscriptPart =
  | {kind: 'text'; text: string; at?: number}
  | {kind: 'reasoning'; text: string; at?: number}
  | {kind: 'hook'; event: HookRanEvent}
  | {kind: 'tools'; callIds: string[]};
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
  /** Wall-clock end of the turn (ms); with `durationMs` it drives `✻ <verb> for 8s · done 11:00 PM`. */
  finishedAt?: number;
  /** Model that answered, for the detailed transcript header. */
  model?: string;
  /** The user stopped the turn: `⎿  Interrupted · What should Cosmew do instead?`. */
  interrupted?: boolean;
  usage?: Usage | null;
  durationMs?: number;
  errorText?: string;
  notices?: string[];
  /** `/context` output: drawn as the coloured grid under the `❯ /context` line. */
  context?: ContextBlock;
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
function appendText(item: TranscriptItem, kind: 'text' | 'reasoning', text: string, at?: number) {
  const parts = (item.parts ??= []);
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({kind, text, ...(at !== undefined ? {at} : {})});
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
  const signalled =
    ['exec_command', 'write_stdin'].includes(message.toolName ?? '') && /^Process ended by signal/.test(content);
  return {
    callId: message.toolCallId ?? '',
    name: message.toolName ?? '',
    status: (prefix?.[1] as ToolResult['status']) ?? 'ok',
    content,
    ...(prefix?.[2] ? {code: prefix[2]} : {}),
    ...(exit ? {exitCode: Number(exit[1])} : signalled ? {exitCode: null} : {}),
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
/** True while the live response is in a reasoning block: the spinner then adds `thinking with <effort> effort`. */
export function isThinking(item: TranscriptItem | undefined): boolean {
  return !!item?.streaming && transcriptParts(item).at(-1)?.kind === 'reasoning';
}
export function toolArgument(call: ToolCall): string {
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  if (call.name === 'update_plan' && Array.isArray(input.plan)) {
    const steps = input.plan as {status?: unknown}[];
    return `${steps.filter(step => step?.status === 'completed').length}/${steps.length} completed`;
  }
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
export interface ToolDisplay {
  title: string;
  status: 'running' | 'ok' | 'error' | 'denied' | 'stopped';
  lines: string[];
}
function firstLine(text: string): string {
  const [head = '', ...rest] = text.split('\n');
  return rest.length ? `${head}…` : head;
}
/** `· Which color? → Red` lines of an answered `request_user_input`; undefined when the result is not an answer. */
export function answeredQuestions(call: ToolCall, result?: ToolResult): string[] | undefined {
  if (call.name !== 'request_user_input' || result?.status !== 'ok') return undefined;
  try {
    const parsed = JSON.parse(result.content) as {answers?: Record<string, {answers?: unknown}>};
    if (!parsed.answers || typeof parsed.answers !== 'object') return undefined;
    const questions = (call.input as {questions?: {id?: string; question?: string}[]} | undefined)?.questions ?? [];
    return Object.entries(parsed.answers).map(([id, value]) => {
      const answers = Array.isArray(value?.answers) ? value.answers.map(String).join(', ') : '';
      return `· ${questions.find(question => question.id === id)?.question ?? id} → ${answers}`;
    });
  } catch {
    return undefined;
  }
}
/** Presentation only: summaries come from results, never from proposed edits. */
export function toolDisplay(
  call: ToolCall,
  result?: ToolResult,
  live = false,
  expanded = false,
  streamed = '',
): ToolDisplay {
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  const arg = (key: string, fallback = '') => String(input[key] ?? fallback);
  const path = toolArgument(call);
  const titles: Record<string, string> = {
    read: `Read(${path})`,
    glob: `Search(pattern: ${JSON.stringify(arg('pattern', '**/*'))}, path: ${JSON.stringify(arg('path', '.'))})`,
    grep: `Search(pattern: ${JSON.stringify(arg('pattern'))}, path: ${JSON.stringify(arg('path', '.'))})`,
    edit: `Update(${path})`,
    apply_patch: `Update(${path})`,
    write: `Write(${path})`,
    exec_command: `Bash(${firstLine(arg('cmd'))})`,
    write_stdin: 'Bash(stdin)',
    web_fetch: `Fetch(${arg('url')})`,
    web_search: `Web Search(${JSON.stringify(arg('query'))})`,
    agent: `Task(${arg('description', arg('agent_type'))})`,
    update_plan: 'Update Todos',
    lsp: `LSP(${arg('operation', arg('op'))})`,
    skill: `Skill(${arg('name')})`,
    request_user_input: 'Questions',
  };
  const answered = answeredQuestions(call, result);
  const title = answered ? "Answered Cosmew's questions:" : (titles[call.name] ?? `${call.name}(${path})`);
  const state = toolState(result, live);
  const status = state.startsWith('denied')
    ? 'denied'
    : state.startsWith('error')
      ? 'error'
      : state.startsWith('running')
        ? 'running'
        : result
          ? 'ok'
          : 'stopped';
  const content = (result?.content ?? streamed).slice(0, 262144);
  if (answered) return {title, status, lines: answered};
  if (status === 'denied')
    return {
      title,
      status,
      lines: [`User rejected ${titles[call.name]?.split('(')[0] ?? call.name}`, ...(content ? [content] : [])],
    };
  if (call.name === 'exec_command' || call.name === 'write_stdin') {
    const raw = content ? content.replace(/\n$/, '').split('\n') : [];
    if (expanded) return {title, status, lines: raw};
    // Only strip the known dispatcher envelope, never metadata-like program output.
    const marker = raw.findIndex(line => /^Output(?: \(.*\))?:$/.test(line));
    const envelope =
      marker > 0 &&
      raw.slice(0, marker).some(line => line.startsWith('Wall time: ')) &&
      raw.slice(0, marker).some(line => line.startsWith('Output capture: '));
    const output = envelope ? raw.slice(marker + 1) : raw;
    const preview =
      output.length > 4 ? [...output.slice(0, 4), `… +${output.length - 4} lines (ctrl+o to expand)`] : output;
    const error =
      status === 'error'
        ? typeof result?.exitCode === 'number' && result.exitCode !== 0
          ? `Error: Exit code ${result.exitCode}`
          : `Error: ${envelope ? raw[0] : (result?.code ?? 'Tool failed')}`
        : undefined;
    return {
      title,
      status,
      lines: [
        ...(error ? [error] : []),
        ...preview,
        ...(!error && !preview.length
          ? [status === 'running' ? 'Awaiting result…' : status === 'stopped' ? 'Stopped without a result' : 'Done']
          : []),
      ],
    };
  }
  if (status === 'error')
    return {
      title,
      status,
      lines: [
        `Error: ${content || result?.code || 'Tool failed'}${result?.exitCode !== undefined ? ` (exit ${result.exitCode ?? 'signal'})` : ''}`,
      ],
    };
  if (['edit', 'apply_patch', 'write'].includes(call.name) && result) {
    const receipt = changeReceipt(result);
    if (receipt.changes.length)
      return {
        title,
        status,
        lines: receipt.changes.map(change => {
          const stats = diffStats(change.diff);
          const text =
            call.name === 'write' && change.action === 'add'
              ? `Wrote ${stats.added} ${stats.added === 1 ? 'line' : 'lines'} to ${change.path}`
              : change.action === 'delete'
                ? `Deleted ${change.path}`
                : diffSummary(stats);
          return receipt.changes.length > 1 && change.action !== 'delete' && !text.includes(change.path)
            ? `${change.path}: ${text}`
            : text;
        }),
      };
  }
  const raw = content ? content.replace(/\n$/, '').split('\n') : [];
  let lines = raw;
  if (result && !expanded) {
    const entries = raw.filter(line => line && !line.startsWith('['));
    if (call.name === 'read' && raw.some(line => /^\s*\d+\t/.test(line)))
      lines = [`Read ${raw.filter(line => /^\s*\d+\t/.test(line)).length} lines (ctrl+o to expand)`];
    else if (call.name === 'glob' || call.name === 'grep') {
      const files = call.name === 'glob' || input.output_mode === 'files_with_matches';
      const count = /^No (files matched|matches)\./.test(content)
        ? 0
        : files
          ? entries.length
          : input.output_mode === 'count'
            ? entries.reduce((n, line) => n + Number(/:(\d+)$/.exec(line)?.[1] ?? 0), 0)
            : entries.filter(line => /^.+:\d+:/.test(line)).length;
      lines = [
        `Found ${count} ${files ? 'files' : 'lines'}${result.truncated ? ' (partial results)' : ''} (ctrl+o to expand)`,
      ];
    }
  }
  if (!expanded && lines === raw && raw.length > 4)
    lines = [...raw.slice(0, 4), `… +${raw.length - 4} lines (ctrl+o to expand)`];
  if (!lines.length)
    lines = [status === 'running' ? 'Awaiting result…' : status === 'stopped' ? 'Stopped without a result' : 'Done'];
  return {title, status, lines};
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
  | {type: 'begin'; id: string; prompt: string; now: number; model?: string}
  | {type: 'event'; event: ModelEvent; now: number}
  | {type: 'finish'; error?: string; cancelled?: boolean; now: number}
  | {type: 'notice'; text: string}
  | {type: 'notification'; id: string; text: string}
  /** A finished slash command: `❯ /export` on the user background and its `⎿` result lines (spec 7). */
  | {type: 'command'; id: string; command: string; lines: string[]; context?: ContextBlock};
/** Immutable turn presentation reducer. Host feeds SDK sendMessage events; never sends commands itself. */
export function reduceTranscript(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === 'reset') return {items: action.items};
  if (action.type === 'notification') {
    if (state.items.some(item => item.id === action.id)) return state;
    const item: TranscriptItem = {id: action.id, role: 'assistant', content: action.text};
    // Live events always address the final assistant item. A background completion must not steal it.
    const last = state.items.at(-1);
    return {
      ...state,
      items:
        last?.streaming || (last?.startedAt !== undefined && last.finishedAt === undefined)
          ? [...state.items.slice(0, -1), item, last]
          : [...state.items, item],
    };
  }
  if (action.type === 'command')
    return {
      ...state,
      items: [
        ...state.items,
        {
          id: action.id,
          role: 'user',
          content: action.command,
          notices: action.lines.slice(-16),
          ...(action.context ? {context: action.context} : {}),
        },
      ],
    };
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
          ...(action.model ? {model: action.model} : {}),
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
    item.finishedAt = action.now;
    if (action.cancelled) item.interrupted = true;
    else if (action.error) item.errorText = action.error;
  }
  if (action.type === 'event') {
    const event = action.event;
    switch (event.type) {
      case 'hook.ran':
        item.parts!.push({kind: 'hook', event});
        break;
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
        appendText(item, 'text', event.text, action.now);
        item.awaitingModel = false;
        break;
      case 'reasoningDelta':
        item.reasoning = (item.reasoning ?? '') + event.text;
        appendText(item, 'reasoning', event.text, action.now);
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
        // Tools and hooks already ran: preempting model text cannot erase these observations.
        const known = new Set(mark.parts.flatMap(part => (part.kind === 'tools' ? part.callIds : [])));
        const actual: TranscriptPart[] = [];
        (item.parts ?? []).forEach((part, index) => {
          if (part.kind === 'tools') {
            const callIds = part.callIds.filter(id => !known.has(id));
            if (callIds.length) actual.push({kind: 'tools', callIds});
          } else if (part.kind === 'hook' && index >= mark.parts.length) actual.push(structuredClone(part));
        });
        item.parts = structuredClone(mark.parts);
        item.parts.push(...actual);
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
              ...(item.model ? {model: item.model} : {}),
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
/** Plain text of the conversation for `v` (open in $EDITOR) and `[` (write to the terminal scrollback). */
export function transcriptPlainText(items: readonly TranscriptItem[]): string {
  const blocks: string[] = [];
  for (const item of items) {
    if (item.role === 'user') {
      blocks.push(`> ${item.content}`);
      for (const notice of item.notices ?? []) blocks.push(`  ${notice}`);
      continue;
    }
    if (item.role !== 'assistant') {
      blocks.push(item.content);
      continue;
    }
    const lines: string[] = [];
    for (const part of transcriptParts(item)) {
      if (part.kind === 'text') lines.push(part.text);
      else if (part.kind === 'hook') lines.push(`${part.event.name} says: ${part.event.summary}`);
      else if (part.kind === 'tools')
        for (const id of part.callIds) {
          const call = item.toolCalls?.find(entry => entry.id === id);
          if (call) lines.push(`* ${call.name}`);
        }
    }
    if (item.errorText) lines.push(item.errorText);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n').replace(/\u001b/g, '');
}
