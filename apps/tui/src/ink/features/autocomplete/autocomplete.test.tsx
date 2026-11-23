/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {SLASH_COMMANDS, type FutrynClient} from '@cosmew/sdk';
import {renderInk, settle} from '../../testing';
import {Autocomplete, completionContext, getCompletions, descriptionLines, menuWindow} from './index';
afterEach(cleanup);
const skills: ReturnType<FutrynClient['skills']>['skills'] = [
  {
    name: 'deploy',
    description: 'Deploy project',
    source: 'user',
    path: '/skills/deploy/SKILL.md',
    directory: '/skills/deploy',
    shortPath: 'deploy/SKILL.md',
    disableModelInvocation: false,
  },
];
test('slash suggestions retain every canonical visible command and aliases, plus explicit skills', () => {
  const items = getCompletions(completionContext('/', 1), skills);
  expect(items.filter(item => item.kind === 'command').map(item => item.label)).toEqual(
    SLASH_COMMANDS.filter(command => command.autocomplete !== false).map(command => command.command),
  );
  expect(items.some(item => item.label === '/deploy')).toBe(true);
  expect(getCompletions(completionContext('/cost', 5))[0]?.label).toBe('/usage');
  expect(completionContext('/help args', 10)).toBeNull();
});
test('mentions at the cursor preserve the suffix; dollar suggestions use skills only', () => {
  expect(completionContext('read @src tail', 9)).toEqual({prefix: '@', start: 5, query: 'src'});
  expect(completionContext('mail@host', 9)).toBeNull();
  expect(getCompletions(completionContext('$de', 3), skills).map(item => item.label)).toEqual(['$deploy']);
  expect(
    getCompletions(completionContext('@src', 4), [], ['src/你好.ts', 'README.md']).map(item => item.label),
  ).toEqual(['@src/你好.ts']);
});

test('command filtering ignores separator punctuation and shows typos without auto-selecting them', () => {
  expect(getCompletions(completionContext('/allowedtools', 12))[0]?.label).toBe('/permissions');
  expect(getCompletions(completionContext('/tools', 6)).some(item => item.label === '/permissions')).toBe(true);
  expect(getCompletions(completionContext('/permssions', 11))[0]).toMatchObject({
    label: '/permissions',
    autoSelect: false,
  });
});
test('Autocomplete viewport follows selected item, clamps empty list and sanitizes paths', async () => {
  const items = getCompletions(completionContext('@', 1), [], ['a', 'b', 'c', '\u001b]52;c;evil\u0007d']);
  const view = renderInk(<Autocomplete items={items} selected={3} visibleRows={2} width={25} />);
  await settle();
  expect(view.lastFrame()).toContain('+ d');
  expect(view.lastFrame()).not.toContain('@a');
  expect(view.lastFrame()).not.toContain('evil');
  view.rerender(<Autocomplete items={[]} />);
  await settle();
  expect(view.lastFrame()).toBe('');
});

test('completion columns remain aligned, descriptions stop at two lines with ellipsis, and the menu holds a five-row budget', async () => {
  const items = Array.from({length: 7}, (_, i) => ({
    label: `/item-${i}`,
    replacement: `/item-${i}`,
    kind: 'command' as const,
    description: 'Wrapped description '.repeat(20),
  }));
  const view = renderInk(<Autocomplete items={items} width={100} />);
  await settle();
  const frame = view.lastFrame()!;
  const lines = frame.split('\n');
  // Two-line descriptions: two items fill four rows and a third would need six (reference 03-slash).
  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain('  ❯ /item-0');
  expect(lines[1]!.indexOf('description')).toBeGreaterThanOrEqual(44);
  expect(lines[1]).toContain('…');
  expect(frame).not.toContain('/item-2');
  expect(lines.every(line => Bun.stringWidth(line) <= 100)).toBe(true);
  view.rerender(<Autocomplete items={items} selected={6} width={36} />);
  await settle();
  expect(view.lastFrame()).toContain('❯ /item-6');
  expect(view.lastFrame()).not.toContain('/item-0');
  expect(
    view
      .lastFrame()!
      .split('\n')
      .every(line => Bun.stringWidth(line) <= 36),
  ).toBe(true);
});

test('description wrapping preserves whole words at line boundaries and ellipsizes after two rows', () => {
  expect(descriptionLines('alpha provenance gamma delta', 16)).toEqual(['alpha provenance', 'gamma delta']);
  expect(descriptionLines('alpha provenance gamma delta echo foxtrot', 16)).toEqual([
    'alpha provenance',
    'gamma delta…',
  ]);
  expect(descriptionLines('  alpha   beta  gamma ', 10)).toEqual(['alpha beta', 'gamma']);
});

test('menu window: five one-line rows, selected row always inside the window', () => {
  const files = Array.from({length: 9}, (_, i) => ({
    label: `@f${i}`,
    replacement: `@f${i} `,
    kind: 'file' as const,
    description: 'Workspace file',
  }));
  expect(menuWindow(files, 0, 40)).toEqual({start: 0, end: 5});
  expect(menuWindow(files, 7, 40)).toEqual({start: 3, end: 8});
  expect(menuWindow([], 0, 40)).toEqual({start: 0, end: 0});
});
