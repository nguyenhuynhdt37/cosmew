/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {SLASH_COMMANDS, type FutrynClient} from '@futryn/sdk';
import {renderInk, settle} from '../../testing';
import {Autocomplete, completionContext, getCompletions} from './index';
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
test('Autocomplete viewport follows selected item, clamps empty list and sanitizes paths', async () => {
  const items = getCompletions(completionContext('@', 1), [], ['a', 'b', 'c', '\u001b]52;c;evil\u0007d']);
  const view = renderInk(<Autocomplete items={items} selected={3} visibleRows={2} width={25} />);
  await settle();
  expect(view.lastFrame()).toContain('› @d');
  expect(view.lastFrame()).not.toContain('@a');
  expect(view.lastFrame()).not.toContain('evil');
  view.rerender(<Autocomplete items={[]} />);
  await settle();
  expect(view.lastFrame()).toBe('');
});
