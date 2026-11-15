import type { BorderStyle, ThemeTokens } from '@hannes/contracts';
import type { RenderedBoxLine, StyledSpan } from '../../ui';
import { highlightCodeLine, toolSummary, wrapTextToWidth } from './logic';
import { renderToolExecutionCard } from './tool-card';
import type { TranscriptItem } from './types';

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
    // Tool use happens before the answer, so its cards come first.
    if (item.toolCalls && item.toolCalls.length > 0) {
      for (const call of item.toolCalls) {
        lines.push(...renderToolExecutionCard({ width, summary: toolSummary(call, item.toolResults), tokens, borderStyle: options.borderStyle }));
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

export function renderTranscriptViewport(options: {
  items: TranscriptItem[];
  width: number;
  height: number;
  scrollOffset: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  syntaxHighlighting: boolean;
}): { lines: RenderedBoxLine[]; totalLines: number; clampedOffset: number } {
  const { items, width, height, scrollOffset, tokens, borderStyle, syntaxHighlighting } = options;
  const contentWidth = Math.max(16, width - 2);
  const allLines = renderTranscriptMessages({
    items,
    width: contentWidth,
    tokens,
    borderStyle,
    syntaxHighlighting,
  });

  const totalLines = allLines.length;
  const maxOffset = Math.max(0, totalLines - height);
  const clampedOffset = scrollOffset < 0 ? maxOffset : Math.max(0, Math.min(maxOffset, scrollOffset));
  const slice = allLines.slice(clampedOffset, clampedOffset + height);

  const result: RenderedBoxLine[] = [];
  for (let row = 0; row < height; row++) {
    const line = slice[row] ?? { spans: [] };
    const used = line.spans.reduce((sum, span) => sum + span.text.length, 0);
    let thumb = ' ';
    if (totalLines > height) {
      const thumbPos = Math.floor((clampedOffset / Math.max(1, maxOffset)) * (height - 1));
      thumb = row === thumbPos ? '┃' : '│';
    }
    result.push({
      spans: [
        ...line.spans,
        ...(totalLines > height
          ? [{ text: `${' '.repeat(Math.max(0, contentWidth - used))} ${thumb}`, fg: tokens.scrollbar, bg: tokens.background }]
          : []),
      ],
    });
  }

  return { lines: result, totalLines, clampedOffset };
}
