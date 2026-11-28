/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {FutrynError, type ModelEvent} from '@cosmew/contracts';
import {SLASH_COMMANDS} from '@cosmew/sdk';
import {InkApp} from '../app';
import {openInk} from './ink-session';
import {dialogFixture, selection, account} from '../features/picker/test-fixture';
import {routeCommand, type CommandHost} from '../features/commands';
import {ListPicker} from '../ui';
import {render, renderInk, settle, waitForFrame} from './index';
afterEach(cleanup);
/** Consent and composer setup take a few frames; wait for the ready composer before typing. */
const untilReady = async (view: {lastFrame(): string | undefined}) => {
  await waitForFrame(view, frame => frame.includes('manual mode on'), 4000);
  await settle(); // input handlers register one commit after the frame
};
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
  expect(f.checks()).toBe(0);
  expect(f.client.mode()).toBe('plan');
  await key(view, 'hello');
  await key(view, '\r');
  await settle();
  expect(f.prompts).toEqual(['hello']);
  expect(f.checks()).toBe(1);
  expect(view.lastFrame()).toContain('2. Yes, and');
  await key(view, '2');
  await settle();
  expect(view.lastFrame()).toContain('Integrated answer');
  // Ctrl+O toggles the detailed transcript: every tool call is listed and the composer gives way to its footer.
  await key(view, '\x0f');
  expect(view.lastFrame()).toContain('Showing detailed transcript');
  expect(view.lastFrame()).toContain('⏺ Read(file)');
  expect(view.lastFrame()).toContain('Read session');
  expect(view.lastFrame()).toMatch(/\d+:\d\d [AP]M sample-model/);
  await key(view, '\x0f');
  expect(view.lastFrame()).not.toContain('Showing detailed transcript');
  expect(view.lastFrame()).toContain('Integrated answer');
  await key(view, '/clear');
  await key(view, '\r');
  // The fullscreen transcript is cleared with /clear; the SDK starts a fresh session.
  expect(view.lastFrame()).toContain('Started a fresh conversation.');
  expect(f.client.activeSession()).toBeNull();
  expect(view.lastFrame()).not.toContain('Integrated answer');
  await shutdown();
  view.unmount();
  expect(f.client.toolsEnabled()).toBe(false);
  expect(f.client.listPendingPermissions()).toEqual([]);
});
test('cancelling a pending first-send check keeps the draft and sends no prompt', async () => {
  const f = fixture();
  let request: AbortSignal | undefined;
  f.ports.validateAccount = async (_account, signal) => {
    request = signal;
    await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), {once: true}));
    throw new FutrynError('CANCELLED');
  };
  f.client.trustWorkspace();
  const view = render(<InkApp client={f.client} width={80} />);
  await untilReady(view);
  await key(view, 'kept input');
  await key(view, '\r');
  expect(request).toBeDefined();
  expect(view.lastFrame()).toContain('Checking account…');
  await key(view, '\x1b');
  expect(request?.aborted).toBe(true);
  expect(view.lastFrame()).toContain('kept input');
  expect(view.lastFrame()).not.toContain('Checking account…');
  expect(f.prompts).toEqual([]);
});

test('compact echoes in the transcript before its backend completes and updates the same row', async () => {
  const pending = Promise.withResolvers<void>();
  const {client} = dialogFixture({
    startSession: () => ({id: 'compact-fixture', selection, messages: []}),
    async compactSession() {
      await pending.promise;
      return {compacted: true, strategy: 'model', tokensBefore: 2000, tokensAfter: 500, usage: null};
    },
  });
  client.createSession();
  const ui = await openInk(client, {width: 90, rows: 28});
  try {
    await ui.type('/compact');
    await ui.press('\r');
    expect(ui.frame()).toMatch(/❯ \/compact\n  ⎿\s+Running…/);
    pending.resolve();
    await ui.waitFor('Context compacted');
    const frame = ui.frame();
    expect(frame.match(/❯ \/compact/g)).toHaveLength(1);
    expect(frame).toMatch(/❯ \/compact\n  ⎿\s+Context compacted/);
    expect(frame).not.toContain('Running…');
  } finally {
    pending.resolve();
    await ui.close();
  }
});

