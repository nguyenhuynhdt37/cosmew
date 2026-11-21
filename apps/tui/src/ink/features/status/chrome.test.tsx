/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {useState} from 'react';
import {cleanup} from 'ink-testing-library';
import {renderInk, createClientFixture, settle} from '../../testing';
import {StatusLine, useStatusLine} from './index';
import {Header, useHeader} from '../header';
import {Welcome, useWelcome} from '../welcome';
import {ContextMeter, contextPercent, useContextMeter} from '../context-meter';
import {StartupGate, useStartupGate} from '../startup-gate';
import {Usage, useUsage, reportRows} from '../usage';
import {failureMessage, suggestedAlternative} from '../startup-gate/logic';
afterEach(cleanup);
test('terminal welcome displays the Cosmew mascot beside the product name', async () => {
  const fixture = createClientFixture();
  const view = renderInk(<Welcome status={fixture.client.status()} width={80} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('Cosmew v');
  expect(view.lastFrame()).toContain('▄█▀█▀█▀█▄');
});
test('compact header, welcome and status render without color and wrap narrow paths', async () => {
  const fixture = createClientFixture();
  function Chrome() {
    const data = useStatusLine();
    const header = useHeader();
    const welcome = useWelcome();
    const context = useContextMeter('draft');
    return (
      <>
        <Header status={header} version="test" width={24} preview />
        <Welcome status={welcome} width={24} />
        <StatusLine
          {...data}
          status={{
            ...data.status,
            permissionMode: 'bypassPermissions',
            sandbox: {...data.status.sandbox, enabled: false},
          }}
          width={24}
        />
        <ContextMeter context={context} width={24} />
      </>
    );
  }
  const view = renderInk(<Chrome />, {fixture});
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('COSMEW');
  expect(frame).toContain('▀█▀');
  expect(frame).toContain('test');
  expect(frame).toContain('preview');
  expect(frame).not.toContain('agents running');
  expect(frame).not.toContain('cost unreported');
  expect(frame).toContain('Cosmew v');
  expect(frame).not.toContain('\u001b');
  view.rerender(<Header status={fixture.client.status()} version="resize" width={60} />);
  await settle();
  expect(view.lastFrame()).toContain('resize');
});
test('context clamps invalid input and warns near compaction without using historical measurements', async () => {
  expect(contextPercent(-10)).toBe(0);
  expect(contextPercent(110)).toBe(100);
  expect(contextPercent(NaN)).toBeNull();
  const fixture = createClientFixture();
  const context = {...fixture.client.context(), estimateTokens: 850, limitTokens: 1000, estimatedPercent: 85};
  const view = renderInk(<ContextMeter context={context} />);
  await settle();
  expect(view.lastFrame()).toContain('Near automatic compaction');
  expect(view.lastFrame()).toContain('~850');
  view.rerender(<ContextMeter context={{...context, limitTokens: null, estimatedPercent: null}} />);
  await settle();
  expect(view.lastFrame()).toContain('window unknown');
});
test('startup defaults Exit and sends no probe before consent', async () => {
  let exits = 0,
    ready = 0,
    probes = 0;
  const fixture = createClientFixture({
    validateAccount: async () => {
      probes++;
      throw Error('unexpected');
    },
  });
  function Gate() {
    const state = useStartupGate({
      onReady: () => {
        ready++;
      },
      onExit: () => {
        exits++;
      },
      openOverlay: () => {},
      overlayOpen: false,
    });
    return <StartupGate state={state} />;
  }
  const view = renderInk(<Gate />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('❯ No, exit');
  expect(fixture.client.toolsEnabled()).toBe(false);
  view.stdin.write('\r');
  await settle();
  expect(exits).toBe(1);
  expect(probes).toBe(0);
  expect(ready).toBe(0);
});
test('consent without account locks chat and routes sign-in to host', async () => {
  const routes: string[] = [];
  let ready = 0;
  function Gate() {
    const [overlayOpen, setOverlayOpen] = useState(false);
    const state = useStartupGate({
      onReady: () => {
        ready++;
      },
      onExit: () => {},
      openOverlay: route => {
        routes.push(route);
        setOverlayOpen(true);
      },
      overlayOpen,
    });
    return <StartupGate state={state} />;
  }
  const view = renderInk(<Gate />);
  await settle();
  view.stdin.write('\u001b[A');
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('Sign in');
  expect(ready).toBe(0);
  view.stdin.write('\r');
  await settle();
  expect(routes).toEqual(['connect']);
  view.unmount();
  expect(view.fixture.client.toolsEnabled()).toBe(false);
});
test('reports retain summary, detailed billing, context and status; toggle details', async () => {
  const fixture = createClientFixture();
  expect(reportRows(fixture.client, 'usage').join('\n')).toContain('No usage yet');
  expect(reportRows(fixture.client, 'usage', '', true).join('\n')).toContain('Missing prices/usage');
  expect(reportRows(fixture.client, 'context', '', true).join('\n')).toContain('LAST PROVIDER/RUNTIME');
  expect(reportRows(fixture.client, 'status', '', true).join('\n')).toContain('BACKEND CAPABILITIES');
  function Report() {
    const state = useUsage({onClose: () => {}});
    return <Usage state={state} visibleRows={30} />;
  }
  const view = renderInk(<Report />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('No usage yet');
  view.stdin.write('d');
  await settle();
  expect(view.lastFrame()).toContain('SESSION USAGE');
});
test('startup failures distinguish auth from retryable errors and suggest sign-in with no alternate', () => {
  expect(failureMessage('AUTH')).toContain('rejected');
  expect(failureMessage('PROTOCOL')).toContain('retry');
  expect(suggestedAlternative([], 'failed')).toBe(0);
});
