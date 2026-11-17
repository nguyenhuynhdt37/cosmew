import type {PlanItem, PlanState} from '@futryn/contracts';
import type {PlanRow} from './types';

/** Glyphs of the pinned checklist (ADR 0042): ✓ completed, ▸ in progress, ○ pending, ✗ cancelled. */
export const PLAN_GLYPHS: Record<PlanItem['status'], string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○',
  cancelled: '✗',
};

const settled = (item: PlanItem) => item.status === 'completed' || item.status === 'cancelled';

/** The running step's present-continuous label, shown next to the spinner. */
export function activePlanLabel(plan: PlanState | null): string | null {
  const running = plan?.items.find(item => item.status === 'in_progress');
  return running ? (running.activeForm ?? running.step) : null;
}

/**
 * Rows of the checklist pinned above the composer: at most `maxRows`, keeping the running step
 * visible; once every step is settled it collapses to one summary line. Nothing for an empty plan.
 */
export function planRows(plan: PlanState | null, maxRows: number): PlanRow[] {
  if (!plan || !plan.items.length || maxRows < 1) return [];
  const done = plan.items.filter(item => item.status === 'completed').length;
  if (plan.items.every(settled))
    return [{kind: 'summary', text: `Plan · ${done}/${plan.items.length} completed`, status: 'completed'}];
  const header: PlanRow = {kind: 'summary', text: `Plan · ${done}/${plan.items.length} completed`, status: 'pending'};
  const items: PlanRow[] = plan.items.map(item => ({
    kind: 'item',
    text: `${PLAN_GLYPHS[item.status]} ${item.step}`,
    status: item.status,
  }));
  const room = Math.max(0, maxRows - 1);
  if (items.length <= room) return [header, ...items];
  // Window around the running step (or the first unsettled one).
  const focus = Math.max(
    0,
    plan.items.findIndex(item => item.status === 'in_progress') >= 0
      ? plan.items.findIndex(item => item.status === 'in_progress')
      : plan.items.findIndex(item => !settled(item)),
  );
  const start = Math.min(Math.max(0, focus - Math.floor(room / 2)), Math.max(0, items.length - room));
  return [header, ...items.slice(start, start + room)];
}
