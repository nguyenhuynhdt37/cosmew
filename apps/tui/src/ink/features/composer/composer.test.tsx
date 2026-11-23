/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {dialogFixture, selection} from '../picker/test-fixture';
import {InputScope} from '../../hooks';
import {createClientFixture, renderInk, settle} from '../../testing';
import {Composer, ComposerView, useComposer, type ComposerController, type ComposerOptions} from './index';

afterEach(cleanup);
let controller: ComposerController;
function Harness(props: ComposerOptions & {width?: number}) {
  const state = useComposer({...props, inputWidth: (props.width ?? 48) - 7});
  controller = state;
  return <ComposerView controller={state} width={props.width ?? 48} />;
}
async function key(view: ReturnType<typeof renderInk>, input: string) {
  view.stdin.write(input);
  await settle();
}

test('Composer renders full-width rules, placeholder, mode footer and edits a Unicode draft in place', async () => {
  const sent: string[] = [];
  const view = renderInk(
    <Composer
      width={48}
      placeholder="Describe a change"
      onSubmit={text => {
        sent.push(text);
      }}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('─'.repeat(48));
  expect(view.lastFrame()).toContain('Describe a change');
  expect(view.lastFrame()).toContain('⏸ manual mode on');
  await key(view, 'hello');
  await key(view, '\u001b[D');
  await key(view, 'X');
  await key(view, '\r');
  expect(sent).toEqual(['hellXo']);
  expect(view.lastFrame()).toContain('Describe a change');
  expect(view.lastFrame()).not.toContain('\u001b');
});
test('backslash Enter, Shift+Enter, Alt+Enter and Ctrl+J insert newlines, not turns', async () => {
  const sent: string[] = [];
  const view = renderInk(
    <Harness
      onSubmit={text => {
        sent.push(text);
      }}
    />,
  );
  await settle();
  await key(view, 'one\\');
  await key(view, '\r');
  await key(view, 'two');
  await key(view, '\u001b[13;2u');
  await key(view, 'three');
  await key(view, '\u001b\r');
  await key(view, 'four');
  await key(view, '\n');
  await key(view, 'five');
  expect(sent).toEqual([]);
  expect(controller.content).toBe('one\ntwo\nthree\nfour\nfive');
  await key(view, '\r');
  expect(sent).toEqual(['one\ntwo\nthree\nfour\nfive']);
});
test('Ctrl+A/E/K/U/W and Shift selection keep edits inside the draft', async () => {
  const view = renderInk(<Harness initialValue="hello world tail" onSubmit={() => {}} />);
  await settle();
  await key(view, '\u0001');
  expect(controller.draft.cursor).toBe(0);
  await key(view, '\u0005');
  await key(view, '\u0017');
  expect(controller.content).toBe('hello world ');
  await key(view, '\u001b[D');
  await key(view, '\u000b');
  expect(controller.content).toBe('hello world');
  await key(view, '\u001b[1;2D');
  await key(view, 'X');
  expect(controller.content).toBe('hello worlX');
  await key(view, '\u0015');
  expect(controller.content).toBe('');
});
test('history restores unsent draft; Ctrl+R opens a filter panel that only changes the draft on Enter', async () => {
  const sent: string[] = [];
  const view = renderInk(
    <Harness
      initialValue="draft"
      initialHistory={['alpha one', 'beta', 'alpha two']}
      onSubmit={text => {
        sent.push(text);
      }}
    />,
  );
  await settle();
  await key(view, '\u001b[A');
  expect(controller.content).toBe('alpha two');
  await key(view, '\u001b[B');
  expect(controller.content).toBe('draft');
  await key(view, '\u0012');
  expect(view.lastFrame()).toContain('Search prompts · session');
  // The search starts from the typed text (reference behaviour); clear it to see every prompt.
  expect(view.lastFrame()).toContain('⌕ draft');
  await key(view, '\x7f\x7f\x7f\x7f\x7f');
  expect(view.lastFrame()).toContain('Filter history…');
  await key(view, 'alpha');
  expect(controller.content).toBe('draft');
  expect(view.lastFrame()).toContain('❯ alpha two');
  await key(view, '\u001b[A');
  expect(view.lastFrame()).toContain('❯ alpha one');
  await key(view, '\u001b[B');
  expect(view.lastFrame()).toContain('❯ alpha two');
  await key(view, '\u0012');
  expect(view.lastFrame()).toContain('❯ alpha one');
  controller.interrupt();
  await settle();
  expect(controller.search).toBeNull();
  expect(controller.content).toBe('draft');
  await key(view, '\u0012');
  await key(view, '\x7f\x7f\x7f\x7f\x7f');
  await key(view, 'beta');
  await key(view, '\r');
  expect(sent).toEqual([]);
  expect(controller.search).toBeNull();
  expect(controller.content).toBe('beta');
  await key(view, '\r');
  expect(sent).toEqual(['beta']);
});
test('history panel cycles scope and Ctrl+C closes it keeping the draft', async () => {
  const view = renderInk(<Harness initialValue="mine" initialHistory={['one']} onSubmit={() => {}} />);
  await settle();
  await key(view, '\u0012');
  await key(view, '\u0013');
  expect(view.lastFrame()).toContain('Search prompts · project');
  expect(controller.content).toBe('mine');
  expect(controller.confirmExit()).toBe(false);
  await settle();
  expect(controller.search).toBeNull();
  expect(controller.content).toBe('mine');
});
test('restored SDK session user messages seed composer history', async () => {
  const fixture = createClientFixture({
    startSession: () => ({
      id: 'session',
      selection: {accountId: 'a', modelId: 'm'},
      messages: [
        {role: 'user', content: 'saved request'},
        {role: 'assistant', content: 'answer'},
      ],
    }),
  });
  fixture.client.createSession();
  const view = renderInk(<Harness onSubmit={() => {}} />, {fixture});
  await settle();
  await key(view, '\u001b[A');
  expect(controller.content).toBe('saved request');
});
test('bracketed paste never executes embedded shell, commands or control shortcuts and sends full text', async () => {
  const sent: string[] = [];
  const content = 'intro\n!echo evil\n/help\n$skill\nlast';
  const view = renderInk(
    <Harness
      onSubmit={text => {
        sent.push(text);
      }}
    />,
  );
  await settle();
  await key(view, '\u001b[200~' + content + '\u001b[201~');
  expect(sent).toEqual([]);
  expect(view.lastFrame()).toContain('[Pasted text #1 +4 lines]');
  expect(controller.content).toBe(content);
  await key(view, '\r');
  expect(sent).toEqual([content]);
});
test('a complete alias is dispatched as typed (the host maps /cost to its Stats tab); arguments and explicit unknown commands are retained', async () => {
  const commands: string[] = [];
  const view = renderInk(
    <Harness
      onSubmit={() => {
        throw Error('not a prompt');
      }}
      onCommand={text => {
        commands.push(text);
      }}
    />,
  );
  await settle();
  await key(view, '/cost');
  await key(view, '\r');
  expect(commands).toEqual(['/cost']);
  await key(view, '/compact keep API');
  await key(view, '\r');
  expect(commands).toEqual(['/cost', '/compact keep API']);
  await key(view, '/does-not-exist args');
  await key(view, '\r');
  expect(commands.at(-1)).toBe('/does-not-exist args');
});
test('file suggestions stay gated before consent, replace only mention, and keep suffix', async () => {
  let reads = 0;
  const fixture = createClientFixture({
    listWorkspaceFiles: () => {
      reads++;
      return ['src/main.ts', 'src/test.ts'];
    },
  });
  const view = renderInk(<Harness initialValue="read @src tail" onSubmit={() => {}} />, {fixture});
  await settle();
  controller.setDraft({...controller.draft, cursor: 9});
  await settle();
  expect(reads).toBe(0);
  view.rerender(<Harness initialValue="read @src tail" workspaceAccess onSubmit={() => {}} />);
  await settle();
  await key(view, '\t');
  expect(reads).toBeGreaterThan(0);
  expect(controller.content).toBe('read @src/main.ts tail');
  expect(controller.draft.cursor).toBe('read @src/main.ts '.length);
});
test('skill slash and dollar completion come from the public SDK catalog', async () => {
  let catalogReads = 0;
  const fixture = createClientFixture({
    skills: () => {
      catalogReads++;
      return {
        skills: [
          {
            name: 'reviewer',
            description: 'Review changes',
            source: 'user',
            path: '/skills/reviewer/SKILL.md',
            shortPath: 'reviewer',
            directory: '/skills/reviewer',
            disableModelInvocation: false,
          },
        ],
        errors: [],
        warnings: [],
      };
    },
  });
  fixture.client.setToolsEnabled(true);
  const sent: string[] = [];
  const view = renderInk(
    <Harness
      onSubmit={text => {
        sent.push(text);
      }}
    />,
    {fixture},
  );
  await settle();
  await key(view, '$re');
  await key(view, 'v');
  expect(catalogReads).toBe(1);
  await key(view, '\t');
  expect(controller.content).toBe('$reviewer ');
  await key(view, '\r');
  expect(sent).toEqual(['$reviewer']);
  await key(view, '/reviewer');
  await key(view, '\r');
  expect(sent.at(-1)).toBe('/reviewer');
});
test('unavailable memory writes and failed submission preserve the exact full draft', async () => {
  const view = renderInk(<Harness initialValue="#remember this" onSubmit={() => false} />);
  await settle();
  await key(view, '\r');
  expect(controller.content).toBe('#remember this');
  expect(view.lastFrame()).toContain('Not implemented');
  controller.setDraft({...controller.draft, value: 'keep me', cursor: 7});
  await settle();
  await key(view, '\r');
  expect(controller.content).toBe('keep me');
  view.rerender(
    <Harness
      onSubmit={() => {
        throw new Error('failure with private output');
      }}
    />,
  );
  await settle();
  await key(view, '\r');
  expect(controller.content).toBe('keep me');
  expect(view.lastFrame()).not.toContain('private output');
});
test('input and paste are disabled behind an overlay scope, preserving mounted state', async () => {
  const view = renderInk(
    <InputScope active={false}>
      <Harness
        initialValue="draft"
        onSubmit={() => {
          throw Error('inactive');
        }}
      />
    </InputScope>,
  );
  await settle();
  await key(view, 'new');
  await key(view, '\u001b[200~a\nb\nc\nd\ne\u001b[201~');
  await key(view, '\r');
  expect(controller.content).toBe('draft');
});
test('resize wraps wide text into bounded input rows while keeping the caret visible', async () => {
  const view = renderInk(<Harness initialValue={'你好世界'.repeat(20)} width={48} onSubmit={() => {}} />);
  await settle();
  view.rerender(<Harness width={20} onSubmit={() => {}} />);
  await settle();
  expect(view.lastFrame()).toContain('─'.repeat(20));
  expect(controller.content).toBe('你好世界'.repeat(20));
  const lines = view.lastFrame()!.split('\n');
  const top = lines.indexOf('─'.repeat(20));
  const bottom = lines.indexOf('─'.repeat(20), top + 1);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeGreaterThan(top);
  const panelLines = lines.slice(top, bottom + 1);
  expect(lines.every(line => Bun.stringWidth(line) <= 20)).toBe(true);
  expect(panelLines.every(line => Bun.stringWidth(line) <= 20)).toBe(true);
  expect(panelLines.length).toBeLessThanOrEqual(8);
});

test('steering goes through the real SDK and clears only durably accepted input', async () => {
  const steered: string[] = [];
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => {
    finish = resolve;
  });
  const fixture = createClientFixture({
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
    async *sendTurn() {
      await waiting;
      yield {type: 'textDelta', text: 'done'};
    },
    steerTurn: (_id, content) => {
      steered.push(content);
      return {accepted: true, turnId: 't', steerId: 'st'};
    },
  });
  const iterator = fixture.client.sendMessage('original')[Symbol.asyncIterator]();
  const pending = iterator.next();
  const view = renderInk(
    <Harness
      busy
      onSubmit={() => {
        throw Error('must steer');
      }}
    />,
    {fixture},
  );
  await settle();
  await key(view, 'new direction');
  await key(view, '\r');
  expect(steered).toEqual(['new direction']);
  expect(controller.content).toBe('');
  await key(view, '!echo unsafe');
  await key(view, '\r');
  expect(controller.content).toBe('!echo unsafe');
  expect(steered).toEqual(['new direction']);
  finish();
  await pending;
  await iterator.return?.();
});
test('finishing-turn input uses the SDK queue, while unavailable queues preserve draft', async () => {
  let finish!: () => void;
  const wait = new Promise<void>(resolve => {
    finish = resolve;
  });
  const queued: {id: string; content: string}[] = [];
  const fixture = createClientFixture({
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
    async *sendTurn() {
      await wait;
      yield {type: 'textDelta', text: 'done'};
    },
    steerTurn: () => ({accepted: false, reason: 'no_active_turn'}),
    enqueueNextTurn: (_id, content) => {
      const entry = {id: 'q', content};
      queued.push(entry);
      return entry;
    },
    listNextTurn: () => queued,
  });
  const iterator = fixture.client.sendMessage('original')[Symbol.asyncIterator]();
  const pending = iterator.next();
  const view = renderInk(
    <Harness
      busy
      onSubmit={() => {
        throw Error('must queue');
      }}
    />,
    {fixture},
  );
  await settle();
  await key(view, 'later');
  await key(view, '\r');
  expect(fixture.client.queuedMessages()).toEqual(['later']);
  expect(controller.content).toBe('');
  fixture.ports.enqueueNextTurn = undefined;
  await key(view, 'retained');
  await key(view, '\r');
  expect(controller.content).toBe('retained');
  expect(controller.notice).toContain('queue_unavailable');
  finish();
  await pending;
  await iterator.return?.();
});
test('shell uses SDK execution with cancellation and renders denial without fake success', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const fixture = createClientFixture({
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
    runShellCommand: async (_command, executionSignal) => {
      calls++;
      signal = executionSignal;
      await new Promise<void>(resolve => executionSignal!.addEventListener('abort', () => resolve(), {once: true}));
      return {name: 'exec_command', callId: 'sh', status: 'denied', code: 'POLICY', content: 'denied'};
    },
  });
  fixture.client.setToolsEnabled(true);
  const view = renderInk(
    <Harness
      initialValue="!echo hello"
      workspaceAccess
      onSubmit={() => {
        throw Error('shell is not a prompt');
      }}
    />,
    {fixture},
  );
  await settle();
  await key(view, '\r');
  expect(calls).toBe(1);
  expect(controller.busy).toBe(true);
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(signal?.aborted).toBe(true);
  expect(controller.content).toBe('!echo hello');
  expect(controller.notice).toContain('Shell denied');
});
test('shell cannot bypass folder consent or SDK policy, and unmount aborts owned work', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const fixture = createClientFixture({
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
    runShellCommand: async (_command, executionSignal) => {
      calls++;
      signal = executionSignal;
      await new Promise<void>(resolve => executionSignal!.addEventListener('abort', () => resolve(), {once: true}));
      return {name: 'exec_command', callId: 'sh', status: 'error', code: 'CANCELLED', content: 'cancelled'};
    },
  });
  fixture.client.setToolsEnabled(true);
  const view = renderInk(<Harness initialValue="!echo hello" onSubmit={() => {}} />, {fixture});
  await settle();
  await key(view, '\r');
  expect(calls).toBe(0);
  view.rerender(<Harness workspaceAccess onSubmit={() => {}} />);
  await settle();
  await key(view, '\r');
  expect(calls).toBe(1);
  view.unmount();
  await settle();
  expect(signal?.aborted).toBe(true);
});
test('Shell owns Esc and calls composer interrupt before cancelling host generation', async () => {
  const view = renderInk(<Harness initialValue="draft" onSubmit={() => {}} />);
  await settle();
  await key(view, '\u001b');
  expect(controller.content).toBe('draft');
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(controller.content).toBe('draft');
  expect(controller.notice).toBe('Esc again to clear');
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(controller.content).toBe('');
  view.rerender(<Harness busy onSubmit={() => {}} />);
  await settle();
  expect(controller.interrupt()).toBe(false);
});
test('failed history search restores draft instead of selecting the previous unrelated match', async () => {
  const view = renderInk(
    <Harness initialValue="original draft" initialHistory={['old request']} onSubmit={() => {}} />,
  );
  await settle();
  await key(view, '\u0012');
  await key(view, 'missing');
  expect(view.lastFrame()).toContain('No match');
  await key(view, '\r');
  expect(controller.content).toBe('original draft');
});
test('tiny terminal fallback never widens beyond the requested column count', async () => {
  const view = renderInk(<Harness width={3} initialValue="你好hello" onSubmit={() => {}} />);
  await settle();
  expect(
    view
      .lastFrame()!
      .split('\n')
      .every(line => Bun.stringWidth(line) <= 3),
  ).toBe(true);
});
test('skill completion preserves the full pasted argument beyond the cursor', async () => {
  const fixture = createClientFixture({
    skills: () => ({
      skills: [
        {
          name: 'deployer',
          description: 'Deploy',
          source: 'user',
          path: '/s/SKILL.md',
          shortPath: 's',
          directory: '/s',
          disableModelInvocation: false,
        },
      ],
      errors: [],
      warnings: [],
    }),
  });
  fixture.client.setToolsEnabled(true);
  const sent: string[] = [];
  const view = renderInk(
    <Harness
      initialValue="/depl "
      onSubmit={text => {
        sent.push(text);
      }}
    />,
    {fixture},
  );
  await settle();
  controller.paste('a\nb\nc\nd\ne');
  await settle();
  controller.setDraft({...controller.draft, cursor: 5});
  await settle();
  await key(view, '\r');
  expect(sent).toEqual(['/deployer a\nb\nc\nd\ne']);
});

