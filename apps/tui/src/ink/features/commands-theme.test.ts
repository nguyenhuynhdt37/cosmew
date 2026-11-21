import {expect, test} from 'bun:test';
import {createClientFixture} from '../testing/client-fixture';
import {routeCommand, type CommandHost} from './commands';
import {ThemeEngine} from '../../theme/theme';

test('/config theme normalizes mode, survives restart, and rejects unknown themes', async () => {
  const {client} = createClientFixture();
  const notices: string[] = [];
  const host: CommandHost = {
    client,
    busy: () => false,
    open() {},
    notice: text => notices.push(text),
    reset() {},
    submit: () => false,
    exit() {},
  };
  for (const id of ['light', 'auto', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi']) {
    await routeCommand(host, `/config theme=${id}`);
    expect(client.getAppearance().mode).toBe(id === 'auto' ? 'system' : id.startsWith('light') ? 'light' : 'dark');
    const restarted = new ThemeEngine({client, env: {}});
    await restarted.initialize();
    expect(restarted.getActiveAppearance().theme).toBe(id);
  }
  const before = client.getAppearance();
  await routeCommand(host, '/config theme=unknown');
  expect(notices.at(-1)).toContain('Unknown theme');
  expect(client.getAppearance()).toEqual(before);
});

test('/config applies the active picker engine immediately through the host setter', async () => {
  const {client} = createClientFixture();
  const engine = new ThemeEngine({client, env: {}});
  await engine.initialize();
  const host: CommandHost = {
    client,
    busy: () => false,
    open() {},
    notice() {},
    reset() {},
    submit: () => false,
    exit() {},
    setTheme: id => engine.setTheme(id),
  };
  await routeCommand(host, '/config theme=light');
  expect(engine.getEffectiveMode()).toBe('light');
  expect(engine.getCommittedAppearance().theme).toBe('light');
});
