/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {buildKeymap, keymapStore} from '../../hooks/keymap';
import {TaskOutput} from './output';

afterEach(() => {
  cleanup();
  keymapStore.reset();
});

test('long Unicode output is sanitized and paged by terminal rows rather than raw lines', async () => {
  const view = renderInk(
    <TaskOutput
      text={'中'.repeat(200) + '\nLATEST\x1b]52;c;hidden\x07'}
      width={20}
      visibleRows={2}
      onBack={() => {}}
    />,
  );
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('LATEST');
  expect(frame).not.toContain('hidden');
  expect(frame.split('\n')).toHaveLength(3);
  for (const row of frame.split('\n')) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(20);
});

test('follow action and its hint honor live user key remapping', async () => {
  const text = Array.from({length: 10}, (_, i) => `line-${i}`).join('\n');
  const view = renderInk(<TaskOutput text={text} width={40} visibleRows={2} onBack={() => {}} />);
  await settle();
  view.stdin.write('\x1b[A');
  await settle();
  expect(view.lastFrame()).not.toContain('line-9');
  keymapStore.set(
    buildKeymap(JSON.stringify({bindings: [{context: 'Select', bindings: {end: null, f: 'select:last'}}]})),
  );
  await settle();
  expect(view.lastFrame()).toContain('f follow');
  view.stdin.write('\x1b[F');
  await settle();
  expect(view.lastFrame()).not.toContain('line-9');
  view.stdin.write('f');
  await settle();
  expect(view.lastFrame()).toContain('line-9');
  expect(view.lastFrame()).toContain('following');
});
