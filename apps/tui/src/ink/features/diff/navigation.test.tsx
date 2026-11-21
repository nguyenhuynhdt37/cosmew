/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import type {WorkspaceDiffReport} from '@cosmew/sdk';
import {renderInk, settle, waitForFrame} from '../../testing';
import {DiffSidePanel} from './panel';
import {Diff} from './index';
import {DiffView} from '../../ui/diff';
afterEach(cleanup);
const many: WorkspaceDiffReport = {
  workspace: '/fixture',
  gitAvailable: true,
  totalAdditions: 200,
  totalDeletions: 0,
  files: Array.from({length: 200}, (_, i) => ({
    path: `src/file-${String(i).padStart(3, '0')}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    lines: [{type: 'add', oldLine: null, newLine: 1, content: `BODY_${i}`}],
  })),
};
for (const dialog of [false, true])
  test(`${dialog ? 'dialog' : 'panel'} selection follows paging and edges through 200 files`, async () => {
    const view = renderInk(
      dialog ? <Diff report={many} width={70} isActive /> : <DiffSidePanel report={many} height={30} focused />,
    );
    await settle();
    expect(view.lastFrame()).toContain('❯ M src/file-000.ts');
    view.stdin.write('\x1b[6~');
    await settle();
    expect(view.lastFrame()).toContain('BODY_8');
    expect(view.lastFrame()).toContain('9/200');
    view.stdin.write('\x1b[5~');
    await waitForFrame(view, frame => frame.includes('❯ M src/file-000.ts'));
    view.stdin.write('G');
    await settle();
    expect(view.lastFrame()).toContain('❯ M src/file-199.ts');
    expect(view.lastFrame()).toContain('BODY_199');
    expect(view.lastFrame()).toContain('200/200');
    view.stdin.write('k');
    await settle();
    expect(view.lastFrame()).toContain('❯ M src/file-198.ts');
    view.stdin.write('g');
    await settle();
    expect(view.lastFrame()).toContain('BODY_0');
    view.stdin.write('\x1b[F');
    await waitForFrame(view, frame => frame.includes('❯ M src/file-199.ts'));
    view.stdin.write('\x1b[H');
    await waitForFrame(view, frame => frame.includes('❯ M src/file-000.ts'));
    expect(view.lastFrame()).not.toContain('opt+↓');
  });
test('300 character lines wrap with a blank gutter and no repeated sign, including wide cells', async () => {
  const content = '界😀'.repeat(75);
  const view = renderInk(<DiffView diff={`@@ -0,0 +138,1 @@\n+${content}`} width={40} />);
  await settle();
  const rows = view.lastFrame()!.split('\n');
  expect(rows[0]).toStartWith(' 138 +');
  expect(rows.slice(1).every(row => row.startsWith('      ') && !row.includes('+'))).toBe(true);
  expect(rows.every(row => Bun.stringWidth(row) <= 40)).toBe(true);
  expect(rows.join('').replace(/\s|138|\+/g, '')).toBe(content);
});

test('generated group toggles without hiding ordinary files or leaving selection offscreen', async () => {
  const report = {
    ...many,
    files: [many.files[0]!, ...many.files.slice(1, 15).map(file => ({...file, path: `tests/generated/${file.path}`}))],
  };
  const view = renderInk(<DiffSidePanel report={report} height={30} focused />);
  await settle();
  expect(view.lastFrame()).toContain('14 tests/generated (hide)');
  view.stdin.write('t');
  await settle();
  expect(view.lastFrame()).toContain('14 tests/generated (show)');
  expect(view.lastFrame()).not.toContain('tests/generated/src/');
  view.stdin.write('t');
  await settle();
  expect(view.lastFrame()).toContain('14 tests/generated (hide)');
});
test('body viewport wraps a 300 character line without mounting thousands of rows', async () => {
  const diff =
    `@@ -0,0 +1,3001 @@\n+${'x'.repeat(300)}\n` + Array.from({length: 3000}, (_, i) => `+LINE_${i}`).join('\n');
  const view = renderInk(<DiffView diff={diff} width={40} viewportRows={5} offset={2} />);
  await settle();
  expect(view.lastFrame()!.split('\n')).toHaveLength(5);
  expect(view.lastFrame()).not.toContain('+');
  expect(view.lastFrame()).not.toContain('LINE_');
  view.rerender(<DiffView diff={diff} width={40} viewportRows={5} offset={3000} />);
  await settle();
  expect(view.lastFrame()).toContain('LINE_299');
});

test('selection keeps two visible neighbours when returning toward the start', async () => {
  const view = renderInk(<DiffSidePanel report={many} height={30} focused />);
  await settle();
  view.stdin.write('\x1b[6~');
  await settle();
  view.stdin.write('\x1b[6~');
  await settle();
  view.stdin.write('k');
  await settle();
  view.stdin.write('k');
  await settle();
  expect(view.lastFrame()).toContain('❯ M src/file-014.ts');
  expect(view.lastFrame()).not.toContain('src/file-009.ts');
  expect(view.lastFrame()).toContain('↑ 11 more above');
  expect(view.lastFrame()).toContain('  M src/file-012.ts');
  expect(view.lastFrame()).toContain('  M src/file-016.ts');
  expect(view.lastFrame()).toContain('↑/k · PgUp');
});

test('wrapped diff source retains spaces and keeps joined emoji intact', async () => {
  const source = ' '.repeat(30) + '👩‍💻'.repeat(30) + ' '.repeat(32) + 'end';
  const view = renderInk(<DiffView diff={`@@ -0,0 +1,1 @@\n+${source}`} width={20} />);
  await settle();
  const rows = view.lastFrame()!.split('\n');
  expect(
    rows.map((row, i) => (row + (i < rows.length - 1 ? ' '.repeat(20 - Bun.stringWidth(row)) : '')).slice(4)).join(''),
  ).toBe(source);
  expect(rows.every(row => Bun.stringWidth(row) <= 20 && !row.endsWith('‍') && !row.slice(4).startsWith('💻'))).toBe(
    true,
  );
});

test('workspace hunk headers and the end of a large file remain reachable', async () => {
  const content = 'x'.repeat(1000);
  const file = {
    ...many.files[0]!,
    lines: [
      {type: 'hunk' as const, oldLine: null, newLine: null, content: '@@ -0,0 +1,301 @@ function original()'},
      ...Array.from({length: 301}, (_, i) => ({
        type: 'add' as const,
        oldLine: null,
        newLine: i + 1,
        content: i === 300 ? 'LAST_WORKSPACE_LINE' : content,
      })),
    ],
  };
  const view = renderInk(<DiffSidePanel report={{...many, files: [file]}} focused />);
  await settle();
  expect(view.lastFrame()).toContain('@@ -0,0 +1,301 @@ function original()');
  view.stdin.write('\r');
  await settle();
  view.stdin.write('\x1b[F');
  await settle();
  expect(view.lastFrame()).toContain('LAST_WORKSPACE_LINE');
});
