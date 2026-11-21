/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {useEffect} from 'react';
import {InkApp} from '../../app';
import {useOverlay} from '../../core';
import {renderInk, settle, waitForFrame} from '../../testing';
import {session, dialogFixture} from '../picker/test-fixture';
import {SandboxDialog} from './index';
import {dependencyRows} from './logic';
import {SandboxBanner} from '../status';
afterEach(cleanup);
function Open() {
  const router = useOverlay();
  useEffect(() => router.open('sandbox', <SandboxDialog />), [router.open]);
  return null;
}
test('dependency message lists only missing dependencies', () => {
  expect(
    dependencyRows({
      platform: 'linux',
      items: [
        {name: 'ripgrep', ok: true},
        {name: 'bwrap', ok: false},
        {name: 'socat', ok: false},
      ],
    }).at(-1),
  ).toBe('Sandbox dependencies not available: bwrap, socat');
});
test('Dependencies shows probe rows when on and says not needed when off', async () => {
  let probes = 0;
  const fixture = dialogFixture({
    sandboxDependencies: async () => {
      probes++;
      return {
        platform: 'darwin',
        items: [
          {name: 'seatbelt', ok: true},
          {name: 'ripgrep', ok: false},
        ],
      };
    },
  });
  const view = renderInk(<InkApp client={fixture.client} slots={{status: <Open />}} />, {fixture});
  await settle();
  view.stdin.write('\t');
  await settle();
  await waitForFrame(view, frame => frame.includes('dependencies are not needed'));
  expect(view.lastFrame()).toContain('dependencies are not needed');
  expect(probes).toBe(0);
  fixture.client.updateSandbox({enabled: true});
  await settle();
  await waitForFrame(
    view,
    frame => frame.includes('seatbelt: ok') && frame.includes('Sandbox dependencies not available: ripgrep'),
  );
  expect(view.lastFrame()).toContain('seatbelt: ok');
  expect(view.lastFrame()).toContain('Sandbox dependencies not available: ripgrep');
});
test('banner is hidden at zero and when sandbox is off', () => {
  const view = renderInk(<SandboxBanner enabled count={0} />);
  expect(view.lastFrame()).not.toContain('Sandbox blocked');
  view.rerender(<SandboxBanner enabled count={2} />);
  expect(view.lastFrame()).toContain('⧈ Sandbox blocked 2 operations');
  view.rerender(<SandboxBanner enabled={false} count={2} />);
  expect(view.lastFrame()).not.toContain('Sandbox blocked');
});
test('denial count resets on the next turn and counts only backend sandbox denial outcomes', async () => {
  let denied = true;
  const fixture = dialogFixture({
    startSession: () => ({...session, messages: []}),
    async *sendTurn() {
      if (denied)
        yield {
          type: 'toolResult',
          result: {callId: 'call-1', name: 'exec_command', status: 'error', code: 'SANDBOX_DENIED', content: 'denied'},
        } as const;
    },
  });
  fixture.client.updateSandbox({enabled: true});
  for await (const _ of fixture.client.sendMessage('first')) {
    /* consume */
  }
  expect(fixture.client.status().sandboxBlockedOperations).toBe(1);
  denied = false;
  for await (const _ of fixture.client.sendMessage('second')) {
    /* consume */
  }
  expect(fixture.client.status().sandboxBlockedOperations).toBe(0);
});
