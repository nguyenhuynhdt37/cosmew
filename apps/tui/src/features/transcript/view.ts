import type { BorderStyle, ThemeTokens, ToolCall, ToolResult } from '@hannes/contracts';
import type { RenderedBoxLine, StyledSpan } from '../../ui';
import { commandSummary, explorationActive, explorationRows, highlightCodeLine, transcriptParts, wrapTextToWidth } from './logic';
import type { TranscriptItem, TranscriptPart } from './types';

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
  /** True for a command still waiting for the user's decision (no process exists yet). */
  awaitingApproval?: (call: ToolCall) => boolean;
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

    const parts = transcriptParts(item);
    let previous: TranscriptPart['kind'] | undefined;
    for (const part of parts) {
      // Reasoning and exploration stay compact; answer text gets air around it.
      if (previous && (part.kind === 'text' || previous === 'text')) lines.push({ spans: [] });
      if (part.kind === 'reasoning') {
        if (item.reasoningExpanded === false) continue; // Ctrl+R hides thinking
        lines.push(...renderReasoningPart(part.text, innerWidth, tokens, bg, syntaxHighlighting));
      } else if (part.kind === 'tools') {
        const calls = part.callIds.map(id => item.toolCalls?.find(call => call.id === id)).filter((call): call is ToolCall => Boolean(call));
        // Reads/searches group under "Explored"; every command gets its own cell, in order.
        let run: ToolCall[] = [];
        const flush = () => { if (run.length) lines.push(...renderExplorationGroup({ calls: run, results: item.toolResults, width: innerWidth, tokens, bg, live: Boolean(item.streaming) })); run = []; };
        for (const call of calls) {
          if (call.name !== 'exec_command') { run.push(call); continue; }
          flush();
          const result = item.toolResults?.find(r => r.callId === call.id);
          lines.push(...renderCommandCell({ call, result, width: innerWidth, tokens, bg, live: Boolean(item.streaming), awaiting: !result && Boolean(options.awaitingApproval?.(call)) }));
        }
        flush();
      } else {
        const body = renderMarkdownBody({ content: part.text, width: Math.max(8, innerWidth - 4), tokens, bg, syntaxHighlighting });
        for (const [row, bLine] of body.entries()) {
          if (bLine.spans.length === 0) { lines.push({ spans: [] }); continue; }
          lines.push({ spans: [{ text: row === 0 ? '• ' : '  ', fg: tokens.accent, bg }, ...bLine.spans] });
        }
      }
      previous = part.kind;
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
  awaitingApproval?: (call: ToolCall) => boolean;
}): { lines: RenderedBoxLine[]; totalLines: number; clampedOffset: number } {
  const { items, width, height, scrollOffset, tokens, borderStyle, syntaxHighlighting } = options;
  const contentWidth = Math.max(16, width - 2);
  const allLines = renderTranscriptMessages({
    items,
    width: contentWidth,
    tokens,
    borderStyle,
    syntaxHighlighting,
    awaitingApproval: options.awaitingApproval,
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

/** Thinking as Codex prints summaries, but inline: dim italic, `• ` on the first row. */
function renderReasoningPart(text: string, width: number, tokens: ThemeTokens, bg: string, syntaxHighlighting: boolean): RenderedBoxLine[] {
  // Summary titles (`**Title**`) feed the status line; inline they read as plain words.
  const body = renderMarkdownBody({ content: text.trim().replace(/\*\*([^*\n]+)\*\*/g, '$1'), width: Math.max(8, width - 4), tokens, bg, syntaxHighlighting });
  let first = true;
  return body.map(line => {
    if (!line.spans.length) return { spans: [] };
    const prefix = { text: first ? '• ' : '  ', fg: tokens.foregroundSubtle, bg };
    first = false;
    return { spans: [prefix, ...line.spans.map(span => ({ ...span, fg: tokens.foregroundMuted, bg, bold: false, italic: true }))] };
  });
}

/**
 * One group of read/glob/grep calls, the way Codex shows exploration:
 *
 *   • Explored
 *     └ Search verifyToken in src
 *       Read routes.ts, service.ts
 */
export function renderExplorationGroup(options: { calls: ToolCall[]; results: ToolResult[] | undefined; width: number; tokens: ThemeTokens; bg: string; live: boolean }): RenderedBoxLine[] {
  const { calls, results, width, tokens, bg } = options;
  const active = options.live && explorationActive(calls, results);
  const lines: RenderedBoxLine[] = [{ spans: [
    { text: active ? '◦' : '•', fg: active ? tokens.accent : tokens.foregroundSubtle, bg },
    { text: active ? ' Exploring' : ' Explored', fg: tokens.foreground, bg, bold: true },
  ] }];
  explorationRows(calls, results).forEach((row, index) => {
    const lead = index === 0 ? '  └ ' : '    ';
    const indent = ' '.repeat(lead.length + row.verb.length + 1);
    const note = row.note ? ` (${row.note})` : '';
    const wrapped = wrapTextToWidth(row.target + note, Math.max(8, width - indent.length));
    wrapped.forEach((text, wrapIndex) => {
      const noteStart = wrapIndex === wrapped.length - 1 && note ? Math.max(0, text.length - note.length) : text.length;
      lines.push({ spans: [
        { text: wrapIndex === 0 ? lead : indent, fg: tokens.foregroundSubtle, bg },
        ...(wrapIndex === 0 ? [{ text: row.verb + ' ', fg: tokens.accent, bg }] : []),
        { text: text.slice(0, noteStart), fg: tokens.foreground, bg },
        ...(noteStart < text.length ? [{ text: text.slice(noteStart), fg: row.tone === 'error' ? tokens.error : tokens.foregroundSubtle, bg }] : []),
      ] });
    });
  });
  return lines;
}

/**
 * One sandboxed command, Codex-style:
 *
 *   • Ran rg -n "verifyToken" src
 *     └ src/routes.ts:1:import { verifyToken } from './service';
 *       … +3 lines
 *
 * The header says only what is true: waiting for approval, pending a result, ran (exit 0),
 * or failed (nonzero exit, timeout, denial, sandbox error).
 */
export function renderCommandCell(options: { call: ToolCall; result: ToolResult | undefined; width: number; tokens: ThemeTokens; bg: string; live: boolean; awaiting?: boolean }): RenderedBoxLine[] {
  const { tokens, bg, width } = options;
  const summary = commandSummary(options.call, options.result, { live: options.live, awaiting: options.awaiting });
  const marker = summary.state === 'pending' || summary.state === 'awaiting' ? { text: '◦', fg: tokens.accent }
    : summary.state === 'ran' ? { text: '•', fg: tokens.success } : summary.state === 'failed' ? { text: '•', fg: tokens.error } : { text: '•', fg: tokens.foregroundSubtle };
  const verb = { awaiting: 'Waiting for approval', pending: 'Command pending', ran: 'Ran', failed: 'Failed', stopped: 'Stopped' }[summary.state];
  const command = wrapTextToWidth(summary.command, Math.max(8, width - verb.length - 3));
  const lines: RenderedBoxLine[] = command.map((text, index) => ({ spans: index === 0
    ? [{ ...marker, bg }, { text: ` ${verb} `, fg: tokens.foreground, bg, bold: true }, { text, fg: tokens.foreground, bg }]
    : [{ text: ' '.repeat(verb.length + 3), fg: tokens.foreground, bg }, { text, fg: tokens.foreground, bg }] }));
  const detail = [...summary.preview.map(text => ({ text, fg: tokens.foregroundMuted })), ...(summary.hidden ? [{ text: `… +${summary.hidden} lines`, fg: tokens.foregroundSubtle }] : []),
    ...(summary.note ? [{ text: summary.note, fg: summary.state === 'failed' ? tokens.error : tokens.foregroundSubtle }] : [])];
  detail.forEach((row, index) => lines.push({ spans: [
    { text: index === 0 ? '  └ ' : '    ', fg: tokens.foregroundSubtle, bg },
    { text: row.text.slice(0, Math.max(4, width - 4)), fg: row.fg, bg },
  ] }));
  return lines;
}
