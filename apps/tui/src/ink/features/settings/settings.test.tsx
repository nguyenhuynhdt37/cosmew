/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {useEffect} from 'react';
import {InkApp} from '../../app';
import {useOverlay} from '../../core';
import {renderInk, settle, waitForFrame} from '../../testing';
import {SettingsDialog, settingsRows} from './index';
import {defaultAppearance} from '@cosmew/contracts';
import {dialogFixture, selection} from '../picker/test-fixture';
afterEach(cleanup);
function Open() {
  const router = useOverlay();
  useEffect(() => router.open('settings', <SettingsDialog />), [router.open]);
  return null;
}
test('Theme row opens the picker and Escape returns to the config list', async () => {
  expect(settingsRows(defaultAppearance(), 'dark')[0]!.label).toBe('Theme');
  const fixture = dialogFixture();
  const view = renderInk(<InkApp client={fixture.client} slots={{status: <Open />}} />, {fixture});
  await settle();
  for (const value of ['/', 'Theme', '\r']) {
    view.stdin.write(value);
    await settle();
  }
  expect(view.lastFrame()).toContain('Choose the text style');
  view.stdin.write('\x1b');
  await settle();
  expect(view.lastFrame()).toContain('Settings');
  expect(view.lastFrame()).toContain('Config');
});

test('user preferences toggle from Config and switch the live transcript view', async () => {
  const {openInk, DOWN, ENTER, ESC} = await import('../../testing/ink-session');
  const fixture = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'settings-session', selection, messages: []}),
    async *sendTurn() {
      const call = {id: 'read', name: 'read', input: {path: 'fixture.txt'}};
      yield {type: 'toolCallComplete', call};
      yield {type: 'toolResult', result: {callId: call.id, name: call.name, status: 'ok', content: 'DETAIL_SENTINEL'}};
      yield {type: 'textDelta', text: 'Fixture turn complete'};
    },
  });
  const view = await openInk(fixture.client, {width: 100, rows: 30});
  const wait = (pattern: RegExp) => waitForFrame({lastFrame: () => view.frame()}, frame => pattern.test(frame));
  try {
    await view.submitPrompt('Read the fixture');
    await wait(/· done /);
    expect(view.frame()).not.toContain('DETAIL_SENTINEL');
    await view.submit('/config');
    await wait(/❯ Auto-compact +ON/);
    await view.press(ENTER);
    await wait(/❯ Auto-compact +OFF/);
    await view.press(DOWN);
    await wait(/❯ Verbose +OFF/);
    await view.press(ENTER);
    await wait(/❯ Verbose +ON/);
    await view.press(DOWN);
    await wait(/❯ Show turn duration +ON/);
    await view.press(ENTER);
    await wait(/❯ Show turn duration +OFF/);
    await view.press(ESC);
    await wait(/Showing detailed transcript/);
    expect(view.frame()).toContain('DETAIL_SENTINEL');
    expect(view.frame()).not.toContain('· done ');
    expect(view.frame()).not.toContain('manual mode');
    expect(fixture.client.userPreferences()).toEqual({autoCompact: false, verbose: true, showTurnDuration: false});
  } finally {
    await view.close();
  }

  const reopened = await openInk(fixture.client, {width: 100, rows: 30});
  try {
    await waitForFrame({lastFrame: () => reopened.frame()}, frame => frame.includes('Showing detailed transcript'));
    await reopened.handleKey('Ctrl+O');
    await waitForFrame({lastFrame: () => reopened.frame()}, frame => frame.includes('manual mode'));
  } finally {
    await reopened.close();
  }
});
