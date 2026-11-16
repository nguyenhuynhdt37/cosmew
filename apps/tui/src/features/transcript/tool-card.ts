import type { BorderStyle, ThemeTokens } from '@futryn/contracts';
import type { RenderedBoxLine } from '../../ui';
import { toolTarget } from './logic';
import type { ToolExecutionSummary } from './types';

export function renderToolExecutionCard(options: {
  width: number;
  summary: ToolExecutionSummary;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, summary, tokens } = options;
  const inner = Math.max(12, width - 4);
  const icon = ({ running: '…', completed: '✓', denied: '✖', failed: '!', 'not-implemented': '○' } as const)[summary.status];
  const color = summary.status === 'denied' || summary.status === 'failed' ? tokens.error : summary.status === 'completed' ? tokens.info : tokens.warning;
  const note = summary.note ?? (summary.status === 'not-implemented' ? 'Not implemented' : '');
  const target = toolTarget(summary.call);
  const head = `${icon} ${summary.call.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')}`;
  const rest = ` ${target}${note ? `  — ${note}` : ''}`;
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
