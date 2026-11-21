/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {readFileSync} from 'node:fs';
import type {WorkspaceDiffReport} from '@cosmew/contracts';
import {renderInk, settle} from '../../testing';
import {DiffSidePanel, diffPanelLayout, workspaceViewDiff, DIFF_BASE_UNSUPPORTED} from './panel';
import {parseUnifiedDiff} from '../../ui/diff';
afterEach(cleanup);
const report: WorkspaceDiffReport = {
  workspace: '/w',
  gitAvailable: true,
  state: 'ready',
  totalAdditions: 1,
  totalDeletions: 1,
  files: [
    {
      path: 'a.txt',
      status: 'modified',
      additions: 1,
      deletions: 1,
      lines: [
        {type: 'del', oldLine: 7, newLine: null, content: 'hello'},
        {type: 'add', oldLine: null, newLine: 12, content: 'HELLO'},
        {type: 'context', oldLine: 8, newLine: 13, content: 'world'},
      ],
    },
    {
      path: 'b.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
      lines: [{type: 'add', oldLine: null, newLine: 1, content: 'next file'}],
    },
  ],
};
test('responsive pane reserves 52 body columns only from 110 columns upward', () => {
  expect(diffPanelLayout(109, true)).toEqual({visible: false, mainWidth: 109, panelWidth: 0});
  expect(diffPanelLayout(110, true)).toEqual({visible: true, mainWidth: 56, panelWidth: 54});
  expect(diffPanelLayout(120, true).mainWidth).toBe(66);
  expect(diffPanelLayout(120, false)).toEqual({visible: false, mainWidth: 120, panelWidth: 0});
});
test('reconstructed diff retains SDK old/new numbers across hunks', () => {
  const file = report.files[0]!;
  const rows = parseUnifiedDiff(
    workspaceViewDiff({...file, lines: [...file.lines, {type: 'add', oldLine: null, newLine: 50, content: 'later'}]}),
  );
  expect(rows.find(row => row.kind === 'removed')?.oldLine).toBe(7);
  expect(rows.find(row => row.kind === 'added')?.newLine).toBe(12);
  expect(rows.at(-1)?.newLine).toBe(50);
});
test('pane renders reference structure, SDK rows, modified keys and truthful unsupported bases', async () => {
  let notice = '';
  const view = renderInk(
    <DiffSidePanel
      report={report}
      height={24}
      onNotice={text => {
        notice = text;
      }}
    />,
  );
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('source: Current');
  expect(frame).toContain('[ ask ]');
  expect(frame).toContain('7 -hello');
  expect(frame).toContain('12 +HELLO');
  expect(frame).not.toContain('\x1b[');
  expect(frame.split('\n')).toHaveLength(24);
  view.stdin.write('\x1b[1;5B');
  await settle();
  expect(view.lastFrame()).toContain('next file');
  view.stdin.write('\x18');
  view.stdin.write('b');
  await settle();
  expect(notice).toBe(DIFF_BASE_UNSUPPORTED);
  expect(view.lastFrame()).toContain('bases unavailable in SDK');
  expect(view.lastFrame()).toContain('source: Current');
});
test('shrinking reports clamps stale file selection and small panes retain their bounds', async () => {
  const view = renderInk(<DiffSidePanel report={report} height={12} />);
  await settle();
  view.stdin.write('\x1b[1;5B');
  await settle();
  view.rerender(<DiffSidePanel report={{...report, files: [], message: 'Git access denied'}} height={12} />);
  await settle();
  expect(view.lastFrame()).toContain('Git access denied');
  expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(12);
});
test('focused paging reaches the last row and clamps repeated page-down; inactive pane ignores keys', async () => {
  const longReport = {
    ...report,
    files: [
      {
        ...report.files[0]!,
        lines: Array.from({length: 50}, (_, at) => ({
          type: 'add' as const,
          oldLine: null,
          newLine: at + 1,
          content: `row-${at + 1}`,
        })),
      },
    ],
  };
  const view = renderInk(<DiffSidePanel report={longReport} height={18} focused />);
  await settle();
  expect(view.lastFrame()).toContain('row-1');
  expect(view.lastFrame()).not.toContain('row-50');
  view.stdin.write('G');
  await settle();
  expect(view.lastFrame()).toContain('row-50');
  view.stdin.write('\x1b[6~');
  await settle();
  expect(view.lastFrame()).toContain('row-50');
  view.stdin.write('g');
  await settle();
  expect(view.lastFrame()).toContain('row-1');
  view.rerender(<DiffSidePanel report={report} height={18} isActive={false} />);
  await settle();
  view.stdin.write('\x1b[1;5B');
  await settle();
  expect(view.lastFrame()).not.toContain('next file');
});
test('Enter opens the file, Esc returns to the list before closing, and source arrows report unsupported', async () => {
  let closed = 0;
  let notice = '';
  const view = renderInk(
    <DiffSidePanel
      report={report}
      focused
      height={24}
      onClose={() => {
        closed++;
      }}
      onNotice={text => {
        notice = text;
      }}
    />,
  );
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).not.toContain('b.txt');
  view.stdin.write('\x1b');
  await settle();
  expect(closed).toBe(0);
  expect(view.lastFrame()).toContain('b.txt');
  view.stdin.write('\x1b[C');
  await settle();
  expect(notice).toBe(DIFF_BASE_UNSUPPORTED);
  expect(view.lastFrame()).toContain('source: Current');
  view.stdin.write('\x1b');
  await settle();
  expect(closed).toBe(1);
});
test.skipIf(process.env.FORCE_COLOR !== '3')('panel and diff backgrounds follow light/dark tokens', async () => {
  const {ThemeEngine} = await import('../../../theme/theme');
  type Run = [number, number, string, string, boolean, boolean, boolean, string];
  const runs = (name: string) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../../../../docs/delivery/tui-v4/reference/live-120x36/${name}.colors.json`, import.meta.url),
          'utf8',
        ),
      ) as [number, Run[]][]
    ).flatMap(([, rows]) => rows);
  const light = runs('L02-edit-done');
  const dark = runs('L10-diff');
  const ansi = (hex: string) =>
    `\x1b[48;2;${[0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')}m`;
  const lightPanel = light.find(run => run[7].includes('source: Current'))![3];
  const lightAdd = light.find(run => /1 \+/.test(run[7]))![3];
  const lightRemove = light.find(run => /1 -/.test(run[7]))![3];
  const darkAdd = dark.find(run => /1 \+/.test(run[7]))![3];
  for (const dark of [false, true]) {
    const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: dark});
    const view = renderInk(<DiffSidePanel report={report} height={24} />, {themeEngine: engine});
    await settle();
    const frame = view.lastFrame()!;
    expect(frame).toContain(dark ? '\x1b[48;2;38;38;38m' : ansi(lightPanel));
    expect(frame).toContain(ansi(dark ? darkAdd : lightAdd));
    expect(frame).toContain(dark ? '\x1b[48;2;122;41;54m' : ansi(lightRemove));
    view.unmount();
  }
});

test('Ctrl+X B cycles real comparison bases and skips unavailable bases with their reason', async () => {
  let selected = 'session',
    notice = '';
  const supported = {
    ...report,
    base: 'session' as const,
    capabilities: {
      session: {available: true},
      uncommitted: {available: true},
      branch: {available: false, reason: 'Detached HEAD'},
    },
  };
  const change = (base: string) => {
    selected = base;
  };
  const view = renderInk(
    <DiffSidePanel
      report={supported}
      onChangeBase={change}
      onNotice={text => {
        notice = text;
      }}
    />,
  );
  await settle();
  view.stdin.write('\x18');
  view.stdin.write('b');
  await settle();
  expect(selected).toBe('uncommitted');
  view.rerender(
    <DiffSidePanel
      report={{...supported, base: 'uncommitted'}}
      onChangeBase={change}
      onNotice={text => {
        notice = text;
      }}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('source: Uncommitted');
  view.stdin.write('\x18');
  view.stdin.write('b');
  await settle();
  expect(selected).toBe('session');
  expect(notice).toContain('Branch unavailable: Detached HEAD');
  expect(view.lastFrame()).toContain('Branch unavailable');
  view.rerender(
    <DiffSidePanel
      report={{...supported, base: 'branch', capabilities: {...supported.capabilities, branch: {available: true}}}}
      onChangeBase={change}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('source: Branch');
});

test('mode-only file changes show metadata in the side panel', async () => {
  const view = renderInk(
    <DiffSidePanel
      report={{
        ...report,
        files: [
          {
            ...report.files[0]!,
            additions: 0,
            deletions: 0,
            lines: [
              {type: 'hunk', oldLine: null, newLine: null, content: 'old mode 100644'},
              {type: 'hunk', oldLine: null, newLine: null, content: 'new mode 100755'},
            ],
          },
        ],
      }}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('old mode 100644');
  expect(view.lastFrame()).toContain('new mode 100755');
});
