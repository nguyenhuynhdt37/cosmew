/** @jsxImportSource react */
import {useState} from 'react';
import {Box, Text} from 'ink';
import type {PlanState, PlanItem} from '@futryn/contracts';
import {useEvents, useFutrynClient} from '../../hooks';
import {useTheme} from '../../theme';
import {TextLine} from '../../ui';
export const PLAN_GLYPHS: Record<PlanItem['status'], string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○',
  cancelled: '✗',
};
export function activePlanLabel(plan: PlanState | null): string | undefined {
  const item = plan?.items.find(item => item.status === 'in_progress');
  return item?.activeForm ?? item?.step;
}
export function planWindow(plan: PlanState | null, maxItems = 5): PlanItem[] {
  const items = plan?.items ?? [];
  const room = Math.max(1, Math.floor(maxItems));
  const focus = Math.max(
    0,
    items.findIndex(item => item.status === 'in_progress'),
  );
  const start = Math.min(Math.max(0, focus - Math.floor(room / 2)), Math.max(0, items.length - room));
  return items.slice(start, start + room);
}
export function usePlan() {
  const client = useFutrynClient();
  const [plan, setPlan] = useState(() => client.plan());
  useEvents({reactive: () => setPlan(client.plan())});
  return {plan, activeLabel: activePlanLabel(plan)};
}
export interface PlanProps {
  plan: PlanState | null;
  width?: number;
  maxItems?: number;
  expanded?: boolean;
}
/** Place in the plan slot to pin above the composer. */
export function Plan({plan, width, maxItems = 5, expanded = false}: PlanProps) {
  const {color} = useTheme();
  if (!plan?.items.length) return null;
  const done = plan.items.filter(item => item.status === 'completed').length;
  const settled = plan.items.every(item => item.status === 'completed' || item.status === 'cancelled');
  const items = settled && !expanded ? [] : expanded ? plan.items : planWindow(plan, maxItems);
  return (
    <Box width={width} minWidth={0} flexDirection="column">
      <Text color={color('foregroundMuted')}>
        Plan · {done}/{plan.items.length} completed{settled && done !== plan.items.length ? ' · cancelled steps' : ''}
      </Text>
      {plan.explanation && !settled ? (
        <TextLine color={color('foregroundMuted')} width={width}>
          {plan.explanation}
        </TextLine>
      ) : null}
      {items.map((item, index) => (
        <TextLine
          key={index}
          width={width}
          bold={item.status === 'in_progress'}
          color={color(
            item.status === 'in_progress'
              ? 'accent'
              : item.status === 'completed'
                ? 'success'
                : item.status === 'cancelled'
                  ? 'foregroundSubtle'
                  : 'foreground',
          )}
        >{`  ${PLAN_GLYPHS[item.status]} ${item.step}`}</TextLine>
      ))}
      {items.length > 0 && items.length < plan.items.length ? (
        <Text color={color('foregroundMuted')}>{plan.items.length - items.length} other steps</Text>
      ) : null}
    </Box>
  );
}
