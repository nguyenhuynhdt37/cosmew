import type { BorderStyle, Message, ThemeTokens, ToolCall, Usage } from '@hannes/contracts';

import type { RenderedBoxLine, StyledSpan } from './editor';
import { renderToolExecutionCard } from './tool-output';

export interface TranscriptItem {
  id: string;
  role: Message['role'];
  content: string;
  modelId?: string;
  accountAlias?: string;
  usage?: Usage | null;
  toolCalls?: ToolCall[];
  streaming?: boolean;
  errorText?: string;
  durationMs?: number;
  reasoning?: string;
  reasoningExpanded?: boolean;
}

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

function wrapTextToWidth(text: string, maxWidth: number): string[] {
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

export function renderMarkdownBody(options: {
  content: string;
  width: number;
  tokens: ThemeTokens;
  bg: string;
  syntaxHighlighting: boolean;
}): RenderedBoxLine[] {
  const { content, width, tokens, bg, syntaxHighlighting } = options;
  const contentWidth = Math.max(10, width);
  const rawLines = content.split('\n');
  const rendered: RenderedBoxLine[] = [];
  let inCodeBlock = false;
  let codeLang = '';

  for (const raw of rawLines) {
    if (raw.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = raw.trimStart().slice(3).trim() || 'code';
        rendered.push({
          spans: [{ text: codeLang.slice(0, contentWidth), fg: tokens.foregroundSubtle, bg }],
        });
      } else {
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      const codeWidth = Math.max(1, contentWidth - 2);
      // Preserve long source lines rather than silently dropping their suffix.
      for (let start = 0; start < Math.max(1, raw.length); start += codeWidth) {
        const codeSpans = highlightCodeLine(raw.slice(start, start + codeWidth), tokens, tokens.backgroundElevated, syntaxHighlighting);
        rendered.push({ spans: [
          { text: ' ', fg: tokens.foregroundSubtle, bg: tokens.backgroundElevated },
          ...codeSpans,
          { text: ' ', fg: tokens.foregroundSubtle, bg: tokens.backgroundElevated },
        ] });
      }
      continue;
    }

    const wrapped = wrapTextToWidth(raw, Math.max(8, contentWidth - 2));
    for (const line of wrapped) {
      const text = line.slice(0, contentWidth);
      if (text.length === 0) {
        rendered.push({ spans: [] });
        continue;
      }
      if (/^#{1,4}\s+/.test(text)) {
        rendered.push({
          spans: [{ text, fg: tokens.markdownHeading, bg, bold: true }],
        });
      } else if (text.includes('`') && syntaxHighlighting) {
        const parts = text.split(/(`[^`]+`)/g);
        const spans: StyledSpan[] = [];
        for (const part of parts) {
          if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            spans.push({ text: part, fg: tokens.markdownCode, bg: tokens.backgroundElevated });
          } else if (part.length > 0) {
            spans.push({ text: part, fg: tokens.foreground, bg });
          }
        }
        rendered.push({ spans });
      } else {
        rendered.push({
          spans: [{ text, fg: tokens.foreground, bg }],
        });
      }
    }
  }

  return rendered;
}

export function renderTranscriptMessages(options: {
  items: TranscriptItem[];
  width: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  syntaxHighlighting?: boolean;
}): RenderedBoxLine[] {
  const { items, width, tokens, syntaxHighlighting = true } = options;
  const innerWidth = Math.max(16, width - 4);
  const lines: RenderedBoxLine[] = [];
  const bg = tokens.background;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]!;
    const isUser = item.role === 'user';

    if (idx > 0) lines.push({ spans: [] });

    if (isUser) {
      const wrapped = wrapTextToWidth(item.content || '', Math.max(8, innerWidth - 4));
      for (const [row, text] of wrapped.entries()) {
        lines.push({ spans: [
          { text: row === 0 ? '› ' : '  ', fg: tokens.accent, bg: tokens.backgroundElevated, bold: true },
          { text: text.padEnd(innerWidth - 2), fg: tokens.foreground, bg: tokens.backgroundElevated },
        ] });
      }
      continue;
    }

    if (item.reasoning) {
      lines.push({ spans: [{ text: `  ${item.reasoningExpanded ? '▾' : '▸'} Thinking · from provider · Ctrl+R`, fg: tokens.foregroundSubtle, bg }] });
      if (item.reasoningExpanded) {
        for (const line of renderMarkdownBody({ content: item.reasoning, width: innerWidth - 4, tokens, bg, syntaxHighlighting })) {
          lines.push({ spans: [{ text: '  ', fg: tokens.foregroundSubtle, bg }, ...line.spans.map(span => ({ ...span, fg: tokens.foregroundMuted }))] });
        }
      }
    }
    if (item.content || item.streaming) {
      const body = renderMarkdownBody({
        content: item.content || '▍',
        width: Math.max(8, innerWidth - 4),
        tokens,
        bg,
        syntaxHighlighting,
      });
      for (const [row, bLine] of body.entries()) {
        if (bLine.spans.length === 0) {
          lines.push({ spans: [] });
          continue;
        }
        lines.push({
          spans: [{ text: row === 0 ? '• ' : '  ', fg: tokens.accent, bg }, ...bLine.spans],
        });
      }
    }

    if (item.errorText) {
      lines.push({
        spans: [
          { text: `  ${item.errorText}`.slice(0, innerWidth), fg: tokens.error, bg },
        ],
      });
    }

    if (item.toolCalls && item.toolCalls.length > 0) {
      for (const call of item.toolCalls) {
        lines.push(
          ...renderToolExecutionCard({
            width,
            summary: { call, status: 'not-implemented' },
            tokens,
            borderStyle: options.borderStyle,
          }),
        );
      }
    }

    const metaParts: string[] = [];
    if (item.durationMs !== undefined && item.durationMs > 0) {
      metaParts.push(`Worked for ${(item.durationMs / 1000).toFixed(1)}s`);
    }
    if (item.usage) {
      const totalTok = (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0);
      if (totalTok > 0) metaParts.push(`${totalTok} tok`);
      if (item.usage.costUSD !== null && item.usage.costUSD !== undefined) {
        metaParts.push(`${item.usage.costEstimated ? '~' : ''}$${item.usage.costUSD.toFixed(item.usage.costUSD > 0 && item.usage.costUSD < 0.0001 ? 6 : 4)}${item.usage.costEstimated ? ' estimated' : ''}`);
      }
    }

    if (!item.streaming && metaParts.length > 0) {
      lines.push({
        spans: [
          { text: `  ${metaParts.join(' · ')}`.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg },
        ],
      });
    }
  }

  return lines;
}
