/** @jsxImportSource react */
import {useCallback, useState} from 'react';
import {Box, Text} from 'ink';
import type {PlanState, PlanItem} from '@cosmew/contracts';
import {useEvents, useFutrynClient} from '../../hooks';
import {useTheme} from '../../theme';
import {ResultLine, safeText} from '../../ui';
export const PLAN_GLYPHS: Record<PlanItem['status'], string> = {
  completed: '☒',
  in_progress: '☐',
  pending: '☐',
  cancelled: '☒',
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
  const visibility = useTodoVisibility();
  return {plan, activeLabel: activePlanLabel(plan), ...visibility};
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
      {settled && !expanded ? (
        <ResultLine width={width}>
          <Text
            color={color('foregroundMuted')}
          >{`${done}/${plan.items.length} completed${done !== plan.items.length ? ' · cancelled steps' : ''}`}</Text>
        </ResultLine>
      ) : null}
      {items.length ? (
        <ResultLine width={width}>
          <TodoItems items={items} width={width === undefined ? undefined : Math.max(1, width - 5)} />
        </ResultLine>
      ) : null}
      {items.length > 0 && items.length < plan.items.length ? (
        <Text color={color('foregroundMuted')}>{`     … +${plan.items.length - items.length} other steps`}</Text>
      ) : null}
    </Box>
  );
}
/** Host binds toggleTodos to Ctrl+T, respecting overlay input ownership. */
export function useTodoVisibility(initial = true) {
  const [todosVisible, setVisible] = useState(initial);
  return {todosVisible, toggleTodos: useCallback(() => setVisible(value => !value), [])};
}
export function todosFromInput(input: unknown): PlanItem[] {
  if (!input || typeof input !== 'object' || !('plan' in input) || !Array.isArray(input.plan)) return [];
  return input.plan
    .filter(
      (item): item is PlanItem =>
        !!item &&
        typeof item === 'object' &&
        typeof item.step === 'string' &&
        ['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status),
    )
    .slice(0, 50);
}
export function TodoItems({items, width}: {items: readonly PlanItem[]; width?: number}) {
  return (
    <Box width={width} flexDirection="column" minWidth={0}>
      {items.map((item, index) => (
        <Text
          key={index}
          bold={item.status === 'in_progress'}
          dimColor={item.status === 'completed' || item.status === 'cancelled'}
          strikethrough={item.status === 'completed' || item.status === 'cancelled'}
        >
          {PLAN_GLYPHS[item.status]} {safeText(item.step)}
        </Text>
      ))}
    </Box>
  );
}
