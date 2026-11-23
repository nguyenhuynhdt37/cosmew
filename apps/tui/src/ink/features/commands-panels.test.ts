import {expect, test} from 'bun:test';
import {createClientFixture} from '../testing/client-fixture';
import {routeCommand, type CommandHost} from './commands';

test('canonical panels route aliases, reject unsupported MCP args and respect active turns', async () => {
  const {client} = createClientFixture();
  const opened: string[] = [];
  const notices: string[] = [];
  let busy = false;
  const host: CommandHost = {
    client,
    busy: () => busy,
    open: route => opened.push(route),
    notice: text => notices.push(text),
    reset() {},
    submit: () => false,
    exit() {},
  };
  for (const raw of ['/mcp', '/rewind', '/checkpoint', '/undo']) await routeCommand(host, raw);
  expect(opened).toEqual(['mcp', 'rewind', 'rewind', 'rewind']);
  await routeCommand(host, '/mcp reconnect');
  expect(opened).toHaveLength(4);
  expect(notices.at(-1)).toContain('cosmew mcp --help');
  busy = true;
  await routeCommand(host, '/rewind');
  await routeCommand(host, '/mcp');
  expect(opened).toHaveLength(4);
  expect(notices.at(-1)).toContain('Cancel the active response');
});