test('a host-rendered shell success has no duplicate footer or persistent status notice', async () => {
  const notices: string[] = [];
  const results: unknown[] = [];
  const fixture = createClientFixture({
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
    runShellCommand: async () => ({name: 'exec_command', callId: 'sh', status: 'ok', content: 'marker', exitCode: 0}),
  });
  fixture.client.setToolsEnabled(true);
  const view = renderInk(
    <Harness
      initialValue="!echo marker"
      workspaceAccess
      onSubmit={() => {
        throw Error('shell is not a model prompt');
      }}
      onShellResult={result => results.push(result)}
      onNotice={text => notices.push(text)}
    />,
    {fixture},
  );
  await settle();
  await key(view, '\r');
  expect(results).toHaveLength(1);
  expect(controller.content).toBe('');
  expect(controller.notice).toBe('');
  expect(notices).toEqual([]);
  expect(view.lastFrame()).not.toContain('Shell ok.');
});

test('shell and memory presentation preserve dispatch prefixes and use full-width rules', async () => {
  for (const [draft, displayed] of [
    ['!echo hello', '! echo hello'],
    ['#remember this', '❯ #remember this'],
  ] as const) {
    const view = renderInk(<Harness initialValue={draft} width={60} onSubmit={() => {}} />);
    await settle();
    expect(controller.content).toBe(draft);
    expect(view.lastFrame()).toContain(displayed);
    expect(view.lastFrame()!.split('─'.repeat(60))).toHaveLength(3);
    view.unmount();
  }
});