test('Escape cancels a running slash command and replaces its progress on the same row', async () => {
  const pending = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const {client} = dialogFixture({
    async validateAccount(_account, requestSignal) {
      signal = requestSignal;
      const onAbort = () => pending.resolve();
      requestSignal?.addEventListener('abort', onAbort, {once: true});
      await pending.promise;
      requestSignal?.removeEventListener('abort', onAbort);
      requestSignal?.throwIfAborted();
      return {models: 1, validation: 'fixture'};
    },
  });
  const ui = await openInk(client, {width: 90, rows: 28});
  try {
    await ui.type('/doctor');
    await ui.press('\r');
    expect(ui.frame()).toMatch(/❯ \/doctor\n  ⎿\s+Running…/);
    await ui.press('\x1b');
    expect(signal?.aborted).toBe(true);
    const frame = ui.frame();
    expect(frame.match(/❯ \/doctor/g)).toHaveLength(1);
    expect(frame).toMatch(/❯ \/doctor\n  ⎿\s+Command cancelled/);
  } finally {
    pending.resolve();
    await ui.close();
  }
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
  expect(view.lastFrame()).toContain('❯ Beta');
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

test('/copy selects an earlier reply and copies the chosen code block', async () => {
  const {client} = fixture();
  const output: string[] = [];
  const host: CommandHost = {
    client,
    busy: () => false,
    open: () => {},
    notice: text => output.push(text),
    reset: () => {},
    submit: () => false,
    exit: () => {},
    responseText: index => (index === 2 ? 'Earlier reply\n\n```ts\nconst value = 1;\n```\n\n> Quoted text' : undefined),
    choose: async (title, choices, writeKey) => {
      expect(title).toBe('Copy response');
      expect(writeKey).toBe(true);
      expect(choices.map(choice => choice.label)).toEqual(['Full response', 'Code block 1', 'Blockquote 2']);
      return {id: choices[1]!.id, write: false};
    },
    copyText: async text => {
      output.push(text);
      return true;
    },
  };
  await routeCommand(host, '/copy 2');
  expect(output).toEqual(['const value = 1;', 'Response copied to clipboard.']);
});

test('/config applies Claude-style multiple key=value arguments', async () => {
  const f = fixture();
  const notices: string[] = [];
  await routeCommand(
    {
      client: f.client,
      busy: () => false,
      open: () => {},
      notice: text => notices.push(text),
      reset: () => {},
      submit: () => true,
      exit: () => {},
    },
    '/config mode=dark syntaxHighlighting=false sidebar=true',
  );
  expect(f.client.getAppearance()).toMatchObject({mode: 'dark', syntaxHighlighting: false, sidebar: true});
  expect(notices).toEqual(['Updated mode.', 'Updated syntaxHighlighting.', 'Updated sidebar.']);
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
  await waitForFrame(view, frame => frame.includes('Memory saved.'));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({action: 'write', entry: {type: 'feedback', content: 'Prefer concise explanations'}});
  expect(view.lastFrame()).toContain('Memory saved.');
  await key(view, '!echo shell');
  await key(view, '\r');
  await waitForFrame(view, frame => frame.includes('SHELL_STREAM_MARKER') && frame.includes('Bash(echo shell)'));
  expect(view.lastFrame()).toContain('SHELL_STREAM_MARKER');
  expect(view.lastFrame()).toContain('Bash(echo shell)');
  await key(view, '\x1b');
  await waitForFrame(view, frame => frame.includes('Shell cancelled'));
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
  expect(view.lastFrame()).toContain('Esc to cancel · Tab to amend');
  // The dialog opens asynchronously; allow Ink to attach its passive input subscriptions.
  await settle();
  await key(view, '\t');
  await key(view, 'Use another file');
  await key(view, '\r');
  await settle();
  expect(feedback).toEqual(['Permission denied. User feedback: Use another file']);
  expect(view.lastFrame()).toContain('Read deny');
  expect(f.client.listPendingPermissions()).toEqual([]);
  view.unmount();
});

test('picker remembers selection across overlay mounts and themes preview on highlight inside the dialog', async () => {
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
  expect(view.lastFrame()).toMatch(/❯ +Beta/);
  await key(view, '\x1b');
  await key(view, 't');
  await key(view, '\x1b[B');
  // The preview is dialog-local (ADR 0127): highlighting never previews through the engine.
  expect(engine.isPreviewing()).toBe(false);
  view.stdin.write('\x1b');
  await settle();
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

test('the signed-out composer can open Connect and choose a model', async () => {
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
  expect(view.lastFrame()).toContain('manual mode on');
  await key(view, '/connect');
  await key(view, '\r');
  await key(view, '\r');
  await settle();
  await key(view, '\r');
  await settle();
  await key(view, 'fixture-private-key');
  await key(view, '\r');
  await settle();
  expect(connected, view.lastFrame()).toBe(true);
  expect(view.lastFrame()).toContain('Model / Reasoning effort');
  expect(view.lastFrame()).not.toContain('fixture-private-key');
  expect(f.checks()).toBe(1);
  await key(view, '\r');
  await settle();
  await key(view, '\r');
  await settle();
  expect(f.checks()).toBe(1);
  expect(view.lastFrame()).toContain('manual mode on');
  view.unmount();
  expect(f.client.toolsEnabled()).toBe(false);
});

test('host orders one spinner then live todos, toggles without mutation, and guards global shortcuts', async () => {
  const plan = {
    updatedAt: '2026-11-19T00:00:00Z',
    items: [{step: 'LIVE_TODO', status: 'in_progress' as const}],
  };
  let finish = () => {};
  const wait = new Promise<void>(resolve => {
    finish = resolve;
  });
  const f = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'session-1', selection, messages: []}),
    getPlan: () => plan,
    async *sendTurn() {
      yield {type: 'textDelta', text: 'Working'};
      await wait;
      yield {type: 'textDelta', text: ' done'};
    },
  });
  const view = render(<InkApp client={f.client} width={90} />);
  try {
    await settle();
    await key(view, '\x1b[A');
    await key(view, '\r');
    await untilReady(view);
    await key(view, '?');
    expect(view.lastFrame()).toContain('ctrl+t to toggle tasks');
    await key(view, '\x1b[Z');
    expect(f.client.permissionMode()).toBe('default');
    expect(view.lastFrame()).not.toContain('ctrl+t to toggle tasks');
    await key(view, '?');
    await key(view, '\x0f');
    expect(view.lastFrame()).not.toContain('Transcript history');
    await key(view, 'inspect');
    await key(view, '\r');
    const frame = view.lastFrame()!;
    // One spinner line, then the live todos, then the prompt; `esc to interrupt` lives in the footer below it.
    const spinner = /^[·✢✳✶✻✽] \S+…/m;
    expect(frame.match(new RegExp(spinner.source, 'gm'))).toHaveLength(1);
    expect(frame.search(spinner)).toBeLessThan(frame.indexOf('LIVE_TODO'));
    expect(frame.split('esc to interrupt')).toHaveLength(2);
    expect(frame.indexOf('LIVE_TODO')).toBeLessThan(frame.lastIndexOf('❯'));
    expect(frame.lastIndexOf('❯')).toBeLessThan(frame.indexOf('esc to interrupt'));
    await key(view, '\x14');
    expect(view.lastFrame()).not.toContain('LIVE_TODO');
    expect(view.lastFrame()).not.toContain('Theme');
    expect(f.client.plan()).toEqual(plan);
    await key(view, '\x14');
    expect(view.lastFrame()).toContain('LIVE_TODO');
    await key(view, '\x0f');
    await key(view, '\x14');
    await key(view, '\x1b');
    expect(view.lastFrame()).toContain('LIVE_TODO');
    finish();
    await settle();
    expect(view.lastFrame()).not.toContain('LIVE_TODO');
    expect(f.client.plan()).toEqual(plan);
  } finally {
    finish();
    view.unmount();
  }
});

