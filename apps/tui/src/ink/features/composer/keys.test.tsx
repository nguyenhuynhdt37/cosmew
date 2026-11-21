/** @jsxImportSource react */
import {afterEach, expect, setSystemTime, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {child, dialogFixture, selection} from '../picker/test-fixture';
import {buildKeymap, keymapStore} from '../../hooks';
import {renderInk, settle, waitForFrame} from '../../testing';
import {createPasteState} from '../paste';
import {ComposerView, useComposer, type ComposerController, type ComposerOptions} from './index';

afterEach(() => {
  cleanup();
  keymapStore.reset();
  setSystemTime();
});
let controller: ComposerController;
function Harness(props: ComposerOptions & {width?: number}) {
  const state = useComposer({...props, inputWidth: (props.width ?? 60) - 7});
  controller = state;
  return <ComposerView controller={state} width={props.width ?? 60} />;
}
async function key(view: ReturnType<typeof renderInk>, input: string) {
  view.stdin.write(input);
  await settle();
}
/** Each key is its own write (Ink decodes one chunk as one key press). */
async function keys(view: ReturnType<typeof renderInk>, ...inputs: string[]) {
  for (const input of inputs) await key(view, input);
}
/** Types text and a backslash-Enter newline. */
async function line(view: ReturnType<typeof renderInk>, text: string) {
  await key(view, `${text}\\`);
  await key(view, '\r');
}
const mount = async (
  props: Partial<ComposerOptions & {width: number}> = {},
  options: Parameters<typeof renderInk>[1] = {},
) => {
  const view = renderInk(<Harness onSubmit={() => {}} {...props} />, options);
  await settle();
  return view;
};
const ARROW = {up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C'};

test('Down can manage a foreground child even while a message is queued', async () => {
  const fixture = dialogFixture({
    startSession: () => ({id: 'queue-owner', selection, messages: []}),
    subagents: () => [{...child, background: false}],
    queuedInput: () => [{steerId: 'queued', content: 'follow up'}],
  });
  fixture.client.createSession();
  const view = await mount({busy: true}, {fixture});
  await key(view, ARROW.down);
  expect(view.lastFrame()).toContain('agent 1/1');
  expect(controller.queued).toEqual(['follow up']);
  expect(controller.content).toBe('');
});

test('Ctrl+D: text is edited, an empty input needs a second press within 800 ms', async () => {
  const view = await mount({initialValue: 'abc'});
  await key(view, '\x01'); // Ctrl+A
  expect(controller.pressEof()).toBe(false);
  await settle();
  expect(controller.content).toBe('bc'); // deleted the character after the cursor
  await key(view, '\x0b'); // Ctrl+K: empty it
  expect(controller.content).toBe('');
  const start = Date.now();
  setSystemTime(new Date(start));
  expect(controller.pressEof()).toBe(false);
  await settle();
  expect(view.lastFrame()).toContain('Press Ctrl-D again to exit');
  setSystemTime(new Date(start + 500));
  expect(controller.pressEof()).toBe(true);
  // A slow second press only re-arms.
  setSystemTime(new Date(start + 2000));
  expect(controller.pressEof()).toBe(false);
  setSystemTime(new Date(start + 3000));
  expect(controller.pressEof()).toBe(false);
});
test('Ctrl+C on text clears it for Ctrl+Y; an empty input shows the hint and exits on the second press within 800 ms', async () => {
  const view = await mount({initialValue: 'keep for later'});
  expect(controller.confirmExit()).toBe(false);
  await settle();
  expect(controller.content).toBe('');
  expect(view.lastFrame()).toContain('ctrl+y to paste deleted text');
  await key(view, '\x19');
  expect(controller.content).toBe('keep for later');
  await keys(view, '\x15', '\x15');
  const start = Date.now();
  setSystemTime(new Date(start));
  expect(controller.confirmExit()).toBe(false);
  setSystemTime(new Date(start + 900));
  expect(controller.confirmExit()).toBe(false); // too slow: only re-arms
  setSystemTime(new Date(start + 1200));
  expect(controller.confirmExit()).toBe(true);
});
test('Esc Esc clears the input and files the draft in the history; Up brings it back', async () => {
  const view = await mount({initialValue: 'half typed idea', initialHistory: ['older prompt']});
  expect(controller.interrupt()).toBe(true);
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(controller.content).toBe('');
  await key(view, ARROW.up);
  expect(controller.content).toBe('half typed idea');
  await key(view, ARROW.up);
  expect(controller.content).toBe('older prompt');
});
test('Up/Down move the caret through a multi-line input first, then walk the history', async () => {
  const view = await mount({initialHistory: ['older', 'newer']});
  await line(view, 'one');
  await line(view, 'two');
  await key(view, 'three');
  expect(controller.content).toBe('one\ntwo\nthree');
  await key(view, ARROW.up); // line 2
  expect(controller.draft.cursor).toBe('one\ntwo'.length);
  expect(controller.content).toBe('one\ntwo\nthree');
  await key(view, ARROW.up); // line 1
  expect(controller.draft.cursor).toBeLessThanOrEqual(3);
  expect(controller.content).toBe('one\ntwo\nthree');
  await key(view, ARROW.up); // already on the first line: now the history
  expect(controller.content).toBe('newer');
  await key(view, '\x0e'); // Ctrl+N is Down
  expect(controller.content).toBe('one\ntwo\nthree');
  await key(view, '\x10'); // Ctrl+P is Up
  expect(controller.content).toBe('newer');
});
test('Ctrl+X Enter submits the typed text even while a suggestion menu is selecting an item', async () => {
  const commands: string[] = [];
  const view = await mount({initialValue: '/he', onCommand: text => void commands.push(text)});
  expect(controller.items.length).toBeGreaterThan(0);
  await keys(view, '\x18', '\r');
  expect(commands).toEqual(['/he']);
});
test('Ctrl+Enter, and Ctrl+X Ctrl+S, send queued messages now; an idle draft is simply sent', async () => {
  let now = 0;
  const sent: string[] = [];
  const view = await mount({onSendQueuedNow: () => now++, onSubmit: text => void sent.push(text)});
  await key(view, '\x1b[13;5u'); // kitty Ctrl+Enter
  expect(now).toBe(1);
  await keys(view, '\x18', '\x13');
  expect(now).toBe(2);
  await key(view, 'idle draft');
  await keys(view, '\x18', '\x13');
  expect(sent).toEqual(['idle draft']);
  expect(now).toBe(2);
});
test('Ctrl+L asks the host to redraw and keeps the input', async () => {
  let redraws = 0;
  const view = await mount({initialValue: 'keep', onRedraw: () => redraws++});
  await key(view, '\x0c');
  expect(redraws).toBe(1);
  expect(controller.content).toBe('keep');
  const without = await mount({initialValue: 'keep'});
  await key(without, '\x0c');
  expect(controller.notice).toContain('Not implemented');
});
test('Ctrl+U/K/W kill text and join lines; Ctrl+Y, Alt+Y and consecutive kills use one ring entry', async () => {
  const view = await mount({initialValue: 'foo.bar baz-qux'});
  await key(view, '\x1bb'); // Alt+B: back one word (letters and digits make a word)
  expect(controller.draft.cursor).toBe('foo.bar baz-'.length);
  await key(view, '\x1bb');
  expect(controller.draft.cursor).toBe('foo.bar '.length);
  await key(view, '\x1bf'); // Alt+F: forward to the end of the word
  expect(controller.draft.cursor).toBe('foo.bar baz'.length);
  await key(view, '\x1bb');
  await key(view, '\x1bd'); // Alt+D: delete to the end of the word
  expect(controller.content).toBe('foo.bar -qux');
  await key(view, '\x17'); // Ctrl+W: back to the previous whitespace
  expect(controller.content).toBe('-qux');
  // Alt+D then Ctrl+W were consecutive kills: one ring entry holding both ("foo.bar baz" came out in two kills).
  await key(view, '\x19');
  expect(controller.content).toBe('foo.bar baz-qux');
  // Kill to the start of the line (Ctrl+U) and, repeated at a line start, join with the previous line.
  await key(view, '\x15');
  expect(controller.content).toBe('-qux');
  await key(view, '\x0b'); // Ctrl+K: to the end of the line
  expect(controller.content).toBe('');
  await line(view, 'a');
  await key(view, 'b');
  await key(view, '\x15'); // kills "b"
  expect(controller.content).toBe('a\n');
  await key(view, '\x15'); // at a line start: removes the newline
  expect(controller.content).toBe('a');
  // Ctrl+K at the end of a line removes the following newline, then Alt+Y cycles the ring.
  await key(view, '\x15');
  await key(view, '\x19');
  const first = controller.content;
  await key(view, '\x1by');
  expect(controller.content).not.toBe(first);
});
test('Option+Backspace and Ctrl+Backspace delete a word; Home/End and Ctrl+A/E use the logical line', async () => {
  const view = await mount({initialValue: 'alpha beta.gamma'});
  await key(view, '\x1b\x7f'); // Option+Delete as Meta+Backspace
  expect(controller.content).toBe('alpha beta.');
  await key(view, '\x1b[127;5u'); // kitty Ctrl+Backspace
  expect(controller.content).toBe('alpha ');
  await line(view, 'x');
  await key(view, 'second line');
  await key(view, '\x01'); // Ctrl+A: start of the logical line, not of the whole input
  expect(controller.draft.cursor).toBe('alpha x\n'.length);
  await key(view, '\x05');
  expect(controller.draft.cursor).toBe(controller.content.length);
  await key(view, '\x1b[H'); // Home
  expect(controller.draft.cursor).toBe('alpha x\n'.length);
  await key(view, '\x1b[F'); // End
  expect(controller.draft.cursor).toBe(controller.content.length);
});
test('Shift+arrows and Shift+Home extend the selection; typing replaces it', async () => {
  const view = await mount({initialValue: 'select me'});
  await key(view, '\x1b[1;2D');
  await key(view, '\x1b[1;2D');
  expect(controller.draft.selectionAnchor).toBe('select me'.length);
  expect(controller.draft.cursor).toBe('select me'.length - 2);
  await key(view, '\x1b[1;2H'); // Shift+Home
  expect(controller.draft.cursor).toBe(0);
  await key(view, 'X');
  // The anchor stays where the selection began: the whole text is replaced.
  expect(controller.content).toBe('X');
});
test('Ctrl+_ undoes edits one by one and restores the caret', async () => {
  const view = await mount();
  await key(view, 'one');
  await key(view, ' two');
  await key(view, '\x1f');
  expect(controller.content).toBe('one');
  expect(controller.draft.cursor).toBe(3);
  await key(view, '\x1f');
  expect(controller.content).toBe('');
});
test('Ctrl+S stashes a ! command and restores it with its bash mode', async () => {
  const view = await mount({initialValue: '!ls -la'});
  await key(view, '\x13');
  expect(controller.content).toBe('');
  expect(view.lastFrame()).not.toContain('! ls');
  await key(view, '\x13');
  expect(controller.content).toBe('!ls -la');
  expect(view.lastFrame()).toContain('! ls -la');
});
test('Ctrl+G, Ctrl+X Ctrl+E and Ctrl+Z call the host bridges; unsupported clipboard and provider toggles report limits, Ctrl+B reports no task', async () => {
  const calls: string[] = [];
  const view = await mount({
    initialValue: 'draft',
    onEditor: () => void calls.push('editor'),
    onSuspend: () => void calls.push('suspend'),
  });
  await key(view, '\x07');
  await keys(view, '\x18', '\x05');
  await key(view, '\x1a');
  expect(calls).toEqual(['editor', 'editor', 'suspend']);
  await key(view, '\x16');
  expect(view.lastFrame()).toContain('Not implemented: image clipboard');
  await key(view, '\x1bo');
  expect(view.lastFrame()).toContain('Not implemented: fast mode');
  await key(view, '\x1bt');
  expect(view.lastFrame()).toContain('Not implemented: extended-thinking');
  await key(view, '\x02');
  expect(controller.notice).toContain('No foreground task can be moved to background.');
  expect(controller.content).toBe('draft');
});
test('Ctrl+X Ctrl+K asks first and stops the background agents on a second press within 3 s', async () => {
  const stopped: string[] = [];
  const fixture = dialogFixture({
    startSession: () => ({id: 'agents', selection, messages: []}),
    subagents: () => [child, {...child, id: 'child-2', background: false}],
    stopSubagent: id => {
      stopped.push(id);
      return true;
    },
  });
  fixture.client.createSession();
  const view = await mount({}, {fixture});
  const start = Date.now();
  setSystemTime(new Date(start));
  await keys(view, '\x18', '\x0b');
  expect(view.lastFrame()).toContain('Press ctrl+x ctrl+k again to stop background agents');
  expect(stopped).toEqual([]);
  setSystemTime(new Date(start + 4000)); // too late: asks again
  await keys(view, '\x18', '\x0b');
  expect(stopped).toEqual([]);
  setSystemTime(new Date(start + 5000));
  await keys(view, '\x18', '\x0b');
  expect(stopped).toEqual(['child-1']); // only the background agent
  expect(controller.notice).toContain('Stopped 1 background agent');
});
test('footer: Down on an empty input selects the running agent; arrows move, x stops it, Esc leaves', async () => {
  const stopped: string[] = [];
  let opened = 0;
  const fixture = dialogFixture({
    startSession: () => ({id: 'agents', selection, messages: []}),
    subagents: () => [child, {...child, id: 'child-2', description: 'Second agent'}],
    stopSubagent: id => {
      stopped.push(id);
      return true;
    },
  });
  fixture.client.createSession();
  const view = await mount({onOpenAgents: () => opened++}, {fixture});
  await key(view, ARROW.down);
  expect(view.lastFrame()).toContain('agent 1/2');
  await key(view, ARROW.right);
  expect(view.lastFrame()).toContain('agent 2/2');
  await key(view, ARROW.left);
  await key(view, 'x');
  expect(stopped).toEqual(['child-1']);
  expect(controller.content).toBe(''); // x did not type
  await key(view, '\r');
  expect(opened).toBe(1);
  await key(view, '\x1b');
  expect(view.lastFrame()).not.toContain('agent 1/2');
  await key(view, 'x');
  expect(controller.content).toBe('x'); // typing is back
});
test('Tab accepts the highlighted suggestion; unbound Tab never types', async () => {
  const view = await mount({initialValue: '/hel'});
  expect(view.lastFrame()).toContain('tab complete');
  await key(view, '\t');
  expect(controller.content.startsWith('/help')).toBe(true);
  const plain = await mount({initialValue: 'text'});
  await key(plain, '\t');
  expect(controller.content).toBe('text');
});
test('completing inside a word replaces the whole token and the hint follows the remapped key', async () => {
  keymapStore.set(
    buildKeymap(
      JSON.stringify({bindings: [{context: 'Autocomplete', bindings: {tab: null, 'alt+j': 'autocomplete:accept'}}]}),
    ),
  );
  const commands: string[] = [];
  const view = await mount({
    initialValue: '/helx',
    onCommand: command => {
      commands.push(command);
    },
  });
  await key(view, ARROW.left);
  expect(view.lastFrame()).toContain('alt+j complete');
  await key(view, '\u001bj');
  expect(controller.content).toBe('/help');
  expect(commands).toEqual([]);
});
test('Ctrl+R: Tab and Enter put the match in the input, Esc cancels and restores the draft', async () => {
  const view = await mount({initialHistory: ['alpha', 'beta'], initialValue: 'wip'});
  await key(view, '\x12');
  await key(view, '\x7f\x7f\x7f'); // clear the prefilled query
  await key(view, 'alp');
  await key(view, '\t');
  expect(controller.search).toBeNull();
  expect(controller.content).toBe('alpha');
  await key(view, '\x12');
  await key(view, '\x7f\x7f\x7f\x7f\x7f');
  await key(view, '\x1b');
  expect(controller.search).toBeNull();
  expect(controller.content).toBe('alpha');
});
test(':shortcode: becomes an emoji only when it is a known whole word', async () => {
  const view = await mount();
  await key(view, 'ship it :rocket');
  await key(view, ':');
  expect(controller.content).toBe('ship it 🚀');
  await key(view, ' http://x:8080');
  await key(view, ':');
  expect(controller.content).toBe('ship it 🚀 http://x:8080:');
  await key(view, ' :nosuchemoji');
  await key(view, ':');
  expect(controller.content.endsWith(':nosuchemoji:')).toBe(true);
});
test('user keybindings rebind and unbind composer actions, and the ? table follows', async () => {
  keymapStore.set(
    buildKeymap(JSON.stringify({bindings: [{context: 'Chat', bindings: {'ctrl+e': 'chat:stash', 'ctrl+s': null}}]})),
  );
  const view = await mount({initialValue: 'stashed by remap', width: 100});
  await key(view, '\x13'); // old key: unbound
  expect(controller.content).toBe('stashed by remap');
  await key(view, '\x05'); // new key
  expect(controller.content).toBe('');
  await key(view, '\x05');
  expect(controller.content).toBe('stashed by remap');
  await keys(view, '\x15', '\x15');
  await key(view, '?');
  await settle();
  expect(view.lastFrame()).toContain('ctrl+e to stash prompt');
  expect(view.lastFrame()).not.toContain('ctrl+s to stash prompt');
});

test('Up retracts authoritative queued input before typed text only after reaching the first row', async () => {
  let waiting = [
    {steerId: 'one', content: 'queued one'},
    {steerId: 'two', content: 'queued two'},
  ];
  let retractions = 0;
  const fixture = dialogFixture({
    startSession: () => ({id: 'queue', selection, messages: []}),
    queuedInput: () => waiting,
    retractQueuedEntries: (_id, options) => {
      const taken = waiting.filter(
        p =>
          !p.content.startsWith('!') ||
          (options.includeShell !== false && (!options.shellOnlyWhenAlone || waiting.length === 1)),
      );
      if (taken.length) retractions++;
      waiting = waiting.filter(p => !taken.includes(p));
      return taken.map(p => ({
        id: p.steerId,
        type: p.content.startsWith('!') ? ('shell' as const) : ('text' as const),
        content: p.content,
      }));
    },
  });
  fixture.client.createSession();
  const view = await mount({initialValue: 'new\ndraft'}, {fixture});
  await key(view, ARROW.up);
  expect(retractions).toBe(0);
  expect(controller.content).toBe('new\ndraft');
  await key(view, ARROW.up);
  expect(retractions).toBe(1);
  expect(controller.content).toBe('queued one\nqueued two\nnew\ndraft');
  expect(controller.queued).toEqual([]);
  // A render snapshot is never reinserted after the backend has claimed it for delivery.
  waiting = [{steerId: 'claimed', content: 'already claimed'}];
  view.rerender(<Harness onSubmit={() => {}} initialValue="ignored" />);
  await settle();
  waiting = [];
  await key(view, '\x01');
  await key(view, ARROW.up);
  expect(controller.content).not.toContain('already claimed');
});

test('queued shell retraction requires an empty draft and an otherwise empty queue', async () => {
  let waiting = [{steerId: 'shell', content: '!echo safe'}];
  let retractions = 0;
  const fixture = dialogFixture({
    startSession: () => ({id: 'shell-queue', selection, messages: []}),
    queuedInput: () => waiting,
    retractQueuedEntries: (_id, options) => {
      const taken = waiting.filter(
        p =>
          !p.content.startsWith('!') ||
          (options.includeShell !== false && (!options.shellOnlyWhenAlone || waiting.length === 1)),
      );
      if (taken.length) retractions++;
      waiting = waiting.filter(p => !taken.includes(p));
      return taken.map(p => ({
        id: p.steerId,
        type: p.content.startsWith('!') ? ('shell' as const) : ('text' as const),
        content: p.content,
      }));
    },
  });
  fixture.client.createSession();
  const view = await mount({initialValue: 'typed'}, {fixture});
  await key(view, ARROW.up);
  expect(controller.content).toBe('typed');
  expect(retractions).toBe(0);
  controller.setDraft(createPasteState());
  await settle();
  waiting.push({steerId: 'text', content: 'ordinary message'});
  await key(view, ARROW.up);
  expect(retractions).toBe(1);
  expect(waiting.map(p => p.content)).toEqual(['!echo safe']);
  expect(controller.content).toBe('ordinary message');
  controller.setDraft(createPasteState());
  await settle();
  await key(view, ARROW.up);
  expect(retractions).toBe(2);
  expect(controller.content).toBe('!echo safe');
});

test('Ctrl+B and its chord call the real SDK background API for the current session; revoked tools prevent the port call', async () => {
  const calls: string[] = [];
  const fixture = dialogFixture({
    startSession: () => ({id: 'task-owner', selection, messages: []}),
    backgroundCurrentTask: owner => {
      calls.push(owner);
      return {id: 'shell', kind: 'shell', status: 'running', description: 'Build', outputTail: '', startedAt: ''};
    },
  });
  fixture.client.createSession();
  const view = await mount({}, {fixture});
  await key(view, '\x02');
  await keys(view, '\x18', '\x02');
  expect(calls).toEqual(['task-owner', 'task-owner']);
  fixture.client.setToolsEnabled(false);
  await key(view, '\x02');
  expect(calls).toHaveLength(2);
});

test('image clipboard uses SDK metadata chips, supports image-only submission and removes selected images', async () => {
  const prepared: unknown[] = [];
  const fixture = dialogFixture({
    prepareImage: async input => {
      prepared.push(input);
      return {mime: 'image/png', data: 'AAAA', name: 'clipboard.png'};
    },
  });
  const sent: string[] = [];
  const view = await mount(
    {
      onReadClipboardImage: async () => ({mediaType: 'image/png', data: 'AAAA'}),
      onSubmit: text => {
        sent.push(text);
      },
    },
    {fixture},
  );
  await key(view, '\x16');
  expect(prepared).toEqual([{mediaType: 'image/png', data: 'AAAA'}]);
  expect(view.lastFrame()).toContain('[Image #1]');
  expect(view.lastFrame()).not.toContain('AAAA');
  await key(view, '\r');
  expect(sent).toEqual(['']);
  await key(view, ARROW.left);
  expect(controller.selectedImage).toBe(0);
  await key(view, '\x7f');
  expect(fixture.client.imageAttachments()).toEqual([]);
  expect(controller.content).toBe('');
});

test('denied image paste and incomplete preparation preserve the draft and never submit early', async () => {
  let release!: () => void;
  let fail = false;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const fixture = dialogFixture({
    prepareImage: async () => {
      if (fail) throw new Error('denied');
      await pending;
      return {mime: 'image/png', data: 'AAAA', name: 'clipboard.png'};
    },
  });
  const sent: string[] = [];
  const view = await mount(
    {
      initialValue: 'keep me',
      onReadClipboardImage: async () => ({mediaType: 'image/png', data: 'AAAA'}),
      onSubmit: text => {
        sent.push(text);
      },
    },
    {fixture},
  );
  await key(view, '\x16');
  await key(view, '\r');
  expect(sent).toEqual([]);
  expect(controller.content).toBe('keep me');
  release();
  await settle();
  expect(fixture.client.imageAttachments()).toHaveLength(1);
  fixture.client.removeImageAttachment(fixture.client.imageAttachments()[0]!.id);
  fail = true;
  await key(view, '\x16');
  expect(controller.notice).toContain('Image paste failed');
  expect(controller.content).toBe('keep me');
  expect(fixture.client.imageAttachments()).toEqual([]);
});

test('Left/Right navigate multiple image chips; deleting one preserves the other attachment', async () => {
  const fixture = dialogFixture({prepareImage: async () => ({mime: 'image/png', data: 'AAAA', name: 'clipboard.png'})});
  const view = await mount({onReadClipboardImage: async () => ({mediaType: 'image/png', data: 'AAAA'})}, {fixture});
  await key(view, '\x16');
  await key(view, '\x16');
  const ids = fixture.client.imageAttachments().map(image => image.id);
  expect(ids).toHaveLength(2);
  await key(view, ARROW.left);
  expect(controller.selectedImage).toBe(1);
  await key(view, ARROW.left);
  expect(controller.selectedImage).toBe(0);
  await key(view, ARROW.right);
  expect(controller.selectedImage).toBe(1);
  await key(view, '\x7f');
  expect(fixture.client.imageAttachments().map(image => image.id)).toEqual([ids[0]!]);
  expect(view.lastFrame()).toContain('[Image #1]');
  expect(view.lastFrame()).not.toContain('[Image #2]');
});

test('shell footer uses session-scoped SDK stop and opens the task panel', async () => {
  const stopped: string[] = [];
  let opened = 0;
  const fixture = dialogFixture({
    startSession: () => ({id: 'tasks', selection, messages: []}),
    backgroundTasks: () => [
      {
        id: 'shell-1',
        kind: 'shell',
        status: 'running',
        description: 'build',
        outputTail: '',
        startedAt: new Date().toISOString(),
      },
    ],
    stopBackgroundTask: async (id, sessionId) => {
      stopped.push(`${sessionId}:${id}`);
      return true;
    },
  });
  fixture.client.createSession();
  const view = await mount(
    {
      onOpenBackgroundTasks: () => {
        opened++;
      },
    },
    {fixture},
  );
  expect(controller.backgroundShells).toBe(1);
  await key(view, ARROW.down);
  expect(controller.notice).toContain('shell 1/1');
  await key(view, 'x');
  expect(stopped).toEqual(['tasks:shell-1']);
  await key(view, '\r');
  expect(opened).toBe(1);
});

test('send-now does not interrupt when SDK refuses to accept the new draft', async () => {
  let interrupts = 0;
  const view = await mount({
    busy: true,
    initialValue: 'keep this',
    onSendQueuedNow: () => {
      interrupts++;
    },
  });
  await keys(view, '\x18', '\x13');
  expect(interrupts).toBe(0);
  expect(controller.content).toBe('keep this');
  expect(controller.notice).toContain('not accepted');
});

test('clipboard completion cannot attach an image to a different session', async () => {
  let release!: (input: {mediaType: 'image/png'; data: string}) => void;
  let prepares = 0;
  let sequence = 0;
  const input = new Promise<{mediaType: 'image/png'; data: string}>(resolve => {
    release = resolve;
  });
  const fixture = dialogFixture({
    startSession: () => ({id: `session-${++sequence}`, selection, messages: []}),
    prepareImage: async () => {
      prepares++;
      return {mime: 'image/png', data: 'AAAA', name: 'clipboard.png'};
    },
  });
  fixture.client.createSession();
  const view = await mount({initialValue: 'keep', onReadClipboardImage: () => input}, {fixture});
  await key(view, '\x16');
  fixture.client.createSession();
  release({mediaType: 'image/png', data: 'AAAA'});
  await settle();
  expect(prepares).toBe(0);
  expect(fixture.client.imageAttachments()).toEqual([]);
  expect(controller.content).toBe('keep');
  expect(controller.notice).toContain('session changed');
});

test('Vim mode routes remapped edits, undo/redo, history and submission through the composer', async () => {
  const fixture = dialogFixture();
  // The backend preference changes while the same composer stays mounted.
  const submitted: string[] = [];
  const view = await mount(
    {
      width: 100,
      onSubmit: content => {
        submitted.push(content);
      },
    },
    {fixture},
  );
  fixture.client.setEditorMode('vim');
  await waitForFrame(view, frame => frame.includes('-- INSERT --'));
  keymapStore.set(buildKeymap(JSON.stringify({bindings: [{context: 'Vim', bindings: {q: 'vim:x', x: null}}]})));
  await keys(view, '👩🏽‍💻bc', '\x1b', '0', 'q');
  expect(controller.content).toBe('bc');
  await key(view, 'u');
  expect(controller.content).toBe('👩🏽‍💻bc');
  await key(view, '\x12');
  expect(controller.content).toBe('bc');
  await key(view, '/');
  expect(controller.search).toBeTruthy();
  await keys(view, '\x1b', '?');
  await waitForFrame(view, frame => frame.includes('q X delete character'));
  await keys(view, '\x1b', '\r');
  expect(submitted).toEqual(['bc']);
});

test('Vim preserves Insert text, bracketed pastes, image paste and editor shortcuts', async () => {
  const fixture = dialogFixture();
  fixture.client.setEditorMode('vim');
  let editorOpens = 0;
  let imagePastes = 0;
  const view = await mount(
    {
      onPasteImage: () => {
        imagePastes++;
      },
      onEditor: () => {
        editorOpens++;
      },
    },
    {fixture},
  );
  keymapStore.set(buildKeymap(JSON.stringify({bindings: [{context: 'Vim', bindings: {'q q': 'vim:x'}}]})));
  await keys(view, 'q', 'q', '界👩🏽‍💻é');
  expect(controller.content).toBe('qq界👩🏽‍💻é');
  const pasted = '文 👩🏽‍💻 é\n'.repeat(130);
  await key(view, `\x1b[200~${pasted}\x1b[201~`);
  expect(controller.draft.pastes).toHaveLength(1);
  expect(controller.content).toBe('qq界👩🏽‍💻é' + pasted);
  await keys(view, '\x1b', 'v');
  await waitForFrame(view, frame => frame.includes('-- VISUAL --'));
  await key(view, 'd');
  expect(controller.content).toBe('qq界👩🏽‍💻é');
  await key(view, 'u');
  expect(controller.content).toBe('qq界👩🏽‍💻é' + pasted);
  expect(controller.draft.pastes).toHaveLength(1);
  await key(view, '\x07');
  expect(editorOpens).toBe(1);
  await key(view, '\x16');
  expect(imagePastes).toBe(1);
});