test('empty question mark opens shortcuts and consumes the closing key without submitting', async () => {
  const sent: string[] = [];
  const view = renderInk(
    <Harness
      width={100}
      onSubmit={text => {
        sent.push(text);
      }}
    />,
  );
  await settle();
  await key(view, '?');
  expect(controller.shortcuts).toBe(true);
  expect(controller.content).toBe('');
  expect(view.lastFrame()).toContain('! for shell mode');
  expect(view.lastFrame()).toContain('ctrl+t to toggle tasks');
  expect(view.lastFrame()).not.toContain('shift+↑/↓ to change effort');
  await key(view, 'x');
  expect(controller.shortcuts).toBe(false);
  expect(controller.content).toBe('');
  expect(sent).toEqual([]);
  await key(view, 'literal?');
  expect(controller.content).toBe('literal?');
});

test('undo restores exact collapsed paste metadata and Ctrl+S stashes and restores it', async () => {
  const view = renderInk(<Harness onSubmit={() => {}} />);
  await settle();
  controller.paste('one\ntwo\nthree\nfour\nfive');
  await settle();
  const pasted = structuredClone(controller.draft);
  await key(view, 'x');
  await key(view, '\x1f');
  expect(controller.draft).toEqual(pasted);
  expect(controller.content).toBe('one\ntwo\nthree\nfour\nfive');
  await key(view, '\x13');
  expect(controller.content).toBe('');
  await key(view, '\x13');
  expect(controller.draft).toEqual(pasted);
  expect(controller.content).toBe('one\ntwo\nthree\nfour\nfive');
});