test('ready Ctrl+C confirms before shutdown and Ctrl+S stashes the draft without opening sessions', async () => {
  const f = dialogFixture({validateAccount: async () => ({models: 1, validation: 'fixture'})});
  const view = render(<InkApp client={f.client} width={90} />);
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  await untilReady(view);
  await key(view, 'preserved draft');
  await key(view, '\x13');
  expect(view.lastFrame()).not.toContain('Sessions');
  await key(view, '\x13');
  expect(view.lastFrame()).toContain('preserved draft');
  // First Ctrl+C clears the text (Ctrl+Y brings it back) and does not arm the exit.
  await key(view, '\x03');
  expect(view.lastFrame()).toContain('ctrl+y to paste deleted text');
  expect(view.lastFrame()).not.toContain('preserved draft');
  expect(f.client.toolsEnabled()).toBe(true);
  // On an empty prompt the next press asks for confirmation, the one after exits.
  await key(view, '\x03');
  expect(view.lastFrame()).toContain('Press Ctrl-C again to exit');
  expect(f.client.toolsEnabled()).toBe(true);
  await key(view, '\x03');
  expect(f.client.toolsEnabled()).toBe(false);
  view.unmount();
});

test('startup helper accepts a pending settings-trust dialog without granting it or waiting for the composer', async () => {
  const f = dialogFixture({
    startSession: () => ({id: 'trust-session', selection, messages: []}),
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
  });
  const request = f.client.enqueuePermissionRequest({
    capability: 'settings.trust',
    action: 'Trust repository project settings',
    target: '.futryn/settings.json',
    reason: 'allow rule: Bash(npm test:*)',
    decisions: ['session', 'always'],
  });
  const tui = await openInk(f.client);
  try {
    await tui.nextPermission();
    expect(f.client.userInputReady()).toBe(true);
    expect(f.client.listPendingPermissions().map(p => p.approvalId)).toEqual([request.approvalId]);
    expect(tui.frame()).toContain('Trust settings');
    expect(tui.frame()).toContain('2. Yes, always trust this content (by hash)');
    expect(tui.frame()).not.toContain('Type to filter');
    await tui.press('\x1b');
    expect(f.client.listPendingPermissions()).toEqual([]);
    expect(f.client.listPermissions()[0]?.status).toBe('denied');
    expect(f.client.listToolGrants()).toEqual([]);
  } finally {
    await tui.close();
  }
});

