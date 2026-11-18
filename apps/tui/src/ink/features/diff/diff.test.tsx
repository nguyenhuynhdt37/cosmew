/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Text} from 'ink';
import type {ToolResult, WorkspaceDiffReport} from '@futryn/contracts';
import {renderInk, settle, createClientFixture} from '../../testing';
import {Diff, ToolDiff, changeReceipt, useDiff, workspaceUnifiedDiff} from './index';
afterEach(cleanup);
const result: ToolResult = {
  callId: 'x',
  name: 'edit',
  status: 'ok',
  content: JSON.stringify({
    changes: [{path: 'a.ts', action: 'update', diff: '@@ -7,1 +7,1 @@\n-old\n+new'}],
    diagnostics: ['a.ts:7 TS2322: incompatible type'],
  }),
};
const report: WorkspaceDiffReport = {
  workspace: '/w',
  gitAvailable: true,
  files: [
    {
      path: 'a.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      layer: 'unstaged',
      lines: [
        {type: 'del', oldLine: 7, newLine: null, content: 'old'},
        {type: 'add', oldLine: null, newLine: 7, content: 'new'},
      ],
    },
    {
      path: 'b.ts',
      status: 'added',
      layer: 'staged',
      additions: 1,
      deletions: 0,
      lines: [{type: 'add', oldLine: null, newLine: 1, content: 'other'}],
    },
  ],
  totalAdditions: 2,
  totalDeletions: 1,
};
test('receipts require success or PARTIAL_APPLY; never claim denied proposals applied', () => {
  expect(changeReceipt({...result, status: 'denied'}).changes).toEqual([]);
  expect(changeReceipt({...result, status: 'error', code: 'ERROR'}).changes).toEqual([]);
  expect(changeReceipt({...result, status: 'error', code: 'PARTIAL_APPLY'})).toMatchObject({
    partial: true,
    changes: [{path: 'a.ts', action: 'update', diff: '@@ -7,1 +7,1 @@\n-old\n+new'}],
  });
  expect(changeReceipt({...result, content: '{invalid'}).changes).toEqual([]);
  expect(workspaceUnifiedDiff(report.files[0]!)).toBe('-old\n+new');
});
test('applied diff includes line numbers, diagnostics, no ANSI on no-color terminal', async () => {
  const view = renderInk(<ToolDiff result={result} width={60} />);
  await settle();
  expect(view.lastFrame()).toContain('a.ts · update · applied diff');
  expect(view.lastFrame()).toContain('7');
  expect(view.lastFrame()).toContain('-old');
  expect(view.lastFrame()).toContain('+new');
  expect(view.lastFrame()).toContain('TS2322');
  expect(view.lastFrame()).not.toContain('\u001b[');
});
test('denial and partial failure retain truthful outcomes', async () => {
  const view = renderInk(<ToolDiff result={{...result, status: 'denied', content: 'Permission refused'}} />);
  await settle();
  expect(view.lastFrame()).toContain('Permission refused');
  expect(view.lastFrame()).not.toContain('applied diff');
  view.rerender(
    <ToolDiff
      result={{
        ...result,
        status: 'error',
        code: 'PARTIAL_APPLY',
        content: JSON.stringify({changes: [], remaining: ['b.ts'], failureCode: 'WRITE_FAILED'}),
      }}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('Partially applied');
  expect(view.lastFrame()).toContain('Not applied: b.ts');
});
test('workspace view filters layers, changes file, refreshes and copies through callbacks', async () => {
  let refreshed = 0;
  let copied = '';
  const view = renderInk(
    <Diff
      report={report}
      isActive
      width={70}
      onRefresh={() => refreshed++}
      onCopy={text => {
        copied = text;
      }}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('a.ts');
  view.stdin.write('\u001b[C');
  await settle();
  expect(view.lastFrame()).toContain('b.ts');
  view.stdin.write('c');
  await settle();
  expect(copied).toContain('b.ts\n+other');
  view.stdin.write('u');
  await settle();
  expect(view.lastFrame()).toContain('1 files +1 -1');
  expect(view.lastFrame()).toContain('a.ts');
  view.stdin.write('r');
  await settle();
  expect(refreshed).toBe(1);
});
test('unavailable backend is explicit and hook refresh errors stay visible', async () => {
  let state: ReturnType<typeof useDiff> | undefined;
  function Harness() {
    state = useDiff();
    return (
      <Text>
        {state.report.message} {state.error}
      </Text>
    );
  }
  const fixture = createClientFixture();
  fixture.client.setToolsEnabled(true);
  const view = renderInk(<Harness />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('Workspace diff unavailable');
  await state!.refresh();
  await settle();
  expect(view.lastFrame()).toContain('refresh failed');
});
