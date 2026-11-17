import type {PlanState, ThemeTokens} from '@futryn/contracts';
import type {RenderedBoxLine} from '../../ui/types';
import {planRows} from './logic';

/** The plan checklist as screen lines, clipped to `width`. */
export function renderPlanLines(
  plan: PlanState | null,
  width: number,
  maxRows: number,
  tokens: ThemeTokens,
): RenderedBoxLine[] {
  return planRows(plan, maxRows).map(row => {
    const text = (row.kind === 'item' ? '  ' : '') + row.text;
    const clipped = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;
    const fg =
      row.kind === 'summary'
        ? tokens.foregroundMuted
        : row.status === 'in_progress'
          ? tokens.accent
          : row.status === 'completed'
            ? tokens.success
            : row.status === 'cancelled'
              ? tokens.foregroundSubtle
              : tokens.foreground;
    return {
      spans: [
        {text: clipped, fg, bg: tokens.background, ...(row.status === 'in_progress' ? {bold: true} : {})},
        {text: ' '.repeat(Math.max(0, width - clipped.length)), fg: tokens.foreground, bg: tokens.background},
      ],
    };
  });
}
