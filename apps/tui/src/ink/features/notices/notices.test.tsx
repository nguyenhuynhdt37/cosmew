/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {Notices, useNotices, compactionNotice, subagentNotice} from './index';
afterEach(cleanup);
test('notices describe fallback and actual background delivery', () => {
  expect(
    compactionNotice({
      type: 'context.compacted',
      trigger: 'manual',
      strategy: 'excerpt',
      tokensBefore: 100,
      tokensAfter: 20,
      fallback: true,
    }),
  ).toContain('model summary failed');
  expect(
    subagentNotice({
      agentId: 'c',
      parentSessionId: 'p',
      agentType: 'worker',
      description: 'task',
      status: 'cancelled',
      delivery: 'queued',
    }),
  ).toContain('cancelled · queued');
});
test('bounded hook and muted rendering strip terminal controls', async () => {
  let state: ReturnType<typeof useNotices> | undefined;
  function Harness() {
    state = useNotices(2);
    return <Notices notices={state.notices} width={60} />;
  }
  const view = renderInk(<Harness />);
  await settle();
  state!.addNotice('first');
  state!.addNotice('second');
  state!.addNotice('\u001b[31mthird');
  await settle();
  expect(state!.notices).toHaveLength(2);
  expect(view.lastFrame()).not.toContain('first');
  expect(view.lastFrame()).toContain('third');
  expect(view.lastFrame()).not.toContain('\u001b[');
  state!.clearNotices();
  await settle();
  expect(state!.notices).toEqual([]);
});
