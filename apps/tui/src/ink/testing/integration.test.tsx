/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup, render} from 'ink-testing-library';
import {FutrynError, type ModelEvent} from '@futryn/contracts';
import {SLASH_COMMANDS} from '@futryn/sdk';
import {InkApp} from '../app';
import {dialogFixture, selection, account} from '../features/picker/test-fixture';
import {routeCommand, type CommandHost} from '../features/commands';
import {ListPicker} from '../ui';
import {renderInk, settle} from './index';
afterEach(cleanup);
const key = async (view: {stdin: {write(s: string): void}}, text: string) => {
  view.stdin.write(text);
  await settle();
};
function fixture() {
  const prompts: string[] = [];
  let checks = 0;
  let client: ReturnType<typeof dialogFixture>['client'];
  const f = dialogFixture({
    validateAccount: async () => {
      checks++;
      return {models: 1, validation: 'fixture'};
    },
    startSession: () => ({id: 'session-1', selection, messages: []}),
    async *sendTurn(_id, content, signal): AsyncIterable<ModelEvent> {
      prompts.push(content);
      yield {type: 'toolCallComplete', call: {id: 'read-1', name: 'read', input: {path: 'file'}}};
      const decision = await client.requestPermission(
        {
          capability: 'fs.read',
          action: 'Read fixture',
          target: 'file',
          reason: 'test',
          kind: 'secret',
          decisions: ['once', 'session'],
        },
        signal,
      );
      yield {
        type: 'toolResult',
        result: {
          callId: 'read-1',
          name: 'read',
          status: decision === 'deny' ? 'denied' : 'ok',
          content: `Read ${decision}`,
        },
      };
      yield {type: 'textDelta', text: 'Integrated answer'};
    },
  });
  client = f.client;
  return {...f, prompts, checks: () => checks};
}
test('host gates initial command, streams tool and session approval, history focus, reset, and drains shutdown', async () => {
  const f = fixture();
  let shutdown = async () => {};
  const view = render(
    <InkApp
      client={f.client}
      width={90}
      initialCommand="/plan"
      registerShutdown={fn => {
        shutdown = fn;
      }}
    />,
  );
  await settle();
  expect(f.checks()).toBe(0);
  expect(f.client.toolsEnabled()).toBe(false);
  await key(view, '\x1b[A');
  await key(view, '\r');
  await settle();
  expect(f.checks()).toBe(1);
  expect(f.client.mode()).toBe('plan');
  await key(view, 'hello');
  await key(view, '\r');
  await settle();
  expect(f.prompts).toEqual(['hello']);
  expect(view.lastFrame()).toContain('2 Cả phiên');
  await key(view, '2');
  await settle();
  expect(view.lastFrame()).toContain('Integrated answer');
  await key(view, '\x0f');
  expect(view.lastFrame()).toContain('Transcript history');
  await key(view, '\x0f');
  expect(view.lastFrame()).toContain('Read session');
  await key(view, '\x1b');
  await key(view, '/clear');
  await key(view, '\r');
  expect(view.lastFrame()).not.toContain('Integrated answer');
  await shutdown();
  view.unmount();
  expect(f.client.toolsEnabled()).toBe(false);
  expect(f.client.listPendingPermissions()).toEqual([]);
});
test('startup verification failure stays locked and exit cancels pending probe', async () => {
  const f = fixture();
  f.ports.validateAccount = async () => {
    throw new FutrynError('AUTH');
  };
  const view = render(<InkApp client={f.client} width={80} initialCommand="/plan" />);
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('rejected');
  expect(f.client.mode()).toBe('chat');
  expect(f.prompts).toEqual([]);
  view.unmount();
  expect(f.client.toolsEnabled()).toBe(false);
});
test('controlled picker tracks highlight and fixed decision numbering', async () => {
  const highlights: string[] = [];
  const view = renderInk(
    <ListPicker
      items={[
        {id: 'a', label: 'Alpha'},
        {id: 'b', label: 'Beta'},
      ]}
      cursor={1}
      isActive={false}
      numbered={false}
      hint={false}
      onHighlight={item => highlights.push(item.id)}
      onSelect={() => {}}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('› Beta');
  expect(view.lastFrame()).not.toContain('2.');
  expect(highlights).toEqual(['b']);
});
test('every SDK slash has an explicit implemented route or Not implemented diagnostic', async () => {
  for (const def of SLASH_COMMANDS) {
    const f = fixture();
    const output: string[] = [];
    const host: CommandHost = {
      client: f.client,
      busy: () => false,
      open: route => output.push(route),
      notice: text => output.push(text),
      reset: () => output.push('reset'),
      submit: () => {
        output.push('submit');
        return true;
      },
      exit: () => output.push('exit'),
    };
    await routeCommand(host, def.command);
    // A command must be observable; never silently fall through.
    expect(output.length, def.command).toBeGreaterThan(0);
    expect(
      output.some(text => text.includes('undefined')),
      def.command,
    ).toBe(false);
  }
});

test('host routes quick memory to public API and shell output/escape to transcript and shutdown', async () => {
  const f = fixture();
  const writes: unknown[] = [];
  let signal: AbortSignal | undefined;
  f.ports.memoryAction = async (action, name, entry) => {
    writes.push({action, name, entry});
    return {name: 'memory', callId: 'm', status: 'ok', content: 'Memory saved.'};
  };
  f.ports.runShellCommand = async (_command, abort, output) => {
    signal = abort;
    output?.({stream: 'stdout', text: 'SHELL_STREAM_MARKER'});
    await new Promise<void>(resolve => abort!.addEventListener('abort', () => resolve(), {once: true}));
    return {name: 'exec_command', callId: 'shell', status: 'error', code: 'ABORTED', content: 'Shell cancelled'};
  };
  let shutdown = async () => {};
  const view = render(
    <InkApp
      client={f.client}
      width={90}
      registerShutdown={fn => {
        shutdown = fn;
      }}
    />,
  );
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  await settle();
  await key(view, '#Prefer concise explanations');
  await key(view, '\r');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({action: 'write', entry: {type: 'feedback', content: 'Prefer concise explanations'}});
  expect(view.lastFrame()).toContain('Memory saved.');
  await key(view, '!echo shell');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('SHELL_STREAM_MARKER');
  await key(view, '\x1b');
  expect(signal?.aborted).toBe(true);
  expect(view.lastFrame()).toContain('Shell cancelled');
  await shutdown();
  view.unmount();
  expect(f.client.toolsEnabled()).toBe(false);
});

test('permission denial reason reaches SDK steering and permission cleanup does not grant', async () => {
  const f = fixture();
  const feedback: string[] = [];
  f.ports.steerTurn = (_id, text) => {
    feedback.push(text);
    return {accepted: true, steerId: 'feedback', turnId: 't'};
  };
  const view = render(<InkApp client={f.client} width={90} />);
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  await settle();
  await key(view, 'read it');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('4 Không');
  // The dialog opens asynchronously; allow Ink to attach its passive input subscriptions.
  await Bun.sleep(200);
  await key(view, '4');
  await key(view, 'Use another file');
  await key(view, '\r');
  await settle();
  expect(feedback).toEqual(['Permission denied. User feedback: Use another file']);
  expect(view.lastFrame()).toContain('Read deny');
  expect(f.client.listPendingPermissions()).toEqual([]);
  view.unmount();
});

test('picker remembers selection across overlay mounts and themes preview on highlight with rollback', async () => {
  const {useOverlay} = await import('../core');
  const {useKeymap, useTextInput} = await import('../hooks');
  const {PickerDialog} = await import('../features/picker');
  const {ThemesDialog} = await import('../features/themes');
  const {ThemeEngine} = await import('../../theme/theme');
  const engine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
  function Open() {
    const router = useOverlay();
    useKeymap({close: router.close});
    useTextInput(input => {
      if (router.active) return;
      if (input === 'p')
        router.open(
          'picker',
          <PickerDialog
            title="Remembered"
            items={[
              {id: 'a', label: 'Alpha'},
              {id: 'b', label: 'Beta'},
            ]}
            onSelect={() => router.close()}
          />,
        );
      if (input === 't') router.open('theme', <ThemesDialog />);
    });
    return <>{router.active?.content}</>;
  }
  const view = renderInk(<Open />, {themeEngine: engine});
  await settle();
  await key(view, 'p');
  await key(view, '\x1b[B');
  await key(view, '\r');
  await key(view, 'p');
  expect(view.lastFrame()).toContain('› 2. Beta');
  await key(view, '\x1b');
  await key(view, 't');
  await key(view, '\x1b[B');
  expect(engine.isPreviewing()).toBe(true);
  await key(view, '\x1b');
  expect(engine.isPreviewing()).toBe(false);
});

test('shutdown aborts and drains an active dialog SDK task', async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  let drained = false;
  f.ports.discoverModels = async (_account, abort) => {
    signal = abort;
    await new Promise<void>(resolve => abort!.addEventListener('abort', () => resolve(), {once: true}));
    drained = true;
    throw new FutrynError('POLICY');
  };
  let shutdown = async () => {};
  const view = render(
    <InkApp
      client={f.client}
      width={90}
      registerShutdown={fn => {
        shutdown = fn;
      }}
    />,
  );
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  await settle();
  await key(view, '/model');
  await key(view, '\r');
  await key(view, '\x12');
  expect(signal).toBeDefined();
  await shutdown();
  expect(signal?.aborted).toBe(true);
  expect(drained).toBe(true);
  view.unmount();
});