test('an occupied stash rejects replacement and retains the original full draft', async () => {
  const view = renderInk(<Harness initialValue="original" onSubmit={() => {}} />);
  await settle();
  await key(view, '\x13');
  await key(view, 'competing');
  await key(view, '\x13');
  expect(controller.content).toBe('competing');
  expect(controller.notice).toContain('already stashed');
  controller.interrupt();
  controller.interrupt();
  await settle();
  expect(controller.content).toBe('');
  await key(view, '\x13');
  expect(controller.content).toBe('original');
});

test('double Esc and exit confirmation remain local and empty rewind reports unavailable', async () => {
  const notices: string[] = [];
  const view = renderInk(<Harness initialValue="draft" onSubmit={() => {}} onNotice={text => notices.push(text)} />);
  await settle();
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(controller.content).toBe('draft');
  expect(controller.notice).toBe('Esc again to clear');
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(controller.content).toBe('');
  expect(controller.confirmExit()).toBe(false);
  await settle();
  expect(controller.notice).toBe('Press Ctrl-C again to exit');
  expect(view.lastFrame()).toContain('  Press Ctrl-C again to exit');
  expect(controller.confirmExit()).toBe(true);
  expect(notices).toEqual([]);
  controller.interrupt();
  controller.interrupt();
  await settle();
  expect(controller.notice).toContain('Not implemented: conversation rewind');
});