test('launch bypass mode retains the new footer and resolves an ask without opening a prompt', async () => {
  const f = dialogFixture({
    permissionMode: 'bypassPermissions',
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
  });
  const view = render(<InkApp client={f.client} width={90} />);
  try {
    await settle();
    await key(view, '\x1b[A');
    await key(view, '\r');
    expect(f.client.permissionMode()).toBe('bypassPermissions');
    expect(view.lastFrame()).toContain('  ⏵⏵ bypass permissions on (shift+tab to cycle)');
    expect(
      await f.client.requestPermission({
        capability: 'fs.read',
        action: 'read .env',
        target: '.env',
        reason: 'secret',
        decisions: ['once', 'session'],
      }),
    ).toBe('once');
    expect(f.client.listPendingPermissions()).toEqual([]);
  } finally {
    view.unmount();
  }
});

test('a question and a picker keep the live transcript visible and restore the draft', async () => {
  let client: ReturnType<typeof dialogFixture>['client'];
  const f = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'question-session', selection, messages: []}),
    async *sendTurn() {
      yield {type: 'textDelta', text: 'LIVE_BEFORE_QUESTION'};
      await client.askUser([
        {
          id: 'choice',
          header: 'Direction',
          question: 'Which direction?',
          options: [{label: 'Continue', description: 'Keep going'}],
        },
      ]);
      yield {type: 'textDelta', text: ' FINISHED_AFTER_QUESTION'};
    },
  });
  client = f.client;
  const tui = await openInk(client);
  try {
    await tui.submitPrompt('question please');
    await tui.waitFor('☐ Direction');
    expect(tui.frame()).toContain('LIVE_BEFORE_QUESTION');
    expect(tui.frame().indexOf('LIVE_BEFORE_QUESTION')).toBeLessThan(tui.frame().indexOf('☐ Direction'));
    expect(tui.frame()).not.toContain('manual mode on');
    expect(tui.frame()).not.toContain('esc to interrupt');
    await tui.press('\x1b');
    await tui.idle();
    await tui.type('DRAFT_SURVIVES_PICKER');
    await tui.press('\x1bp');
    await tui.waitFor('Model / Reasoning effort'); // Alt+P opens the model picker and keeps the draft
    expect(tui.frame()).toContain('LIVE_BEFORE_QUESTION');
    expect(tui.frame()).not.toContain('DRAFT_SURVIVES_PICKER');
    await tui.press('\x1b');
    await tui.waitFor('manual mode on');
    expect(tui.frame()).toContain('DRAFT_SURVIVES_PICKER');
  } finally {
    await tui.close();
  }
});

