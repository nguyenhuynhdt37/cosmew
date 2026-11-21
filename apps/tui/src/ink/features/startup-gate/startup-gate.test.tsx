/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {StartupGate, useStartupGate} from './index';
afterEach(cleanup);

test('trust frame defaults to refusal and never probes or enables tools on Enter', async () => {
  let exits = 0;
  let probes = 0;
  let ready = 0;
  function Gate() {
    const state = useStartupGate({
      onReady: () => ready++,
      onExit: () => exits++,
      openOverlay: () => {},
      overlayOpen: false,
    });
    return <StartupGate state={state} width={80} />;
  }
  const view = renderInk(<Gate />);
  view.fixture.ports.validateAccount = async () => {
    probes++;
    throw Error('Unexpected probe');
  };
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('─'.repeat(80));
  expect(frame).toContain('Accessing workspace:');
  expect(frame).toContain('Quick safety check:');
  expect(frame).toContain('Cosmew will be able to read, edit, and execute files here.');
  expect(frame).toContain('Consent is remembered for this workspace');
  expect(frame).toContain('Account check sends a small, potentially billed request.');
  expect(frame).toContain('❯ No, exit');
  expect(frame).toContain('Enter to confirm · Esc to cancel');
  // Spec 5 order: title, path, paragraph, access line, dim consent block, "Security guide", choices, footer.
  const order = [
    'Accessing workspace:',
    '/fixture',
    'Quick safety check',
    'Cosmew will be able',
    'Consent is remembered',
    'Security guide',
    '❯ No, exit',
    'Yes, I trust this folder',
    'Enter to confirm',
  ];
  expect(order.map(text => frame.indexOf(text))).toEqual(
    [...order.map(text => frame.indexOf(text))].sort((a, b) => a - b),
  );
  expect(order.every(text => frame.includes(text))).toBe(true);
  expect(frame).not.toContain('╭');
  expect(view.fixture.client.toolsEnabled()).toBe(false);
  view.stdin.write('\r');
  await settle();
  expect(exits).toBe(1);
  expect(probes).toBe(0);
  expect(ready).toBe(0);
});

test('trust selection persists for this workspace; later mounts skip the folder prompt', async () => {
  let ready = 0;
  function Gate() {
    const state = useStartupGate({onReady: () => ready++, onExit: () => {}, openOverlay: () => {}, overlayOpen: false});
    return <StartupGate state={state} width={36} />;
  }
  const view = renderInk(<Gate />);
  await settle();
  view.stdin.write('\u001b[B');
  await settle();
  expect(view.lastFrame()).toContain('❯ Yes, I trust this folder');
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('Sign in');
  expect(view.fixture.client.toolsEnabled()).toBe(true);
  expect(view.fixture.client.workspaceTrusted()).toBe(true);
  expect(ready).toBe(0);
  view.unmount();
  expect(view.fixture.client.toolsEnabled()).toBe(false);
  const second = renderInk(<Gate />, {fixture: view.fixture});
  await settle();
  expect(second.lastFrame()).not.toContain('Accessing workspace:');
  expect(second.lastFrame()).toContain('Sign in');
  second.unmount();
});

test('trust copy wraps without leading whitespace and separates choices and footer at 80/36 columns', async () => {
  for (const width of [80, 36]) {
    function Gate() {
      const state = useStartupGate({onReady() {}, onExit() {}, openOverlay() {}, overlayOpen: false});
      return <StartupGate state={state} width={width} />;
    }
    const view = renderInk(<Gate />);
    await settle();
    const frame = view.lastFrame()!;
    const paragraph = frame.slice(frame.indexOf(' Quick safety check:'), frame.indexOf(' Cosmew will'));
    for (const line of paragraph.split('\n').filter(line => line.trim())) {
      expect(line.startsWith(' ')).toBe(true);
      expect(line.startsWith('  ')).toBe(false);
    }
    expect(frame).toContain('\n\n ❯ No, exit');
    expect(frame).toContain('Yes, I trust this folder\n\n Enter to confirm · Esc to cancel');
    view.unmount();
  }
});
