/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {useState} from 'react';
import {Box} from 'ink';
import {cleanup} from 'ink-testing-library';
import type {WorkspaceDiffReport} from '@cosmew/sdk';
import type {TerminalMouseEvent, TerminalMouseInput} from '../../../input/mouse-input';
import {TerminalMouseProvider} from '../../hooks/use-terminal-wheel';
import {renderInk, settle} from '../../testing';
import {DiffSidePanel} from './panel';
import {Diff} from './index';
afterEach(cleanup);
const report: WorkspaceDiffReport = {
  workspace: '/fixture',
  gitAvailable: true,
  base: 'uncommitted',
  capabilities: {session: {available: true}, uncommitted: {available: true}, branch: {available: true}},
  files: ['first.ts', 'second.ts'].map(path => ({
    path,
    status: 'modified',
    additions: 60,
    deletions: 0,
    lines: Array.from({length: 60}, (_, at) => ({
      type: 'add' as const,
      oldLine: null,
      newLine: at + 1,
      content: `${path}-row-${at + 1}`,
    })),
  })),
  totalAdditions: 120,
  totalDeletions: 0,
};
function source() {
  const listeners = new Set<(event: TerminalMouseEvent) => void>();
  const mouse: TerminalMouseInput = {
    stdin: {} as TerminalMouseInput['stdin'],
    subscribe: () => () => {},
    subscribeMouse: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
    },
  };
  return {
    mouse,
    async emit(event: TerminalMouseEvent) {
      for (const handler of [...listeners]) handler(event);
      await settle();
    },
  };
}
test('panel click selects files, source cycles, wheel scrolls only inside and close works', async () => {
  const input = source();
  let closed = 0;
  function Harness() {
    const [base, setBase] = useState(report.base);
    return (
      <Box width={140}>
        <Box width={86} />
        <DiffSidePanel report={{...report, base}} height={24} onChangeBase={setBase} onClose={() => closed++} />
      </Box>
    );
  }
  const view = renderInk(
    <TerminalMouseProvider value={input.mouse}>
      <Harness />
    </TerminalMouseProvider>,
  );
  await settle();
  await input.emit({kind: 'click', column: 95, row: 5});
  expect(view.lastFrame()).toContain('second.ts-row-1');
  await input.emit({direction: 1, column: 20, row: 12});
  expect(view.lastFrame()).toContain('second.ts-row-1');
  await input.emit({direction: 1, column: 95, row: 12});
  expect(view.lastFrame()).not.toContain('second.ts-row-1\n');
  expect(view.lastFrame()).toContain('second.ts-row-4');
  await input.emit({kind: 'click', column: 120, row: 2});
  expect(view.lastFrame()).toContain('source: Branch');
  await input.emit({kind: 'click', column: 139, row: 1});
  expect(closed).toBe(1);
});
test('dialog click selects a file and detail arrows scroll instead of changing files', async () => {
  const input = source();
  const view = renderInk(
    <TerminalMouseProvider value={input.mouse}>
      <Diff report={report} isActive maxLines={4} width={70} />
    </TerminalMouseProvider>,
  );
  await settle();
  await input.emit({kind: 'click', column: 4, row: 3});
  expect(view.lastFrame()).toContain('2/2 second.ts');
  view.stdin.write('\r');
  await settle();
  view.stdin.write('\x1b[B');
  await settle();
  expect(view.lastFrame()).toContain('2/2 second.ts');
  expect(view.lastFrame()).toContain('second.ts-row-2');
  await input.emit({direction: 1, column: 4, row: 4});
  expect(view.lastFrame()).toContain('second.ts-row-5');
});

test('200-file list wheel follows selection; body wheel never changes the selected file', async () => {
  const input = source();
  const many: WorkspaceDiffReport = {
    ...report,
    files: Array.from({length: 200}, (_, i) => ({
      ...report.files[0]!,
      path: `file-${i}.ts`,
      lines: Array.from({length: 60}, (_, j) => ({
        type: 'add' as const,
        oldLine: null,
        newLine: j + 1,
        content: `FILE_${i}_ROW_${j + 1}`,
      })),
    })),
  };
  const view = renderInk(
    <TerminalMouseProvider value={input.mouse}>
      <DiffSidePanel report={many} height={30} focused />
    </TerminalMouseProvider>,
  );
  await settle();
  await Promise.all(Array.from({length: 12}, () => input.emit({direction: 1, column: 10, row: 7})));
  expect(view.lastFrame()).toContain('❯ M file-36.ts');
  expect(view.lastFrame()).toContain('37/200');
  expect(view.lastFrame()).toContain('FILE_36_ROW_1');
  await input.emit({direction: 1, column: 10, row: 20});
  expect(view.lastFrame()).toContain('37/200');
  expect(view.lastFrame()).not.toContain('FILE_36_ROW_1\n');
  expect(view.lastFrame()).toContain('FILE_36_ROW_4');
  await input.emit({kind: 'click', column: 10, row: 8});
  expect(view.lastFrame()).not.toContain('37/200');
});
