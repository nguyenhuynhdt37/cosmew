import type { BorderStyle, RuntimeActivity, ThemeTokens, ToolCall, ToolResult } from '@hannes/contracts';
import type { RenderedBoxLine, StyledSpan } from '../../ui';
import { commandSummary, reasoningTitle, toolTarget, explorationActive, explorationRows, highlightCodeLine, transcriptParts, wrapTextToWidth } from './logic';
import type { TranscriptItem, TranscriptPart } from './types';
import { mixHex } from '../../theme/presets';
import { parseUnifiedDiff, renderDiffCodeLine } from '../diff/code-lines';

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

    const heading=/^#{1,6}\s+/.test(raw);
    const source=heading?raw.replace(/^#{1,6}\s+/,''):raw.replace(/^(\s*)[-*] /,'$1• ');
    const spans=inlineMarkdown(source,tokens,bg,heading);
    const plain=spans.map(span=>span.text).join('');let offset=0;
    for(const line of wrapTextToWidth(plain,Math.max(8,contentWidth-2))){
      if(!line){rendered.push({spans:[]});continue;}
      const start=plain.indexOf(line,offset),end=start+line.length;let position=0;
      rendered.push({spans:spans.flatMap(span=>{
        const from=Math.max(start,position),to=Math.min(end,position+span.text.length);position+=span.text.length;
        return to>from?[{...span,text:span.text.slice(from-(position-span.text.length),to-(position-span.text.length))}]:[];
      })});offset=end;
    }
  }

  return rendered;
}


