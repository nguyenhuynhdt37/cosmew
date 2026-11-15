import type { Message, ThemeTokens, ToolCall, ToolResult } from '@hannes/contracts';
import type { ToolExecutionSummary, TranscriptItem } from './types';
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
  messages.forEach((m, idx) => {
    if (m.role === 'tool') { results.push(storedResult(m)); return; }
    if (m.role === 'assistant' && m.toolCalls) { calls.push(...m.toolCalls); if (m.content) preface += m.content + '\n\n'; return; }
    const tools = m.role === 'assistant' && calls.length ? { toolCalls: calls, toolResults: results } : {};
    items.push({ id: `${meta.idPrefix}-${idx}`, role: m.role, content: m.role === 'assistant' ? preface + m.content : m.content, modelId: meta.modelId, accountAlias: meta.accountAlias, ...tools });
    if (m.role === 'assistant') { calls = []; results = []; preface = ''; }
  });
  return items;
}
