/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Text} from 'ink';
import type {ToolResult, WorkspaceDiffReport} from '@cosmew/contracts';
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
  expect(view.lastFrame()).toContain(' 7 -old');
  expect(view.lastFrame()).toContain(' 7 +new');
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
  expect(view.lastFrame()).toContain(state!.error!);
  expect(state!.error).toBeTruthy();
});

test('diff gutters track independent old/new line numbers and source resembling headers', async () => {
  const {parseUnifiedDiff} = await import('../../ui/diff');
  const rows = parseUnifiedDiff('--- a\n+++ b\n@@ -8,2 +12,2 @@\n---source\n+++source\n keep');
  expect(rows.filter(row => row.kind === 'removed')).toEqual([{kind: 'removed', text: '---source', oldLine: 8}]);
  expect(rows.filter(row => row.kind === 'added')).toEqual([{kind: 'added', text: '+++source', newLine: 12}]);
  expect(rows.at(-1)).toEqual({kind: 'context', text: ' keep', oldLine: 9, newLine: 13});
});

test.skipIf(process.env.FORCE_COLOR !== '3')(
  'colour terminal paints distinct add and remove diff backgrounds',
  async () => {
    const {ThemeEngine} = await import('../../../theme/theme');
    const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
    const view = renderInk(<ToolDiff result={result} width={60} />, {themeEngine: engine});
    await settle();
    const backgrounds = [...view.lastFrame()!.matchAll(/\x1b\[48;2;[\d;]+m/g)].map(match => match[0]);
    expect(new Set(backgrounds).size).toBe(2);
    view.rerender(<Diff report={report} width={60} />);
    await settle();
    expect(view.lastFrame()).toContain(backgrounds[0]!);
    expect(view.lastFrame()).toContain(backgrounds[1]!);
  },
);

test('DiffView: signed rows with a gutter sized to the widest number, wrapping and truncation', async () => {
  const {DiffView, diffSummary, diffStats} = await import('../../ui/diff');
  const diff = '@@ -9,3 +9,3 @@\n keep\n-hello\n+HELLO world that is long enough to wrap\n tail';
  const view = renderInk(<DiffView diff={diff} width={20} />);
  await settle();
  expect(
    view
      .lastFrame()!
      .split('\n')
      .map(line => line.trimEnd()),
  ).toEqual(['  9  keep', ' 10 -hello', ' 10 +HELLO world', '     that is long', '     enough to wrap', ' 11  tail']);
  view.rerender(<DiffView diff={diff} width={40} maxLines={2} />);
  await settle();
  expect(view.lastFrame()).toContain('… +2 lines');
  view.rerender(<DiffView diff={'@@ -0,0 +1,2 @@\n+one\n+two'} width={20} variant="new" />);
  await settle();
  expect(
    view
      .lastFrame()!
      .split('\n')
      .map(line => line.trimEnd()),
  ).toEqual([' 1 one', ' 2 two']);
  expect(diffSummary(diffStats('@@ -1 +1,2 @@\n-a\n+b\n+c'))).toBe('Added 2 lines, removed 1 line');
  expect(diffSummary({added: 0, removed: 3})).toBe('Removed 3 lines');
  expect(diffSummary({added: 1, removed: 0})).toBe('Added 1 line');
});

test('late refresh of an old base cannot replace the selected comparison', async () => {
  let state!: ReturnType<typeof useDiff>;
  const complete = new Map<string, (value: WorkspaceDiffReport) => void>();
  const fixture = createClientFixture({
    getWorkspaceDiff: options => ({...report, base: options?.base ?? 'session'}),
    refreshWorkspaceDiff: options =>
      new Promise(resolve => {
        complete.set(options?.base ?? 'session', resolve);
      }),
  });
  fixture.client.setToolsEnabled(true);
  function Harness() {
    state = useDiff();
    return <Text>{state.report.base}</Text>;
  }
  const view = renderInk(<Harness />, {fixture});
  await settle();
  const old = state.refresh('uncommitted');
  const next = state.refresh('branch');
  complete.get('branch')!({...report, base: 'branch'});
  await next;
  await settle();
  expect(view.lastFrame()).toContain('branch');
  complete.get('uncommitted')!({...report, base: 'uncommitted'});
  await old;
  await settle();
  expect(view.lastFrame()).toContain('branch');
  expect(view.lastFrame()).not.toContain('uncommitted');
});

test('mount before consent, enable tools, and open the panel reads the current SDK report', async () => {
  let state!: ReturnType<typeof useDiff>;
  const fixture = createClientFixture({getWorkspaceDiff: () => ({...report, state: 'ready', base: 'session'})});
  function Harness({open = false}: {open?: boolean}) {
    state = useDiff();
    return open ? <Diff report={state.report} width={120} /> : <Text>{state.report.message}</Text>;
  }
  const view = renderInk(<Harness />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('Folder consent required.');
  // Opening before the startup effect runs captures the SDK consent report.
  const opening = state.refresh();
  fixture.client.setToolsEnabled(true);
  await opening;
  view.rerender(<Harness open />);
  await settle();
  expect(view.lastFrame()).toContain('a.ts');
  expect(view.lastFrame()).not.toContain('Folder consent required.');
});

test('default source shows uncommitted changes when the session baseline is empty', async () => {
  let state!: ReturnType<typeof useDiff>;
  const fixture = createClientFixture({
    getWorkspaceDiff: options => ({
      ...report,
      base: options?.base,
      files: options?.base === 'session' ? [] : report.files,
    }),
  });
  fixture.client.setToolsEnabled(true);
  function Harness() {
    state = useDiff();
    return <Diff report={state.report} width={120} />;
  }
  const view = renderInk(<Harness />, {fixture});
  await settle();
  await state.refresh();
  await settle();
  expect(state.report.base).toBe('uncommitted');
  expect(view.lastFrame()).toContain('a.ts');
});

test('consent revocation hides files and re-enabling refreshes without reopening', async () => {
  let state!: ReturnType<typeof useDiff>;
  let current = {...report, base: 'uncommitted' as const};
  const fixture = createClientFixture({getWorkspaceDiff: () => current});
  function Harness() {
    state = useDiff(true);
    return <Diff report={state.report} width={120} />;
  }
  fixture.client.setToolsEnabled(true);
  const view = renderInk(<Harness />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('a.ts');
  fixture.client.setToolsEnabled(false);
  await settle();
  expect(view.lastFrame()).toContain('Folder consent required.');
  expect(view.lastFrame()).not.toContain('a.ts');
  current = {...current, files: [], totalAdditions: 0, totalDeletions: 0};
  fixture.client.setToolsEnabled(true);
  await settle();
  expect(view.lastFrame()).toContain('No changes');
  expect(view.lastFrame()).not.toContain('Folder consent required.');
});

test('opening refreshes even when mounted while tools were disabled', async () => {
  let cached: WorkspaceDiffReport = {...report, files: [], message: 'Not inspected.'};
  const fixture = createClientFixture({
    getWorkspaceDiff: () => cached,
    refreshWorkspaceDiff: async options => (cached = {...report, base: options?.base}),
  });
  function Harness({open = false}: {open?: boolean}) {
    const state = useDiff(open);
    return open ? <Diff report={state.report} width={120} /> : <Text>{state.report.message}</Text>;
  }
  const view = renderInk(<Harness />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('Folder consent required.');
  fixture.client.setToolsEnabled(true);
  view.rerender(<Harness open />);
  await settle();
  expect(view.lastFrame()).toContain('a.ts');
  // A subsequent open must inspect again, including external working-tree edits.
  view.rerender(<Harness />);
  await settle();
  cached = {...report, files: [], message: 'No changes', totalAdditions: 0, totalDeletions: 0};
  fixture.ports.refreshWorkspaceDiff = async options => ({...cached, base: options?.base});
  view.rerender(<Harness open />);
  await settle();
  expect(view.lastFrame()).toContain('No changes');
  expect(view.lastFrame()).not.toContain('a.ts');
});

test('session changes reset the source, re-read the baseline, and discard the previous session refresh', async () => {
  let state!: ReturnType<typeof useDiff>;
  let baseline = report;
  let finish!: (value: WorkspaceDiffReport) => void;
  const selection = {accountId: '11111111-1111-4111-8111-111111111111', modelId: 'fixture'};
  const fixture = createClientFixture({
    resolveSelection: () => selection,
    startSession: () => ({id: 'new-session', selection, messages: []}),
    getWorkspaceDiff: options => ({...baseline, base: options?.base}),
    refreshWorkspaceDiff: options =>
      options?.base === 'branch'
        ? new Promise(resolve => {
            finish = resolve;
          })
        : Promise.resolve({...baseline, base: options?.base}),
  });
  fixture.client.setToolsEnabled(true);
  function Harness() {
    state = useDiff();
    return <Diff report={state.report} width={120} />;
  }
  const view = renderInk(<Harness />, {fixture});
  await settle();
  const old = state.refresh('branch');
  baseline = {...report, files: [], totalAdditions: 0, totalDeletions: 0};
  fixture.client.createSession();
  await settle();
  expect(state.report.base).toBe('uncommitted');
  expect(view.lastFrame()).toContain('No changes');
  finish({...report, base: 'branch'});
  await old;
  await settle();
  expect(view.lastFrame()).not.toContain('a.ts');
  expect(state.report.base).toBe('uncommitted');
});

test('a failed open refresh shows a reason in the panel body', async () => {
  const fixture = createClientFixture({
    getWorkspaceDiff: () => ({...report, files: []}),
    refreshWorkspaceDiff: async () => {
      throw new Error('unavailable');
    },
  });
  fixture.client.setToolsEnabled(true);
  function Harness() {
    const state = useDiff(true);
    return <Diff report={state.report} width={120} />;
  }
  const view = renderInk(<Harness />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('unavailable');
});

test('hidden diff invalidates a session change without starting a competing review refresh', async () => {
  let refreshes = 0;
  const fixture = createClientFixture({
    resumeSession: () => ({id: 'old-session', selection: {accountId: 'account', modelId: 'model'}, messages: []}),
    getWorkspaceDiff: () => report,
    refreshWorkspaceDiff: async () => {
      refreshes++;
      return report;
    },
  });
  fixture.client.setToolsEnabled(true);
  fixture.client.resumeSession('old-session');
  function Harness() {
    const state = useDiff(false);
    return <Text>{state.report.files.length}</Text>;
  }
  renderInk(<Harness />, {fixture});
  await settle();
  fixture.client.clearSessionView();
  await settle();
  expect(refreshes).toBe(0);
});

test('source refresh retains inspected capabilities and source until the next source is ready', async () => {
  let state!: ReturnType<typeof useDiff>;
  let finish!: (value: WorkspaceDiffReport) => void;
  const inspected: WorkspaceDiffReport = {
    ...report,
    base: 'uncommitted',
    capabilities: {
      session: {available: false, reason: 'No session'},
      uncommitted: {available: true},
      branch: {available: true},
    },
  };
  const fixture = createClientFixture({
    getWorkspaceDiff: options =>
      options?.base === 'branch' ? {...report, base: 'branch', files: [], message: 'Diff not loaded.'} : inspected,
    refreshWorkspaceDiff: () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  });
  fixture.client.setToolsEnabled(true);
  function Harness() {
    state = useDiff();
    return <Diff report={state.report} width={120} />;
  }
  renderInk(<Harness />, {fixture});
  await settle();
  const pending = state.refresh('branch');
  fixture.client.updateAppearance({animations: {enabled: false}});
  await settle();
  expect(state.report.base).toBe('uncommitted');
  expect(state.report.capabilities).toEqual(inspected.capabilities);
  finish({...inspected, base: 'branch'});
  await pending;
  await settle();
  expect(state.report.base).toBe('branch');
});

test('an uncached source shows loading during inspection and retains the uncommitted default', async () => {
  let state!: ReturnType<typeof useDiff>;
  let finish!: (value: WorkspaceDiffReport) => void;
  const fixture = createClientFixture({
    getWorkspaceDiff: options => ({...report, files: [], base: options?.base, message: 'Diff not loaded.'}),
    refreshWorkspaceDiff: () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  });
  fixture.client.setToolsEnabled(true);
  function Harness() {
    state = useDiff();
    return <Diff report={state.report} width={120} />;
  }
  const view = renderInk(<Harness />, {fixture});
  await settle();
  const pending = state.refresh();
  await settle();
  expect(view.lastFrame()).toContain('Loading diff…');
  expect(state.report.base).toBe('uncommitted');
  finish({...report, base: 'uncommitted'});
  await pending;
});