test('task/model shortcuts preserve the draft and unsupported native bridges never send input', async () => {
  let toggles = 0;
  const commands: string[] = [];
  const sent: string[] = [];
  const view = renderInk(
    <Harness
      initialValue="keep me"
      onSubmit={text => {
        sent.push(text);
      }}
      onCommand={text => {
        commands.push(text);
      }}
      onToggleTasks={() => toggles++}
    />,
  );
  await settle();
  await key(view, '\x14');
  await key(view, '\x1bp');
  expect(toggles).toBe(1);
  expect(commands).toEqual(['/model']);
  for (const keyCode of ['\x07', '\x16', '\x1a']) {
    await key(view, keyCode);
    expect(controller.notice).toContain('Not implemented:');
    expect(controller.content).toBe('keep me');
  }
  expect(sent).toEqual([]);
});

test('advertised effort shortcuts update SDK preferences and reject during a live turn', async () => {
  let finish = () => {};
  const held = new Promise<void>(resolve => {
    finish = resolve;
  });
  const fixture = dialogFixture({
    startSession: () => ({id: 'effort', selection, messages: []}),
    async *sendTurn() {
      await held;
      yield {type: 'textDelta', text: 'done'};
    },
  });
  const view = renderInk(<Harness initialValue="draft" onSubmit={() => {}} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('◐ default · /effort');
  await key(view, '\x1b[1;2A');
  expect(fixture.client.status().reasoningEffort).toBe('low');
  await key(view, '\x1b[1;2A');
  expect(fixture.client.status().reasoningEffort).toBe('high');
  const stream = fixture.client.sendMessage('hold')[Symbol.asyncIterator]();
  const next = stream.next();
  await settle();
  await key(view, '\x1b[1;2B');
  expect(fixture.client.status().reasoningEffort).toBe('high');
  expect(controller.notice).toContain('Effort change rejected');
  expect(controller.content).toBe('draft');
  finish();
  await next;
  await stream.return?.();
});

test('Ctrl+R shows stored timestamps and Ctrl+S cycles session project everywhere without changing the draft', async () => {
  const scopes: string[] = [];
  const fixture = dialogFixture({
    promptHistory: ({scope}) => {
      scopes.push(scope);
      return [
        {
          id: scope,
          sessionId: 'stored',
          content: `${scope} request`,
          timestamp: new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString(),
        },
      ];
    },
  });
  const view = renderInk(<Harness initialValue="" width={100} onSubmit={() => {}} />, {fixture});
  await settle();
  await key(view, '\x12');
  expect(view.lastFrame()).toContain('Search prompts · everywhere');
  expect(view.lastFrame()).toContain('11h ago');
  expect(view.lastFrame()).toContain('everywhere request');
  await key(view, '\x13');
  expect(view.lastFrame()).toContain('Search prompts · session');
  expect(view.lastFrame()).toContain('session request');
  expect(view.lastFrame()).not.toContain('everywhere request');
  await key(view, '\x13');
  expect(view.lastFrame()).toContain('Search prompts · project');
  await key(view, '\r');
  expect(controller.content).toBe('project request');
  expect(scopes).toContain('project');
});
