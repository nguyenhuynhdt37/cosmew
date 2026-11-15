import type { Message, ThemeTokens, ToolCall, ToolResult } from '@hannes/contracts';
import type { ExplorationRow, ToolExecutionSummary, TranscriptItem, TranscriptPart } from './types';
import type { StyledSpan } from '../../ui';

const CODE_KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'const',
  'let',
  'var',
  'function',
  'async',
  'await',
  'return',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'class',
  'interface',
  'type',
  'true',
  'false',
  'null',
  'undefined',
  'new',
  'try',
  'catch',
  'throw',
  'def',
  'fn',
  'pub',
  'struct',
]);

export function highlightCodeLine(
  line: string,
  tokens: ThemeTokens,
  bg: string,
  syntaxHighlighting = true,
): StyledSpan[] {
  if (!syntaxHighlighting) {
    return [{ text: line, fg: tokens.markdownCode, bg }];
  }
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) {
    return [{ text: line, fg: tokens.syntaxComment, bg }];
  }

  const spans: StyledSpan[] = [];
  const tokenRegex = /(".*?"|'.*?'|`.*?`|\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      spans.push({
        text: line.slice(lastIndex, match.index),
        fg: tokens.foreground,
        bg,
      });
    }
    const word = match[0];
    if (word.startsWith('"') || word.startsWith("'") || word.startsWith('`')) {
      spans.push({ text: word, fg: tokens.syntaxString, bg });
    } else if (CODE_KEYWORDS.has(word)) {
      spans.push({ text: word, fg: tokens.syntaxKeyword, bg, bold: true });
    } else if (line[match.index + word.length] === '(') {
      spans.push({ text: word, fg: tokens.syntaxFunction, bg });
    } else {
      spans.push({ text: word, fg: tokens.foreground, bg });
    }
    lastIndex = match.index + word.length;
  }

  if (lastIndex < line.length) {
    spans.push({ text: line.slice(lastIndex), fg: tokens.foreground, bg });
  }
  return spans.length > 0 ? spans : [{ text: line, fg: tokens.foreground, bg }];
}

export function wrapTextToWidth(text: string, maxWidth: number): string[] {
  const safeMax = Math.max(8, maxWidth);
  const rawLines = text.split('\n');
  const out: string[] = [];

  for (const raw of rawLines) {
    if (raw.length <= safeMax) {
      out.push(raw);
      continue;
    }
    let remaining = raw;
    while (remaining.length > safeMax) {
      let splitAt = remaining.lastIndexOf(' ', safeMax);
      if (splitAt <= Math.floor(safeMax * 0.35)) {
        splitAt = safeMax;
      }
      out.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.length > 0) {
      out.push(remaining);
    }
  }
  return out.length > 0 ? out : [''];
}

/** Short human label for a tool call, e.g. `src/app.ts` for read or `"TODO" in src` for grep. */
/** Model-supplied text never carries control bytes into the transcript. */
const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

export function toolTarget(call: ToolCall): string {
  return printable(rawToolTarget(call));
}

function rawToolTarget(call: ToolCall): string {
  const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  if (call.name === 'read') return str('path') ?? '';
  if (call.name === 'glob') return `${str('pattern') ?? '**/*'}${str('path') ? ` in ${str('path')}` : ''}`;
  if (call.name === 'grep') return `"${str('pattern') ?? ''}"${str('path') ? ` in ${str('path')}` : ''}${str('glob') ? ` (${str('glob')})` : ''}`;
  return '';
}

/** Display state of one call given the results received so far. */
export function toolSummary(call: ToolCall, results: ToolResult[] | undefined): ToolExecutionSummary {
  const result = results?.find(r => r.callId === call.id);
  if (!result) return { call, status: 'running', note: 'running…' };
  if (result.status === 'denied') return { call, status: 'denied', note: result.code === 'DENIED' ? 'denied' : (result.code ?? 'denied').toLowerCase() };
  if (result.status === 'error') return { call, status: 'failed', note: (result.code ?? 'error').toLowerCase().replaceAll('_', ' ') };
  const lines = result.content ? result.content.split('\n').length : 0;
  return { call, status: 'completed', note: result.truncated ? 'partial' : call.name === 'read' ? `${lines} lines` : 'done' };
}

/** Stored tool results keep their status as a `[denied: CODE]` / `[error: CODE]` prefix. */
function storedResult(m: Message): ToolResult {
  const match = /^\[(denied|error)(?:: ([A-Z_]+))?\] /.exec(m.content);
  return { callId: m.toolCallId!, name: m.toolName!, status: (match?.[1] as ToolResult['status'] | undefined) ?? 'ok', code: match?.[2], content: match ? m.content.slice(match[0].length) : m.content };
}

/**
 * Fold a stored conversation into transcript items: tool-call and tool-result messages of a turn
 * attach to that turn's final answer as cards instead of showing up as separate messages.
 */
