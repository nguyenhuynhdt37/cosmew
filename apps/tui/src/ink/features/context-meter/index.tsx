/** @jsxImportSource react */
import {TextLine} from '../../ui';
import {useFutrynClient, useStatus} from '../../hooks';
import {useTheme} from '../../theme';
import {CONTEXT_COMPACTION_FRACTION} from '@cosmew/contracts';
import type {FutrynClient} from '@cosmew/sdk';
export function useContextMeter(draft = '') {
  const client = useFutrynClient();
  useStatus();
  return client.context(draft);
}
export function contextPercent(value: number | null) {
  return value == null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
}
export interface ContextMeterProps {
  context: ReturnType<FutrynClient['context']>;
  width?: number;
}
export function ContextMeter({context, width}: ContextMeterProps) {
  const {color} = useTheme();
  const percent = contextPercent(context.estimatedPercent);
  const filled = Math.round((percent ?? 0) / 10);
  const threshold = CONTEXT_COMPACTION_FRACTION * 100;
  return (
    <TextLine
      width={width}
      color={color(
        percent != null && percent >= 90 ? 'error' : percent != null && percent >= 75 ? 'warning' : 'foregroundMuted',
      )}
    >
      {`Context ~${context.estimateTokens} / ${context.limitTokens ?? 'not reported'} tokens · ${percent == null ? 'local estimate; window unknown' : `[${'='.repeat(filled)}${'-'.repeat(10 - filled)}] ~${percent}%`}${percent != null && percent >= threshold ? (context.autoCompact === false ? ' · /compact available' : ` · Near automatic compaction (${threshold}%); /compact`) : ''}`}
    </TextLine>
  );
}
