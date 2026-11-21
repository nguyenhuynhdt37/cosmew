/** @jsxImportSource react */
import {afterEach, expect, spyOn, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {useEffect} from 'react';
import {InkApp} from '../../app';
import {useOverlay} from '../../core';
import {renderInk, settle} from '../../testing';
import {dialogFixture} from '../picker/test-fixture';
import {routeCommand} from '../commands';
import {SandboxDialog} from './index';
import {SANDBOX_MODES, activeSandboxMode} from './logic';
afterEach(cleanup);
function Open() {
  const router = useOverlay();
  useEffect(() => router.open('sandbox', <SandboxDialog />), [router.open]);
  return null;
}
test('Mode choices persist their exact pair and show the active selection', async () => {
  const fixture = dialogFixture();
  const view = renderInk(<InkApp client={fixture.client} slots={{status: <Open />}} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('No sandbox');
  for (const [at, item] of SANDBOX_MODES.entries()) {
    fixture.client.updateSandbox(item.patch);
    expect(activeSandboxMode(fixture.client.permissionSettings().sandbox)).toBe(at);
  }
  view.stdin.write('\x1b[A');
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(fixture.client.permissionSettings().sandbox.enabled).toBe(true);
  expect(view.lastFrame()).toContain('active');
});
test('sandbox commands work during a turn and exclusions are idempotent', async () => {
  const {client} = dialogFixture();
  const opened: string[] = [],
    notices: string[] = [];
  const host = {
    client,
    busy: () => true,
    open: (route: string) => {
      opened.push(route);
    },
    notice: (text: string) => {
      notices.push(text);
    },
    reset() {},
    submit: () => false,
    exit() {},
  };
  await routeCommand(host, '/sandbox');
  expect(opened).toEqual(['sandbox']);
  await routeCommand(host, '/sandbox exclude "npm test"');
  await routeCommand(host, '/sandbox exclude "npm test"');
  expect(client.permissionSettings().sandbox.excludedCommands).toEqual(['npm test']);
  expect(notices.join(' ')).not.toContain('failed');
  client.updateSandbox({allowUnsandboxedCommands: false});
  expect(client.permissionSettings().sandbox.allowUnsandboxedCommands).toBe(false);
});

test('write failures render an error row and keep active mode', async () => {
  const fixture = dialogFixture();
  const update = spyOn(fixture.client, 'updateSandbox').mockImplementation(() => {
    throw new Error('read only');
  });
  const view = renderInk(<InkApp client={fixture.client} slots={{status: <Open />}} />, {fixture});
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('Could not save user sandbox settings.');
  expect(fixture.client.permissionSettings().sandbox.enabled).toBe(false);
  update.mockRestore();
});

test('Overrides changes fallback; Config shows the saved exclusion', async () => {
  const fixture = dialogFixture();
  fixture.client.updateSandbox({excludeCommand: 'npm test'});
  const view = renderInk(<InkApp client={fixture.client} slots={{status: <Open />}} />, {fixture});
  await settle();
  view.stdin.write('\t');
  await settle();
  view.stdin.write('\t');
  await settle();
  expect(view.lastFrame()).toContain('Allow unsandboxed fallback');
  view.stdin.write('\x1b[B');
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(fixture.client.permissionSettings().sandbox.allowUnsandboxedCommands).toBe(false);
  view.stdin.write('\t');
  await settle();
  expect(view.lastFrame()).toContain('npm test');
  expect(view.lastFrame()).toContain('network.allowedDomains');
});

test('saving sandbox policy revokes grants and settles pending prompts', async () => {
  let grants = ['file'];
  const fixture = dialogFixture({
    toolGrants: {
      list: () => grants,
      clear: () => {
        grants = [];
      },
    },
  });
  const decision = fixture.client.requestPermission({
    capability: 'fs.read',
    action: 'Read secret',
    target: '.env',
    reason: 'secret',
    kind: 'secret',
    decisions: ['once', 'session'],
  });
  await settle();
  expect(fixture.client.listPendingPermissions()).toHaveLength(1);
  fixture.client.updateSandbox({enabled: true});
  expect(await decision).toBe('deny');
  expect(fixture.client.listToolGrants()).toEqual([]);
  expect(fixture.client.listPendingPermissions()).toEqual([]);
});
