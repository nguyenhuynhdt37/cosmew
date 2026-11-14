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
        const header = `  ${codeLang}`;
        rendered.push({
          spans: [{ text: header.slice(0, contentWidth).padEnd(contentWidth, ' '), fg: tokens.foregroundSubtle, bg: tokens.backgroundElevated }],
        });
      } else {
        inCodeBlock = false;
        const footer = ' ';
        rendered.push({
          spans: [{ text: footer.slice(0, contentWidth).padEnd(contentWidth, ' '), fg: tokens.foregroundSubtle, bg: tokens.backgroundElevated }],
        });
      }
      continue;
    }

    if (inCodeBlock) {
      const clipped = raw.slice(0, Math.max(1, contentWidth - 4));
      const padRight = ' '.repeat(Math.max(0, contentWidth - 4 - clipped.length));
      const codeSpans = highlightCodeLine(`${clipped}${padRight}`, tokens, tokens.backgroundElevated, syntaxHighlighting);
      rendered.push({
        spans: [
          { text: '   ', fg: tokens.foregroundSubtle, bg: tokens.backgroundElevated },
          ...codeSpans,
          { text: ' ', fg: tokens.foregroundSubtle, bg: tokens.backgroundElevated },
        ],
      });
      continue;
    }

    const wrapped = wrapTextToWidth(raw, contentWidth - 2);
    for (const line of wrapped) {
      const padded = ` ${line}`.slice(0, contentWidth).padEnd(contentWidth, ' ');
      if (/^#{1,4}\s+/.test(line)) {
        rendered.push({
          spans: [{ text: padded, fg: tokens.markdownHeading, bg, bold: true }],
        });
      } else if (line.includes('`') && syntaxHighlighting) {
        // Inline code spans
        const parts = padded.split(/(`[^`]+`)/g);
        const spans: StyledSpan[] = [];
        for (const part of parts) {
          if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            spans.push({ text: part, fg: tokens.markdownCode, bg: tokens.backgroundElevated, bold: true });
          } else if (part.length > 0) {
            spans.push({ text: part, fg: tokens.foreground, bg });
          }
        }
        rendered.push({ spans });
      } else {
        rendered.push({
          spans: [{ text: padded, fg: tokens.foreground, bg }],
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
  const innerWidth = Math.max(12, width - 2);
  const lines: RenderedBoxLine[] = [];
  const bg = tokens.background;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]!;
    const isUser = item.role === 'user';

    if (idx > 0) lines.push({ spans: [] });

    if (isUser) {
      const maxText = Math.max(8, innerWidth - 2);
      const wrapped = wrapTextToWidth(item.content || '', maxText);
      const textWidth = Math.min(maxText, Math.max(1, ...wrapped.map(line => line.length)));
      const left = Math.max(0, innerWidth - (textWidth + 2));
      for (const line of wrapped) {
        lines.push({
          spans: [
            { text: ' '.repeat(left), fg: tokens.foregroundSubtle, bg },
            {
              text: ` ${line.slice(0, textWidth).padEnd(textWidth, ' ')} `,
              fg: tokens.accentForeground,
              bg: tokens.accent,
            },
          ],
        });
      }
      continue;
    }

    lines.push({
      spans: [
        { text: 'Fyn', fg: tokens.accent, bg, bold: true },
        { text: item.streaming ? '  ···' : '', fg: tokens.foregroundMuted, bg },
      ],
    });

    const body = renderMarkdownBody({
      content: item.content || (item.streaming ? '▍' : ''),
      width: Math.max(8, innerWidth - 2),
      tokens,
      bg,
      syntaxHighlighting,
    });
    for (const bLine of body) {
      lines.push({
        spans: [{ text: '│ ', fg: tokens.border, bg }, ...bLine.spans],
      });
    }

    // 3. Thông báo lỗi (nếu có)
    if (item.errorText) {
      lines.push({
        spans: [
          { text: `  ⚠ ${item.errorText}`.slice(0, innerWidth).padEnd(innerWidth, ' '), fg: tokens.error, bg, bold: true },
        ],
      });
    }

    // 4. Danh sách thực thi công cụ kiểu Codex Action Steps
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

    // 5. Dòng tổng kết lượt thực thi (Turn Footer) chuẩn OpenAI Codex + Fyn Companion
    const metaParts: string[] = [];
    if (item.durationMs !== undefined && item.durationMs > 0) {
      metaParts.push(`Worked for ${(item.durationMs / 1000).toFixed(1)}s`);
    }
    if (item.usage) {
      const totalTok = (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0);
      if (totalTok > 0) metaParts.push(`${totalTok} tok`);
      if (item.usage.costUSD !== null && item.usage.costUSD !== undefined) {
        metaParts.push(`$${item.usage.costUSD.toFixed(4)}`);
      }
    }
    if (item.modelId) {
      metaParts.push(item.modelId);
    }
    if (item.accountAlias) {
      metaParts.push(`@${item.accountAlias}`);
    }

    if (!item.streaming && metaParts.length > 0) {
      lines.push({
        spans: [
          { text: `  ${metaParts.join(' · ')}`.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg },
        ],
      });
    }
    lines.push({ spans: [] });
  }

  return lines;
}
