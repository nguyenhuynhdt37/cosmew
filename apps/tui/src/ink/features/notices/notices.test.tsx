/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {Notices, useNotices, compactionNotice, subagentNotice, backgroundCommandNotice, hookNotice} from './index';
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

test('background command completion reads like the reference and failures stay distinct', async () => {
  const done = backgroundCommandNotice('Sleep for 40 seconds', 0);
  const failed = backgroundCommandNotice('Run tests', 2);
  expect(done).toMatchObject({kind: 'event', ok: true});
  expect(failed).toMatchObject({kind: 'event', ok: false});
  const view = renderInk(
    <Notices
      notices={[done, failed, {id: 'n', text: 'Context compacted'}, {id: 'h', text: hookNotice('Setup', 'ready')}]}
      width={100}
    />,
  );
  await settle();
  const lines = view.lastFrame()!.split('\n');
  expect(lines[0]).toBe('⏺ Background command "Sleep for 40 seconds" completed (exit code 0)');
  expect(lines[1]).toBe('⏺ Background command "Run tests" failed with exit code 2');
  // Out-of-turn notes hang off the `⎿` connector (hooks use `⎿  <Name> says: …`).
  expect(lines[2]).toBe('  ⎿  Context compacted');
  expect(lines[3]).toBe('  ⎿  Setup says: ready');
  expect(backgroundCommandNotice('x\x1b[31m', 0).text).not.toContain('\x1b');
});