export function messagesToTranscript(messages: Message[], meta: { idPrefix: string; modelId?: string; accountAlias?: string }): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let calls: ToolCall[] = []; let results: ToolResult[] = []; let preface = '';
  // Stored turns keep the call/text order, so a resumed session shows the same timeline.
  let parts: TranscriptItem = { id: '', role: 'assistant', content: '' };
  messages.forEach((m, idx) => {
    if (m.role === 'tool') { results.push(storedResult(m)); return; }
    if (m.role === 'assistant' && m.toolCalls) {
      calls.push(...m.toolCalls); if (m.content) { preface += m.content + '\n\n'; appendStreamPart(parts, 'text', m.content); }
      for (const call of m.toolCalls) appendToolPart(parts, call.id);
      return;
    }
    const tools = m.role === 'assistant' && calls.length ? { toolCalls: calls, toolResults: results } : {};
    if (m.role === 'assistant' && calls.length) appendStreamPart(parts, 'text', m.content);
    items.push({ id: `${meta.idPrefix}-${idx}`, role: m.role, content: m.role === 'assistant' ? preface + m.content : m.content, modelId: meta.modelId, accountAlias: meta.accountAlias, ...tools, ...(m.role === 'assistant' && calls.length ? { parts: parts.parts } : {}) });
    if (m.role === 'assistant') { calls = []; results = []; preface = ''; parts = { id: '', role: 'assistant', content: '' }; }
  });
  return items;
}

/** Add streamed text or reasoning to the open part of that kind, or start a new one. */
export function appendStreamPart(item: TranscriptItem, kind: 'text' | 'reasoning', text: string): void {
  if (!text) return;
  const parts = item.parts ??= [];
  const last = parts.at(-1);
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/** Consecutive tool calls share one exploration group until text or reasoning arrives. */
export function appendToolPart(item: TranscriptItem, callId: string): void {
  const parts = item.parts ??= [];
  const last = parts.at(-1);
  if (last?.kind === 'tools') last.callIds.push(callId);
  else parts.push({ kind: 'tools', callIds: [callId] });
}

/** The timeline to draw: recorded parts, or the old flat layout for items without them. */
export function transcriptParts(item: TranscriptItem): TranscriptPart[] {
  if (item.parts?.length) return item.parts;
  const parts: TranscriptPart[] = [];
  if (item.reasoning) parts.push({ kind: 'reasoning', text: item.reasoning });
  if (item.toolCalls?.length) parts.push({ kind: 'tools', callIds: item.toolCalls.map(call => call.id) });
  if (item.content) parts.push({ kind: 'text', text: item.content });
  return parts;
}

const base = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) || path;

/** A call of this group still waiting for its result. */
export function explorationActive(calls: ToolCall[], results: ToolResult[] | undefined): boolean {
  return calls.some(call => !results?.some(r => r.callId === call.id));
}

/**
 * Rows of one exploration group. Adjacent successful reads collapse into one `Read a, b` row;
 * a search, a listing or any read with a notable outcome gets its own row.
 */
export function explorationRows(calls: ToolCall[], results: ToolResult[] | undefined): ExplorationRow[] {
  const rows: ExplorationRow[] = [];
  const reads = calls.filter(call => call.name === 'read').map(call => toolTarget(call));
  // File names like Codex, but the full path when two different files share a name.
  const label = (path: string) => (new Set(reads.filter(other => base(other) === base(path))).size > 1 ? path : base(path));
  let open: ExplorationRow | undefined; let names: string[] = [];
  for (const call of calls) {
    const result = results?.find(r => r.callId === call.id);
    const unchanged = result?.status === 'ok' && result.content.startsWith('[unchanged]');
    const note = !result ? undefined
      : result.status === 'denied' ? 'denied'
      : result.status === 'error' ? (result.code === 'TOOL_BUDGET' ? 'over budget' : (result.code ?? 'error').toLowerCase().replaceAll('_', ' '))
      : unchanged ? 'unchanged' : result.truncated ? 'partial' : undefined;
    const tone: ExplorationRow['tone'] = result && result.status !== 'ok' ? 'error' : note ? 'muted' : 'ok';
    const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
    const str = (key: string) => (typeof input[key] === 'string' ? printable(input[key] as string) : undefined);
    if (call.name === 'read' && !note) {
      const name = label(toolTarget(call));
      if (open) { if (!names.includes(name)) { names.push(name); open.target = names.join(', '); } continue; }
      names = [name]; open = { verb: 'Read', target: name, tone: 'ok' }; rows.push(open); continue;
    }
    open = undefined;
    if (call.name === 'read') rows.push({ verb: 'Read', target: label(toolTarget(call)), note, tone });
    else if (call.name === 'grep') rows.push({ verb: 'Search', target: `${str('pattern') ?? ''}${str('path') && str('path') !== '.' ? ` in ${str('path')}` : ''}${str('glob') ? ` (${str('glob')})` : ''}`, note, tone });
    else if (call.name === 'glob') rows.push({ verb: 'List', target: `${str('pattern') ?? '**/*'}${str('path') && str('path') !== '.' ? ` in ${str('path')}` : ''}`, note, tone });
    else rows.push({ verb: 'Call', target: printable(call.name), note, tone });
  }
  return rows;
}

/** Codex-style compact elapsed time: `12s`, `1m 05s`, `1h 02m 03s`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const two = (n: number) => String(n).padStart(2, '0');
  if (total < 3600) return `${Math.floor(total / 60)}m ${two(total % 60)}s`;
  return `${Math.floor(total / 3600)}h ${two(Math.floor(total % 3600 / 60))}m ${two(total % 60)}s`;
}

/** The latest `**Title**` a reasoning summary announced, used as the live status label. */
export function reasoningTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const titles = [...text.matchAll(/\*\*([^*\n]{1,80})\*\*/g)].map(match => printable(match[1]!.trim())).filter(Boolean);
  return titles.at(-1);
}