test('slash commands leave their result under ❯ /cmd; Esc on a panel prints a cancellation; Esc Esc and /rewind open Rewind', async () => {
  const f = dialogFixture({validateAccount: async () => ({models: 1, validation: 'fixture'})});
  const view = render(<InkApp client={f.client} width={90} />);
  try {
    await settle();
    await key(view, '\x1b[A');
    await key(view, '\r');
    await untilReady(view);
    await key(view, '/help');
    await key(view, '\r');
    await settle();
    expect(view.lastFrame()).toContain('Custom commands');
    await key(view, '\x1b');
    // The result line sits directly under the command, with no blank row between them.
    expect(view.lastFrame()).toMatch(/❯ \/help\n  ⎿\s+Closed help/);
    await key(view, '/cost');
    await key(view, '\r');
    await settle();
    expect(view.lastFrame()).toContain('API estimate');
    await key(view, '\x1b');
    await key(view, '/rewind');
    await key(view, '\r');
    await settle();
    expect(view.lastFrame()).toContain('Restore the code and/or conversation');
    await key(view, '\x1b');
    expect(view.lastFrame()).toMatch(/❯ \/rewind\n  ⎿\s+Rewind cancelled/);
    // Esc Esc on an empty prompt is the same panel.
    await key(view, '\x1b');
    await settle();
    await key(view, '\x1b');
    await settle();
    expect(view.lastFrame()).toContain('Restore the code and/or conversation');
  } finally {
    view.unmount();
  }
});

test('Ctrl+O shows the detailed transcript footer and Esc leaves it; the composer keeps its draft', async () => {
  const f = dialogFixture({validateAccount: async () => ({models: 1, validation: 'fixture'})});
  const view = render(<InkApp client={f.client} width={90} />);
  try {
    await settle();
    await key(view, '\x1b[A');
    await key(view, '\r');
    await untilReady(view);
    await key(view, 'keep this');
    await key(view, '\x0f');
    expect(view.lastFrame()).toContain('Showing detailed transcript');
    expect(view.lastFrame()).toContain('verbose');
    await key(view, '\x1b');
    expect(view.lastFrame()).not.toContain('Showing detailed transcript');
    expect(view.lastFrame()).toContain('keep this');
  } finally {
    view.unmount();
  }
});

test('a model without project tools keeps a persistent chat-only warning after a text reply', async () => {
  const {model} = await import('../features/picker/test-fixture');
  const f = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    cachedModels: () => [{...model, capabilities: {...model.capabilities, tools: 'unsupported'}}],
    startSession: () => ({id: 'chat-only', selection, messages: []}),
    async *sendTurn() {
      yield {type: 'textDelta', text: 'A plain chat reply.'};
    },
  });
  const tui = await openInk(f.client, {width: 100, rows: 30});
  try {
    expect(tui.frame()).toContain('Chat only: project tools are unavailable');
    await tui.submitPrompt('hello');
    expect(tui.frame()).toContain('A plain chat reply.');
    expect(tui.frame()).toContain('Chat only: project tools are unavailable');
    expect(tui.frame()).not.toContain('Tools are now off');
  } finally {
    await tui.shutdown();
  }
});