test('unsupported backend commands say Not implemented and effort status preserves selection', async () => {
  const f = fixture();
  const notices: string[] = [];
  const host: CommandHost = {
    client: f.client,
    busy: () => false,
    open: () => {},
    notice: text => notices.push(text),
    reset: () => {},
    submit: () => false,
    exit: () => {},
  };
  f.ports.validateAccount = async () => {
    throw new FutrynError('UNSUPPORTED');
  };
  await routeCommand(host, '/doctor');
  expect(notices.at(-1)).toContain('Not implemented: /doctor');
  const before = f.client.status().reasoningEffort;
  await routeCommand(host, '/effort status');
  expect(notices.at(-1)).toContain('Available: low, high');
  expect(f.client.status().reasoningEffort).toBe(before);
});

test('startup sign-in connects then chooses model before verification unlocks chat', async () => {
  const f = fixture();
  let connected = false;
  f.settings.accounts = [];
  f.ports.resolveSelection = () => (connected ? selection : null);
  f.ports.useAccount = () => account;
  f.ports.selectModel = () => selection;
  f.ports.listAccounts = () => (connected ? [account] : []);
  f.ports.addAccount = async () => {
    connected = true;
    f.settings.accounts = [account];
    return account;
  };
  const view = render(<InkApp client={f.client} width={90} />);
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('Sign in');
  await key(view, '\r');
  await Bun.sleep(200);
  await key(view, '\r');
  await Bun.sleep(100);
  await key(view, '\r');
  await Bun.sleep(100);
  await key(view, 'fixture-private-key');
  await key(view, '\r');
  await settle();
  expect(connected, view.lastFrame()).toBe(true);
  expect(view.lastFrame()).toContain('Model / Reasoning effort');
  expect(view.lastFrame()).not.toContain('fixture-private-key');
  expect(f.checks()).toBe(1);
  await key(view, '\r');
  await Bun.sleep(100);
  await key(view, '\r');
  await Bun.sleep(100);
  expect(f.checks()).toBe(2);
  expect(view.lastFrame()).toContain('Ask anything');
  view.unmount();
  expect(f.client.toolsEnabled()).toBe(false);
});