/** Display Markdown as terminal spans; local links retain their relative label and line number. */
function inlineMarkdown(text:string,tokens:ThemeTokens,bg:string,heading=false):StyledSpan[]{
  const spans:StyledSpan[]=[];const pattern=/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;let offset=0;
  for(const match of text.matchAll(pattern)){
    if(match.index!>offset)spans.push({text:text.slice(offset,match.index),fg:tokens.foreground,bg,bold:heading});
    const value=match[0];
    if(value.startsWith('`'))spans.push({text:value.slice(1,-1),fg:tokens.markdownCode,bg:tokens.backgroundElevated});
    else if(value.startsWith('**'))spans.push({text:value.slice(2,-2),fg:tokens.foreground,bg,bold:true});
    else{
      const link=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)!;
      const label=link[1]!.replace(/[`*]/g,''),target=link[2]!;
      const line=/(?::(\d+)|#L(\d+))$/.exec(target);
      const shown=/^https?:\/\//.test(target)?label===target?label:`${label} (${target})`:label+(line&&!/:\d+$/.test(label)?':'+(line[1]??line[2]):'');
      spans.push({text:shown,fg:tokens.markdownCode,bg,bold:heading});
    }
    offset=match.index!+value.length;
  }
  if(offset<text.length)spans.push({text:text.slice(offset),fg:tokens.foreground,bg,bold:heading});
  return spans;
}

export function renderTranscriptMessages(options: {
  items: TranscriptItem[];
  width: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  syntaxHighlighting?: boolean;
  /** Kept for callers; every layout now uses the Claude Code style. */
  compactActivities?: boolean;
  /** True for a command still waiting for the user's decision (no process exists yet). */
  awaitingApproval?: (call: ToolCall) => boolean;
}): RenderedBoxLine[] {
  const { items, width, tokens, syntaxHighlighting = true } = options;
  const innerWidth = Math.max(16, width - 2);
  const lines: RenderedBoxLine[] = [];
  const bg = tokens.background;
  const gap = () => { if (lines.length && lines.at(-1)!.spans.length) lines.push({ spans: [] }); };

  for (const item of items) {
    if (item.role === 'user') {
      // Claude Code: `> prompt` on a faint band, so your turns are easy to find while scrolling.
      gap();
      const band = mixHex(tokens.background, tokens.foreground, 0.07);
      for (const [row, text] of wrapTextToWidth(item.content || '', Math.max(8, innerWidth - 2)).entries()) {
        lines.push({ spans: [
          { text: row === 0 ? '> ' : '  ', fg: tokens.foregroundMuted, bg: band, bold: true },
          { text: text.padEnd(innerWidth - 2), fg: tokens.foreground, bg: band },
        ] });
      }
      continue;
    }

    // Adjacent tool-only rounds read as one run of calls; the recorded timeline is untouched.
    const parts: TranscriptPart[] = [];
    for (const part of transcriptParts(item)) {
      const last = parts.at(-1);
      if (part.kind === 'tools' && last?.kind === 'tools') last.callIds.push(...part.callIds);
      else parts.push(part.kind === 'tools' ? { ...part, callIds: [...part.callIds] } : part);
    }
    for (const [index, part] of parts.entries()) {
      gap();
      if (part.kind === 'reasoning') {
        const key = `reasoning:${index}`;
        const open = !item.collapsedActivities?.includes(key) && (item.reasoningExpanded === true || Boolean(item.expandedActivities?.includes(key)));
        const live = Boolean(item.streaming) && index === parts.length - 1;
        const title = reasoningTitle(part.text);
        lines.push({ disclosure: { itemId: item.id, key }, spans: [
          { text: '✻ ', fg: live ? tokens.accent : tokens.foregroundSubtle, bg },
          { text: live ? 'Thinking…' : 'Thought', fg: tokens.foregroundMuted, bg, italic: true },
          { text: `${title ? ` · ${title}` : ''}${open ? '' : '  (ctrl+r to expand)'}`.slice(0, Math.max(0, innerWidth - 12)), fg: tokens.foregroundSubtle, bg, italic: true },
        ] });
        if (open) lines.push(...renderReasoningPart(part.text, innerWidth, tokens, bg, syntaxHighlighting));
      } else if (part.kind === 'tools') {
        part.callIds.forEach((id, row) => {
          const call = item.toolCalls?.find(entry => entry.id === id);
          if (!call) return;
          if (row) lines.push({ spans: [] });
          const result = item.toolResults?.find(entry => entry.callId === id);
          lines.push(...renderToolCall({ item, call, result, width: innerWidth, tokens, bg, awaiting: !result && Boolean(options.awaitingApproval?.(call)) }));
        });
      } else if (part.kind === 'activity') {
        const activity = item.activities?.find(entry => entry.id === part.id);
        if (activity) lines.push(...renderActivity({ item, activity, width: innerWidth, tokens, bg }));
      } else {
        const body = renderMarkdownBody({ content: part.text, width: Math.max(8, innerWidth - 2), tokens, bg, syntaxHighlighting });
        let first = true;
        for (const bLine of body) {
          if (!bLine.spans.length) { lines.push({ spans: [] }); continue; }
          lines.push({ spans: [{ text: first ? '⏺ ' : '  ', fg: tokens.foreground, bg }, ...bLine.spans] });
          first = false;
        }
      }
    }

    if (item.streaming && item.awaitingModel) {
      gap();
      lines.push({ spans: [{ text: '✻ ', fg: tokens.accent, bg }, { text: 'Waiting for model…', fg: tokens.foregroundMuted, bg, italic: true }] });
    }
    if (item.errorText) {
      gap();
      for (const text of wrapTextToWidth(item.errorText, Math.max(8, innerWidth - 4))) lines.push({ spans: [{ text: '  ⎿  ', fg: tokens.foregroundSubtle, bg }, { text, fg: tokens.error, bg }] });
    }

    const metaParts: string[] = [];
    if (item.durationMs !== undefined && item.durationMs > 0) metaParts.push(`Worked for ${(item.durationMs / 1000).toFixed(1)}s`);
    if (item.usage) {
      const totalTok = (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0);
      if (totalTok > 0) metaParts.push(`${totalTok} tok`);
      if (item.usage.costUSD !== null && item.usage.costUSD !== undefined) {
        metaParts.push(`${item.usage.costEstimated ? '~' : ''}$${item.usage.costUSD.toFixed(item.usage.costUSD > 0 && item.usage.costUSD < 0.0001 ? 6 : 4)}${item.usage.costEstimated ? ' estimated' : ''}`);
      }
    }
    if (!item.streaming && metaParts.length > 0) lines.push({ spans: [{ text: `  ${metaParts.join(' · ')}`.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg }] });
  }

  return lines;
}

/** Output rows under a `⎿`, Claude style: four lines, then `… +N lines`; a click expands them. */
function outputRows(text: string, width: number, expanded: boolean, tokens: ThemeTokens, bg: string, fg = tokens.foregroundMuted): RenderedBoxLine[] {
  const all = text.replace(/\r/g, '').split('\n').filter((line, index, list) => line.trim() || index < list.length - 1);
  const shown = expanded ? all.slice(0, 200) : all.slice(0, 4);
  const rows: RenderedBoxLine[] = shown.map((line, index) => ({ spans: [
    { text: index === 0 ? '  ⎿  ' : '     ', fg: tokens.foregroundSubtle, bg },
    { text: line.replace(/\t/g, '  ').slice(0, Math.max(4, width - 5)), fg, bg },
  ] }));
  const hidden = all.length - shown.length;
  if (hidden > 0) rows.push({ spans: [{ text: `     … +${hidden} lines${expanded ? '' : ' (click to expand)'}`, fg: tokens.foregroundSubtle, bg }] });
  return rows;
}

/** `⏺ Name(args)` header: the dot shows state (running accent, done green, failed/denied red). */
/** Header rows before `…`; a click on the row shows the full command. */
const HEADER_ROWS = 2;
function callHeader(name: string, args: string, state: 'running' | 'ok' | 'error' | 'muted', width: number, tokens: ThemeTokens, bg: string, disclosure?: RenderedBoxLine['disclosure'], full = false): RenderedBoxLine[] {
  const dot = state === 'running' ? tokens.accent : state === 'ok' ? tokens.success : state === 'error' ? tokens.error : tokens.foregroundSubtle;
  // Model-chosen names and arguments must never carry terminal control sequences to the screen.
  const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  name = safe(name); args = safe(args);
  let wrapped = wrapTextToWidth(args ? `${name}(${args})` : name, Math.max(8, width - 2));
  if (!full && wrapped.length > HEADER_ROWS) wrapped = [...wrapped.slice(0, HEADER_ROWS - 1), wrapped[HEADER_ROWS - 1]!.slice(0, Math.max(1, width - 4)) + '…'];
  // Name in the accent colour and bold, arguments one step quieter: the eye finds each call fast.
  return wrapped.map((text, row) => {
    const head = row === 0 ? text.slice(0, name.length) : '';
    return { ...(row === 0 && disclosure ? { disclosure } : {}), spans: [
      { text: row === 0 ? '⏺ ' : '  ', fg: dot, bg, bold: true },
      ...(head ? [{ text: head, fg: tokens.accent, bg, bold: true }] : []),
      { text: text.slice(head.length), fg: state === 'muted' ? tokens.foregroundMuted : tokens.foreground, bg },
    ] };
  });
}

const TOOL_NAMES: Record<string, string> = { read: 'Read', glob: 'Glob', grep: 'Search', exec_command: 'Bash', apply_patch: 'Update' };

/** One Hannes tool call with its paired result. */
function renderToolCall(options: { item: TranscriptItem; call: ToolCall; result: ToolResult | undefined; width: number; tokens: ThemeTokens; bg: string; awaiting: boolean }): RenderedBoxLine[] {
  const { item, call, result, width, tokens, bg } = options;
  const key = `tools:${call.id}`;
  const expanded = Boolean(item.expandedActivities?.includes(key));
  const live = Boolean(item.streaming);
  const name = TOOL_NAMES[call.name] ?? call.name;
  const input = call.input as Record<string, unknown> | undefined;
  const args = call.name === 'exec_command' ? commandSummary(call, result, { live }).command
    : call.name === 'apply_patch' ? toolTarget(call)
    : expanded && ['read', 'glob', 'grep'].includes(call.name) ? JSON.stringify(input ?? {})
    : call.name === 'read' ? String(toolTarget(call)) : call.name === 'glob' || call.name === 'grep' ? toolTarget(call) : String(toolTarget(call) || JSON.stringify(input ?? {}));
  const state = !result ? (live ? 'running' : 'muted') : result.status === 'ok' ? 'ok' : 'error';
  const lines = callHeader(name, args, state, width, tokens, bg, { itemId: item.id, key }, expanded);
  if (call.name === 'apply_patch') {
    // The patch title (Patched / partially applied / failed / denied / pending / stopped) leads the `⎿`.
    const patch = renderPatchCell({ call, result, width, tokens, bg, live, showDiff: true });
    const title = patch[0]!.spans.slice(1).map(span => ({ ...span, text: span.text.trimStart() }));
    return [...lines, { spans: [{ text: '  ⎿  ', fg: tokens.foregroundSubtle, bg }, ...title] },
      ...patch.slice(1).map(line => line.spans[0]?.text === '  └ ' || line.spans[0]?.text === '    ' && line.spans.length === 2 ? { ...line, spans: [{ ...line.spans[0]!, text: '     ' }, ...line.spans.slice(1)] } : line)];
  }
  if (!result) {
    lines.push({ spans: [{ text: '  ⎿  ', fg: tokens.foregroundSubtle, bg }, { text: options.awaiting ? 'Waiting for permission…' : live ? 'Running…' : 'Stopped', fg: options.awaiting ? tokens.warning : tokens.foregroundMuted, bg, italic: true }] });
    return lines;
  }
  if (result.status === 'denied') {
    lines.push({ spans: [{ text: '  ⎿  ', fg: tokens.foregroundSubtle, bg }, { text: `Permission denied${result.code && result.code !== 'DENIED' ? ` (${result.code.toLowerCase().replaceAll('_', ' ')})` : ''}`, fg: tokens.error, bg }] });
    return lines;
  }
  if (call.name === 'exec_command') {
    const summary = commandSummary(call, result, { live });
    const body = [...summary.preview, ...(summary.note ? [summary.note] : [])].join('\n');
    return [...lines, ...outputRows(expanded ? result.content : body || '(no output)', width, expanded, tokens, bg, result.status === 'ok' ? tokens.foregroundMuted : tokens.error), ...(!expanded && summary.hidden ? [{ spans: [{ text: `     … +${summary.hidden} lines (click to expand)`, fg: tokens.foregroundSubtle, bg }] }] : [])];
  }
  if (result.status !== 'ok') return [...lines, ...outputRows(`Error${result.code ? ` (${result.code})` : ''}: ${result.content}`, width, expanded, tokens, bg, tokens.error)];
  const count = result.content ? result.content.replace(/\n$/, '').split('\n').length : 0;
  const summary = call.name === 'read' ? `Read ${count} ${count === 1 ? 'line' : 'lines'}` : call.name === 'glob' ? `Found ${count} ${count === 1 ? 'file' : 'files'}` : call.name === 'grep' ? `Found ${count} ${count === 1 ? 'match' : 'matches'}` : `${count} lines`;
  return [...lines, ...outputRows(expanded ? `${summary}\n${result.content}` : summary, width, expanded, tokens, bg)];
}

/** A runtime's own tool (ADR 0027), drawn exactly like a Hannes call. */
function renderActivity(options: { item: TranscriptItem; activity: RuntimeActivity; width: number; tokens: ThemeTokens; bg: string }): RenderedBoxLine[] {
  const { item, activity, width, tokens, bg } = options;
  const key = `activity:${activity.id}`;
  const expanded = Boolean(item.expandedActivities?.includes(key));
  const state = activity.status === 'running' ? (item.streaming ? 'running' : 'muted') : activity.status === 'completed' ? 'ok' : 'error';
  const lines = callHeader(activity.name, activity.label, state, width, tokens, bg, { itemId: item.id, key }, expanded);
  if (activity.status === 'denied') lines.push({ spans: [{ text: '  ⎿  ', fg: tokens.foregroundSubtle, bg }, { text: 'Permission denied', fg: tokens.error, bg }] });
  else if (activity.output) lines.push(...outputRows(activity.output, width, expanded, tokens, bg, activity.status === 'failed' ? tokens.error : tokens.foregroundMuted));
  else lines.push({ spans: [{ text: '  ⎿  ', fg: tokens.foregroundSubtle, bg }, { text: activity.status === 'running' ? (item.streaming ? 'Running…' : 'Stopped') : activity.status === 'failed' ? 'Failed' : 'Done', fg: activity.status === 'failed' ? tokens.error : tokens.foregroundMuted, bg, italic: activity.status === 'running' }] });
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
  compactActivities?: boolean;
  awaitingApproval?: (call: ToolCall) => boolean;
}): { lines: RenderedBoxLine[]; allLines: RenderedBoxLine[]; totalLines: number; clampedOffset: number } {
  const { items, width, height, scrollOffset, tokens, borderStyle, syntaxHighlighting } = options;
  const contentWidth = Math.max(16, width - 2);
  const allLines = renderTranscriptMessages({
    items,
    width: contentWidth,
    tokens,
    borderStyle,
    syntaxHighlighting,
    awaitingApproval: options.awaitingApproval,
    compactActivities: options.compactActivities,
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

  return { lines: result, allLines, totalLines, clampedOffset };
}

/** Thinking body under `✻ Thought`, Claude style: indented, dim italic. */
function renderReasoningPart(text: string, width: number, tokens: ThemeTokens, bg: string, syntaxHighlighting: boolean): RenderedBoxLine[] {
  // Summary titles (`**Title**`) feed the status line; inline they read as plain words.
  const body = renderMarkdownBody({ content: text.trim().replace(/\*\*([^*\n]+)\*\*/g, '$1'), width: Math.max(8, width - 4), tokens, bg, syntaxHighlighting });
  return body.map(line => {
    if (!line.spans.length) return { spans: [] };
    const prefix = { text: '  ', fg: tokens.foregroundSubtle, bg };
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
  const incomplete=explorationActive(calls,results);
  const active = options.live && incomplete;
  const stopped = !options.live && incomplete;
  const lines: RenderedBoxLine[] = [{ spans: [
    { text: active ? '◦' : '•', fg: active ? tokens.accent : tokens.foregroundSubtle, bg },
    { text: active ? ' Exploring' : stopped ? ' Exploration stopped' : ' Explored', fg: tokens.foreground, bg, bold: true },
  ] }];
  explorationRows(calls, results, {live:options.live}).forEach((row, index) => {
    const lead = index === 0 ? '  └ ' : '    ';
    const indent = ' '.repeat(lead.length + row.verb.length + 1);
    const note = row.note ? ` (${row.note})` : '';
    const wrapped = wrapTextToWidth(row.target + note, Math.max(8, width - indent.length));
    wrapped.forEach((text, wrapIndex) => {
      const noteStart = wrapIndex === wrapped.length - 1 && note ? Math.max(0, text.length - note.length) : text.length;
      lines.push({ spans: [
        { text: wrapIndex === 0 ? lead : indent, fg: tokens.foregroundSubtle, bg },
        ...(wrapIndex === 0 ? [{ text: row.verb + ' ', fg: tokens.foregroundMuted, bg }] : []),
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

/** Patch proposals are not exploration, and only returned receipts describe actual writes. */
function renderPatchCell(options:{call:ToolCall;result:ToolResult|undefined;width:number;tokens:ThemeTokens;bg:string;live:boolean;showDiff?:boolean}):RenderedBoxLine[]{
  const {call,result,width,tokens,bg,live}=options;
  let receipt:{status?:string;changes?:{path?:unknown;action?:unknown;diff?:unknown}[];remaining?:unknown[];createdDirectories?:unknown[];failureCode?:unknown}|undefined;
  try{const parsed=result?JSON.parse(result.content):undefined;if(parsed&&typeof parsed==='object')receipt=parsed;}catch{/* verification/denial messages are plain text */}
  const partial=result?.status==='error'&&result.code==='PARTIAL_APPLY';
  const effectsAllowed=result?.status==='ok'||partial;
  const changes=effectsAllowed&&Array.isArray(receipt?.changes)?receipt.changes.filter(change=>change&&typeof change.path==='string'&&['add','update','delete'].includes(String(change.action))).slice(0,64):[];
  const title=!result?live?'Patch pending':'Patch stopped':result.status==='denied'?'Patch denied':partial?'Patch partially applied':result.status==='error'?'Patch failed':changes.length?'Patched':'Patch completed';
  const color=result?.status==='error'||result?.status==='denied'?tokens.error:!result?tokens.foregroundMuted:tokens.foreground;
  const clean=(value:string)=>value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,1024);
  const details:string[]=[];
  if(effectsAllowed&&Array.isArray(receipt?.createdDirectories))for(const path of receipt.createdDirectories.slice(0,64))if(typeof path==='string')details.push('Created directory '+clean(path));
  for(const change of changes){
    if(change&&typeof change.path==='string'&&['add','update','delete'].includes(String(change.action)))details.push(`${{add:'Added',update:'Updated',delete:'Deleted'}[change.action as 'add'|'update'|'delete']} ${clean(change.path)}`);
  }
  if(partial&&Array.isArray(receipt?.remaining))for(const path of receipt.remaining.slice(0,64))if(typeof path==='string')details.push('Not applied: '+clean(path));
  if(!details.length){
    if(result?.status==='ok'&&Array.isArray(receipt?.changes)&&receipt.changes.length===0)details.push('No changes');
    else if(toolTarget(call))details.push(toolTarget(call));
  }
  if(result?.status==='error')details.push(clean(String(receipt?.failureCode??result.code??'error')).toLowerCase().replaceAll('_',' '));
  const lines:RenderedBoxLine[]=[{spans:[{text:!result&&live?'◦':'•',fg:!result&&live?tokens.accent:color,bg},{text:' '+title,fg:color,bg,bold:true}]}];
  details.forEach((detail,index)=>wrapTextToWidth(detail,Math.max(8,width-4)).forEach((text,row)=>lines.push({spans:[{text:index===0&&row===0?'  └ ':'    ',fg:tokens.foregroundSubtle,bg},{text,fg:tokens.foregroundMuted,bg}]})));
  if (options.showDiff && effectsAllowed) {
    for (const change of changes) {
      if (typeof change.diff !== 'string') continue;
      const diffLines = parseUnifiedDiff(change.diff).flatMap(line => renderDiffCodeLine(line,Math.max(1,width-4),tokens));
      if (!diffLines.length) continue;
      lines.push({spans:[{text:`    ${clean(String(change.path))} · applied diff`,fg:tokens.foreground,bg,bold:true}]});
      for (const line of diffLines.slice(0,12)) lines.push({spans:[{text:'    ',fg:tokens.foregroundMuted,bg},...line.spans]});
      if (diffLines.length>12) lines.push({spans:[{text:`    … ${diffLines.length-12} more lines · /diff`,fg:tokens.foregroundSubtle,bg}]});
    }
  }
  return lines;
}
