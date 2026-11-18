/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
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

test('Composer renders rounded frame, placeholder, hints and edits a Unicode draft in place', async () => {
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
  expect(view.lastFrame()).toContain('╭');
  expect(view.lastFrame()).toContain('Describe a change');
  expect(view.lastFrame()).toContain('Ctrl+R');
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
test('history restores unsent draft, reverse search cycles and cancels without sending', async () => {
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
  await key(view, 'alpha');
  expect(controller.content).toBe('alpha two');
  await key(view, '\u0012');
  expect(controller.content).toBe('alpha one');
  await key(view, '\u0007');
  expect(controller.content).toBe('draft');
  await key(view, '\u0012');
  await key(view, 'beta');
  await key(view, '\r');
  expect(sent).toEqual([]);
  await key(view, '\r');
  expect(sent).toEqual(['beta']);
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
test('slash aliases dispatch canonical command; arguments and explicit unknown commands are retained', async () => {
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
  expect(commands).toEqual(['/usage']);
  await key(view, '/compact keep API');
  await key(view, '\r');
  expect(commands).toEqual(['/usage', '/compact keep API']);
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
  expect(controller.content).toBe('read @src/main.ts  tail');
});
test('skill slash and dollar completion come from the public SDK catalog', async () => {
  const fixture = createClientFixture({
    skills: () => ({
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
    }),
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
  await key(view, '$rev');
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
  expect(view.lastFrame()).toContain('╭');
  expect(controller.content).toBe('你好世界'.repeat(20));
  const panelLines = view
    .lastFrame()!
    .split('\n')
    .filter(line => /^[╭│╰]/.test(line));
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
  expect(controller.search?.index).toBe(-1);
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
  expect(sent).toEqual(['/deployer  a\nb\nc\nd\ne']);
});
