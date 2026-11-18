/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Text} from 'ink';
import type {PlanState} from '@futryn/contracts';
import {renderInk, settle} from '../../testing';
import {Plan, planWindow, activePlanLabel, usePlan} from './index';
afterEach(cleanup);
const plan: PlanState = {
  updatedAt: '2026-11-18T00:00:00Z',
  explanation: 'Implement carefully',
  items: [
    {step: 'Read', status: 'completed'},
    {step: 'Code', status: 'in_progress', activeForm: 'Coding'},
    {step: 'Test', status: 'pending'},
    {step: 'Skipped', status: 'cancelled'},
  ],
};
test('window retains running step and activeForm', () => {
  expect(activePlanLabel(plan)).toBe('Coding');
  expect(planWindow(plan, 1)).toEqual([plan.items[1]!]);
  expect(planWindow(null)).toEqual([]);
});
test('pinned checklist renders all step states and collapses settled plan', async () => {
  const view = renderInk(<Plan plan={plan} width={50} />);
  await settle();
  expect(view.lastFrame()).toContain('✓ Read');
  expect(view.lastFrame()).toContain('▸ Code');
  expect(view.lastFrame()).toContain('○ Test');
  expect(view.lastFrame()).toContain('✗ Skipped');
  view.rerender(<Plan plan={{...plan, items: plan.items.map(item => ({...item, status: 'cancelled'}))}} />);
  await settle();
  expect(view.lastFrame()).toContain('0/4 completed · cancelled steps');
  expect(view.lastFrame()).not.toContain('Code');
});
test('usePlan reads real SDK port, no request generation', async () => {
  function Harness() {
    const state = usePlan();
    return <Text>{state.activeLabel ?? 'no active plan'}</Text>;
  }
  const view = renderInk(<Harness />);
  await settle();
  expect(view.lastFrame()).toContain('no active plan');
});
