import type {ThemeTokens} from '@futryn/contracts';
import type {FutrynClient} from '@futryn/sdk';
import {compactTokens} from '../reports';
import type {RenderedBoxLine} from '../../ui';

export function renderContextIndicator(
  context: ReturnType<FutrynClient['context']>,
  width: number,
  tokens: ThemeTokens,
): RenderedBoxLine {
  // Keep one source while typing; runtime measurements describe a previous request.
  const display = {
    used: context.estimateTokens,
    total: context.limitTokens,
    measured: false,
    ratio: context.estimatedPercent,
  };
  const total = display.total == null ? 'not reported' : compactTokens(display.total);
  const used = `${display.measured ? '' : '~'}${compactTokens(display.used)}`;
  const full = `Context  ${used} / ${total}${display.total == null ? '' : ' tokens'}`;
  const label = full.length <= width ? full : `Context max ${total}`;
  const ratio = display.ratio;
  const suffix = ratio == null ? 'local estimate' : `~${ratio}%`;
  const barWidth = Math.min(12, width - label.length - suffix.length - 5);
  const filled = ratio == null ? 0 : Math.round((Math.max(0, Math.min(100, ratio)) / 100) * Math.max(0, barWidth));
  const color =
    ratio != null && ratio >= 90 ? tokens.error : ratio != null && ratio >= 75 ? tokens.warning : tokens.accent;
  return {
    spans: [
      {text: label.slice(0, width), fg: tokens.foreground, bold: true},
      ...(barWidth >= 4 && ratio != null
        ? [
            {text: '  ', fg: tokens.foregroundMuted},
            {text: '━'.repeat(filled), fg: color},
            {text: '─'.repeat(barWidth - filled), fg: tokens.foregroundSubtle},
            {text: `  ${suffix}`, fg: tokens.foregroundMuted},
          ]
        : suffix && label.length + suffix.length + 3 <= width
          ? [{text: ` · ${suffix}`, fg: tokens.foregroundMuted}]
          : []),
    ],
  };
}
