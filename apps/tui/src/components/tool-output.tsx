import type { BorderStyle, ThemeTokens, ToolCall } from '@hannes/contracts';
import type { RenderedBoxLine } from './editor';

export interface ToolExecutionSummary {
  call: ToolCall;
  status: 'completed' | 'denied' | 'not-implemented';
  expanded?: boolean;
  note?: string;
}

/** Một dòng nội tuyến mờ kiểu OpenCode: `⚙ tên-tool  {args}  — ghi chú`. */
export function renderToolExecutionCard(options: {
  width: number;
  summary: ToolExecutionSummary;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, summary, tokens } = options;
  const inner = Math.max(12, width - 4);
  const icon = summary.status === 'denied' ? '✖' : summary.status === 'completed' ? '✓' : '○';
  const color =
    summary.status === 'denied' ? tokens.error : summary.status === 'completed' ? tokens.info : tokens.warning;
  const note =
    summary.note ??
    (summary.status === 'not-implemented'
      ? 'Not implemented in PA1/TUI1'
      : 'recorded in transcript');
  let args = '';
  try {
    args = JSON.stringify(summary.call.input) ?? '';
  } catch {
    args = '';
  }
  const head = `${icon} ${summary.call.name}`;
  const rest = `  ${args}  — ${note}`;
  const text = `${head}${rest}`.slice(0, inner).padEnd(inner, ' ');
  return [
    {
      spans: [
        { text: '  ', fg: tokens.foreground, bg: tokens.background },
        { text: text.slice(0, head.length), fg: color, bg: tokens.background, bold: true },
        { text: text.slice(head.length), fg: tokens.foregroundSubtle, bg: tokens.background },
      ],
    },
  ];
}
