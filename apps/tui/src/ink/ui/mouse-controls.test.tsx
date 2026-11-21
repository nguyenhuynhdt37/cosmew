/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Box} from 'ink';
import {useState, type ReactElement} from 'react';
import type {TerminalMouseEvent, TerminalMouseInput} from '../../input/mouse-input';
import {TerminalMouseProvider} from '../hooks/use-terminal-wheel';
import {InputScope} from '../hooks/input-scope';
import {renderInk, settle} from '../testing';
import {ListPicker} from './list-picker';
import {OptionList} from './option-list';
import {PanelTabs} from './panel-tabs';
import {Detail} from '../features/picker';

afterEach(cleanup);

function mount(tree: ReactElement) {
  const listeners = new Set<(event: TerminalMouseEvent) => void>();
  const source: TerminalMouseInput = {
    stdin: {} as TerminalMouseInput['stdin'],
    subscribe: () => () => {},
    subscribeMouse: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => listeners.clear(),
  };
  const wrap = (element: ReactElement) => <TerminalMouseProvider value={source}>{element}</TerminalMouseProvider>;
  const view = renderInk(wrap(tree));
  return {
    ...view,
    rerender: (element: ReactElement) => view.rerender(wrap(element)),
    async mouse(event: TerminalMouseEvent) {
      for (const listener of [...listeners]) listener(event);
      await settle();
    },
    row(text: string) {
      const index = view
        .lastFrame()!
        .split('\n')
        .findIndex(line => line.includes(text));
      expect(index).toBeGreaterThanOrEqual(0);
      return index + 1;
    },
  };
}

test('ListPicker hit tests clicks and wheel, keeps explicit Enter activation and disabled protection', async () => {
  const selected: string[] = [];
  const view = mount(
    <Box width={30}>
      <ListPicker
        filterable={false}
        hint={false}
        items={[
          {id: 'one', label: 'One'},
          {id: 'two', label: 'Two', disabled: true},
          {id: 'three', label: 'Three'},
        ]}
        onSelect={item => selected.push(item.id)}
      />
    </Box>,
  );
  await settle();
  await view.mouse({kind: 'click', column: 3, row: view.row('Two')});
  expect(view.lastFrame()).toContain('❯ Two');
  expect(selected).toEqual([]);
  view.stdin.write('\r');
  await settle();
  expect(selected).toEqual([]);
  await view.mouse({direction: 1, column: 40, row: view.row('Two')});
  expect(view.lastFrame()).toContain('❯ Two');
  await view.mouse({direction: 1, column: 3, row: view.row('Two')});
  expect(view.lastFrame()).toContain('❯ Three');
  view.stdin.write('\r');
  await settle();
  expect(selected).toEqual(['three']);
});

test('OptionList clicks the entire wrapping description without granting an action', async () => {
  function Choices() {
    const [cursor, setCursor] = useState(0);
    return (
      <OptionList
        width={26}
        cursor={cursor}
        onCursorChange={setCursor}
        items={[
          {id: 'deny', label: 'Deny'},
          {id: 'allow', label: 'Allow', description: 'A long description that wraps across several terminal rows.'},
        ]}
      />
    );
  }
  const view = mount(<Choices />);
  await settle();
  await view.mouse({kind: 'click', column: 8, row: view.row('rows.')});
  expect(view.lastFrame()).toContain('❯ 2. Allow');
  await view.mouse({direction: -1, column: 8, row: view.row('rows.')});
  expect(view.lastFrame()).toContain('❯ 1. Deny');
});

test('inactive and background controls ignore mouse input', async () => {
  const changes: number[] = [];
  const tree = (active: boolean, scoped: boolean) => (
    <InputScope active={scoped}>
      <OptionList
        isActive={active}
        cursor={0}
        onCursorChange={index => changes.push(index)}
        items={[
          {id: 'one', label: 'One'},
          {id: 'two', label: 'Two'},
        ]}
      />
    </InputScope>
  );
  const view = mount(tree(false, true));
  await settle();
  await view.mouse({kind: 'click', column: 4, row: view.row('Two')});
  await view.mouse({direction: 1, column: 4, row: view.row('Two')});
  view.rerender(tree(true, false));
  await settle();
  await view.mouse({kind: 'click', column: 4, row: view.row('Two')});
  expect(changes).toEqual([]);
});

test('PanelTabs measures each tab and ignores title, gaps and inactive tabs', async () => {
  const changes: string[] = [];
  const tree = (active: boolean) => (
    <PanelTabs
      title="Help"
      tabs={['One', 'Two']}
      selected="One"
      isActive={active}
      onSelect={value => changes.push(value)}
    />
  );
  const view = mount(tree(true));
  await settle();
  expect(view.lastFrame()).toBe('Help  One   Two');
  await view.mouse({kind: 'click', column: 2, row: 1});
  await view.mouse({kind: 'click', column: 11, row: 1});
  expect(changes).toEqual([]);
  await view.mouse({kind: 'click', column: 13, row: 1});
  expect(changes).toEqual(['Two']);
  view.rerender(tree(false));
  await settle();
  await view.mouse({kind: 'click', column: 7, row: 1});
  expect(changes).toEqual(['Two']);
});

test('Detail wheel scrolls only over output and preserves keyboard navigation', async () => {
  const view = mount(
    <Box width={20} flexDirection="column">
      <Detail text={'first\nsecond\nthird\nfourth'} visibleRows={2} />
    </Box>,
  );
  await settle();
  await view.mouse({direction: 1, column: 30, row: 1});
  expect(view.lastFrame()).toContain('first');
  await view.mouse({direction: 1, column: 3, row: 1});
  expect(view.lastFrame()).not.toContain('first');
  expect(view.lastFrame()).toContain('third');
  view.stdin.write('\x1b[B');
  await settle();
  expect(view.lastFrame()).toContain('fourth');
});
