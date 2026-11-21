/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Text} from 'ink';
import type {PlanState} from '@cosmew/contracts';
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
  expect(view.lastFrame()).toContain('☒ Read');
  expect(view.lastFrame()).toContain('☐ Code');
  expect(view.lastFrame()).toContain('☐ Test');
  expect(view.lastFrame()).toContain('☒ Skipped');
  view.rerender(<Plan plan={{...plan, items: plan.items.map(item => ({...item, status: 'cancelled'}))}} />);
  await settle();
  expect(view.lastFrame()).not.toContain('[----------]');
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

test('todo visibility hook toggles independently of durable SDK plan state', async () => {
  const {useTodoVisibility} = await import('./index');
  let visibility: ReturnType<typeof useTodoVisibility>;
  function Harness() {
    visibility = useTodoVisibility();
    return visibility.todosVisible ? <Plan plan={plan} /> : <Text>hidden</Text>;
  }
  const view = renderInk(<Harness />);
  await settle();
  expect(view.lastFrame()).toContain('☐ Code');
  visibility!.toggleTodos();
  await settle();
  expect(view.lastFrame()).toBe('hidden');
  visibility!.toggleTodos();
  await settle();
  expect(view.lastFrame()).toContain('☒ Read');
  expect(plan.items[1]?.status).toBe('in_progress');
});

test('checklist hangs off the ⎿ connector: ☐ pending/in progress, ☒ done, continuation rows stay aligned', async () => {
  const view = renderInk(
    <Plan
      plan={{
        updatedAt: '2026-11-18T00:00:00Z',
        items: [
          {step: 'alpha', status: 'completed'},
          {step: 'beta step that is long enough to wrap onto a second row', status: 'in_progress'},
          {step: 'gamma', status: 'pending'},
        ],
      }}
      width={30}
    />,
  );
  await settle();
  const lines = view.lastFrame()!.split('\n');
  expect(lines[0]).toBe('  ⎿  ☒ alpha');
  expect(lines[1]).toBe('     ☐ beta step that is long');
  expect(lines[2]).toMatch(/^ {5}\S/);
  expect(lines.at(-1)).toBe('     ☐ gamma');
});
