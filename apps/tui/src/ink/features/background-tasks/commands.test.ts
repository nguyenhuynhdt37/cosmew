import {expect, test} from 'bun:test';
import {routeCommand, type CommandHost} from '../commands';
import {createClientFixture} from '../../testing/client-fixture';

test('/tasks opens the task panel while idle or busy without submitting model work', async () => {
  const {client} = createClientFixture();
  const opened: string[] = [];
  const notices: string[] = [];
  let submitted = 0;
  let busy = false;
  const host: CommandHost = {
    client,
    busy: () => busy,
    open: route => opened.push(route),
    notice: text => notices.push(text),
    reset() {},
    submit: () => {
      submitted++;
      return false;
    },
    exit() {},
  };
  await routeCommand(host, '/tasks');
  busy = true;
  await routeCommand(host, '/bashes');
  expect(opened).toEqual(['background-tasks', 'background-tasks']);
  expect(notices).toEqual([]);
  expect(submitted).toBe(0);
});
