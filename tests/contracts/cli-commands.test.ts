import {expect, test} from 'bun:test';
import {SLASH_COMMANDS, acceptSlashSelection, parseSlashCommand} from '@cosmew/sdk';

test('/tasks and /bashes expose the background task overlay during a running response', () => {
  for (const name of ['/tasks', '/bashes']) {
    const parsed = parseSlashCommand(name);
    expect(parsed.error).toBeUndefined();
    expect(parsed.definition).toMatchObject({
      command: '/tasks',
      handler: 'overlay',
      overlay: 'background-tasks',
      duringRequest: true,
    });
    expect(parsed.definition?.unavailable).toBeUndefined();
    expect(parsed.definition?.autocomplete).not.toBe(false);
    expect(parsed.definition?.help).not.toBe(false);
  }
});

test('/config accepts key=value arguments for the interactive settings route', () => {
  const parsed = parseSlashCommand('/config theme=dark');
  expect(parsed.error).toBeUndefined();
  expect(parsed.definition?.command).toBe('/config');
  expect(parsed.args).toBe('theme=dark');
});

test('a typo stays literal when autocomplete has a nearby command', () => {
  const usage = SLASH_COMMANDS.find(command => command.command === '/usage')!;
  expect(acceptSlashSelection('/usege', usage)).toBe('/usege');
  expect(acceptSlashSelection('/us', usage)).toBe('/usage');
});

test('Claude command aliases and canonical review name share one parser', () => {
  expect(parseSlashCommand('/review high --fix').definition?.command).toBe('/code-review');
  expect(parseSlashCommand('/checkup').definition?.command).toBe('/doctor');
  expect(parseSlashCommand('/allowed-tools').definition?.command).toBe('/permissions');
  expect(parseSlashCommand('/checkpoint').definition?.command).toBe('/rewind');
  expect(parseSlashCommand('/undo').definition?.command).toBe('/rewind');
  expect(parseSlashCommand('/bg').definition?.command).toBe('/background');
  expect(parseSlashCommand('/share').definition?.command).toBe('/bug');
  expect(parseSlashCommand('/clear release-notes').args).toBe('release-notes');
});

test('separator-insensitive command completion only canonicalizes a selected match', () => {
  const permissions = SLASH_COMMANDS.find(command => command.command === '/permissions')!;
  expect(acceptSlashSelection('/allowedtools', permissions)).toBe('/permissions');
  expect(acceptSlashSelection('/permssions', permissions)).toBe('/permssions');
});

test('command help does not advertise stale shortcuts that collide with the central keymap', () => {
  for (const name of ['/theme', '/model', '/resume', '/diff', '/clear', '/exit']) {
    expect(SLASH_COMMANDS.find(command => command.command === name)?.shortcut).toBeUndefined();
  }
});
