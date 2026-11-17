import type {PlanItem} from '@futryn/contracts';

/** One line of the pinned plan checklist (ADR 0042). */
export interface PlanRow {
  kind: 'summary' | 'item';
  text: string;
  status: PlanItem['status'];
}