test('an MCP refresh before the next frame cannot silently consume a file approval dialog', async () => {
  let client: ReturnType<typeof dialogFixture>['client'];
  const f = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'approval-ui', selection, messages: []}),
    async *sendTurn(_id, _content, signal) {
      const approval = client.requestPermission(
        {
          capability: 'fs.write',
          action: 'Write draft.txt',
          target: 'draft.txt',
          reason: 'Approve a project file write',
          kind: 'edit',
          requiresApproval: true,
        },
        signal,
      );
      // This is the synchronous broadcast that previously denied the request before React painted it.
      client.invalidateMcpPermissions();
      const decision = await approval;
      yield {type: 'textDelta', text: `Approval decision: ${decision}`};
    },
  });
  client = f.client;
  const tui = await openInk(client, {width: 100, rows: 30});
  try {
    const pending = tui.submitPrompt('prepare a file change');
    await tui.nextPermission();
    expect(tui.frame()).toContain('draft.txt');
    expect(tui.frame()).toContain('Yes');
    expect(tui.frame()).not.toContain('Approval decision:');
    await tui.handleKey('Enter');
    await pending;
    expect(tui.frame()).toContain('Approval decision: once');
  } finally {
    await tui.shutdown();
  }
});

test('native text-selection shortcut preserves draft and pending approval', async () => {
  let clears = 0;
  const f = dialogFixture({
    toolGrants: {
      list: () => [],
      clear: () => {
        clears++;
      },
    },
  });
  const tui = await openInk(f.client, {width: 100, rows: 30});
  try {
    await tui.type('keep this draft');
    const before = clears;
    const approval = f.client.requestPermission({
      capability: 'fs.write',
      action: 'Write copy-test.txt',
      target: 'copy-test.txt',
      reason: 'fixture',
    });
    await tui.nextPermission();
    const request = f.client.listPendingPermissions()[0]!;
    await tui.press('\x11');
    expect(f.client.listPendingPermissions().map(p => p.approvalId)).toContain(request.approvalId);
    expect(clears).toBe(before);
    expect(tui.frame()).toContain('Text selection enabled');
    f.client.resolvePermission(request.approvalId, request.scopeHash, 'deny');
    await approval;
    await tui.idle();
    expect(tui.frame()).toContain('Text selection enabled');
    expect(tui.frame()).toContain('keep this draft');
    await tui.press('\x11');
    expect(tui.frame()).not.toContain('Text selection enabled');
    expect(tui.frame()).toContain('keep this draft');
  } finally {
    await tui.shutdown();
  }
});

test('selection mode does not cancel a running model response', async () => {
  let release!: () => void;
  let aborted = false;
  const done = new Promise<void>(resolve => {
    release = resolve;
  });
  const f = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'fixture'}),
    startSession: () => ({id: 'copy-stream', selection, messages: []}),
    async *sendTurn(_id, _content, signal) {
      signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        {once: true},
      );
      yield {type: 'textDelta', text: 'COPY_STREAM_START'};
      await done;
      yield {type: 'textDelta', text: ' COPY_STREAM_END'};
    },
  });
  const tui = await openInk(f.client, {width: 100, rows: 30});
  try {
    const pending = tui.submitPrompt('stream a response');
    await tui.waitFor('COPY_STREAM_START');
    await tui.press('\x11');
    expect(tui.frame()).toContain('Text selection enabled');
    expect(aborted).toBe(false);
    release();
    await pending;
    expect(tui.frame()).toContain('COPY_STREAM_END');
    expect(aborted).toBe(false);
  } finally {
    release();
    await tui.shutdown();
  }
});
