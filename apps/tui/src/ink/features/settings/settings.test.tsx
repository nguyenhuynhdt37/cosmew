/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {useEffect} from 'react';
import {InkApp} from '../../app';
import {useOverlay} from '../../core';
import {renderInk, settle} from '../../testing';
import {SettingsDialog, settingsRows} from './index';
import {defaultAppearance} from '@cosmew/contracts';
import {dialogFixture} from '../picker/test-fixture';
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
