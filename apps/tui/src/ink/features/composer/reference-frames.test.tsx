/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {dialogFixture, selection} from '../picker/test-fixture';
import {createClientFixture, renderInk, settle} from '../../testing';
import {ComposerView, useComposer, type ComposerController, type ComposerOptions} from './index';

afterEach(cleanup);
const REF = `${import.meta.dir}/../../../../../../docs/delivery/tui-v4/reference/idle-100x30`;
/** Reference rows (1-based as in the capture) of a frame, as text. */
async function reference(name: string, from: number, to: number): Promise<string[]> {
  const rows = new Map(
    (await Bun.file(`${REF}/${name}.txt`).text())
      .split('\n')
      .map(line => /^(\d+)\|(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map(m => [Number(m[1]), m[2]!.replace(/ /g, ' ').trimEnd()] as const),
  );
  return Array.from({length: to - from + 1}, (_, i) => rows.get(from + i) ?? '');
}
let controller: ComposerController;
function Harness(props: ComposerOptions) {
  const state = useComposer({...props, inputWidth: 97});
  controller = state;
  return <ComposerView controller={state} width={100} fullscreen />;
}
const withEffort = () => dialogFixture({startSession: () => ({id: 'ref', selection, messages: []})});
function tail(frame: string, count: number): string[] {
  return frame
    .split('\n')
    .slice(-count)
    .map(line => line.trimEnd());
}
async function mount(props: Partial<ComposerOptions> = {}) {
  const fixture = withEffort();
  fixture.client.createSession();
  fixture.client.setReasoningEffort('low');
  const view = renderInk(<Harness onSubmit={() => {}} {...props} />, {fixture});
  await settle();
  return {view, fixture};
}

test('idle frame matches reference 01-ready rows 24-29 (effort row, rules, placeholder, footer)', async () => {
  const {view} = await mount();
  const want = await reference('01-ready', 24, 29);
  const got = tail(view.lastFrame()!, 6);
  // `low` is shorter than `medium`: only the effort row differs, and it stays right aligned two cells from the edge.
  expect(got[0]).toBe(' '.repeat(100 - 2 - '◐ low · /effort'.length) + '◐ low · /effort');
  expect(got.slice(1, 5)).toEqual([want[1]!, want[2]!, want[3]!, '']);
  expect(got[5]).toBe('  ⏸ manual mode on');
  expect(want[5]).toBe('  ⏸ manual mode on · ← 1 agent');
});

test('footer modes and suffixes: busy adds esc to interrupt, running agents add ← N agent(s)', async () => {
  const {view, fixture} = await mount({busy: true, backgroundShells: 2});
  expect(tail(view.lastFrame()!, 1)).toEqual(['  ⏸ manual mode on · esc to interrupt · 2 shells · ↓ to manage']);
  fixture.client.setPermissionMode('acceptEdits');
  await settle();
  expect(tail(view.lastFrame()!, 1)[0]).toBe(
    '  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · 2 shells · ↓ to manage',
  );
});

test('? table equals reference 02-shortcuts rows 23-29 cell for cell and replaces footer and spacer row', async () => {
  const {view} = await mount();
  view.stdin.write('?');
  await settle();
  const got = tail(view.lastFrame()!, 8);
  // Reference columns including the now-supported image and background-task bridges; the cells keep
  // the reference columns and wrapping. The table is generated from the central keymap.
  expect(got).toEqual([
    '  ! for shell mode        esc esc to clear input             ctrl+shift+_ to undo',
    '  / for commands          shift+tab to cycle modes           ctrl+z to suspend',
    '  @ for file paths        shift+↑/↓ to change effort         opt+p to switch model',
    '                          ctrl+o to see full transcript      ctrl+s to stash prompt',
    '                          ctrl+t to toggle tasks             ctrl+g to edit in $EDITOR',
    '                          backslash (\\) then enter for       ctrl+v to paste image',
    '                          newline                            ctrl+b to background task',
    '                                                             /keybindings to customize',
  ]);
  const full = view.lastFrame()!.split('\n');
  expect(full.at(-9)).toBe('─'.repeat(100));
});

test('slash menu equals reference 03b-slash-filter layout: pointer column, 42-cell name column, wrapped description', async () => {
  const {view} = await mount({initialValue: '/'});
  const lines = view.lastFrame()!.split('\n');
  const first = lines.findIndex(line => line.startsWith('  ❯ /'));
  expect(first).toBeGreaterThanOrEqual(0);
  // Same columns as the reference: pointer at 2, name at 4, description at 44, rule right below the menu.
  const row = lines[first]!;
  expect(row.indexOf('/')).toBe(4);
  const description = row.slice(44).trim();
  expect(description.length).toBeGreaterThan(0);
  expect(row.slice(0, 44).trim().split(/\s+/)).toHaveLength(2);
  const menu = lines.slice(
    first,
    lines.findIndex((line, i) => i > first && line.startsWith('─')),
  );
  expect(menu.length).toBeLessThanOrEqual(5);
  expect(menu.slice(1).every(line => !line.startsWith('  ❯'))).toBe(true);
  const rule = lines.findIndex((line, i) => i > first && line.startsWith('─'));
  expect(lines[rule + 1]).toBe('❯ /');
});

test('@ menu lists files as "+ path" rows under the pointer column, five rows, no description (reference 04-at)', async () => {
  const fixture = createClientFixture({
    listWorkspaceFiles: () => ['a.txt', 'index.ts', '.git/', 'b.md', 'c.md', 'd.md'],
  });
  const view = renderInk(<Harness onSubmit={() => {}} initialValue="@" workspaceAccess />, {fixture});
  await settle();
  const lines = view.lastFrame()!.split('\n');
  const rule = lines.findIndex(line => line.startsWith('─'));
  const menu = lines.slice(0, rule).filter(Boolean);
  // Reference rows are `    + a.txt` (the pointer column stays empty); the selected row gets the pointer.
  expect(menu).toEqual(['  ❯ + a.txt', '    + index.ts', '    + .git/', '    + b.md', '    + c.md']);
  expect((await reference('04-at', 20, 22)).map(line => line.replace(/^ {4}/, '    '))).toEqual(
    menu
      .slice(0, 1)
      .concat(menu.slice(1, 3))
      .map(line => line.replace('❯ ', '  ')),
  );
  expect(menu.join('\n')).not.toContain('Workspace file');
  view.stdin.write('\u001b[B');
  await settle();
  expect(view.lastFrame()).toContain('  ❯ + index.ts');
});

test('multi-line hint, deleted-text hint and ctrl+y restore (reference 07-multiline, 09-ctrl-c-once)', async () => {
  const {view} = await mount({initialValue: 'line one\\'});
  view.stdin.write('\r');
  await settle();
  const before = view.lastFrame()!.split('\n');
  const hintRow = before.find(line => line.includes('ctrl+g to edit in'))!;
  expect(hintRow.trimEnd().length).toBe(100 - 18);
  expect(controller.content).toBe('line one\n');
  expect(controller.confirmExit()).toBe(false);
  await settle();
  expect(controller.content).toBe('');
  const slot = view
    .lastFrame()!
    .split('\n')
    .find(line => line.includes('ctrl+y to paste deleted text'))!;
  expect(slot.trimEnd()).toBe(' '.repeat(100 - 2 - 28) + 'ctrl+y to paste deleted text');
  expect((await reference('09-ctrl-c-once', 24, 24))[0]!.trim()).toBe('ctrl+y to paste deleted text');
  // Clearing does not arm the exit: the next Ctrl+C on the empty input only warns.
  view.stdin.write('\x19');
  await settle();
  expect(controller.content).toBe('line one\n');
  expect(view.lastFrame()).not.toContain('ctrl+y to paste deleted text');
});

test('bash mode: ! prompt, shell footer, no mode text (reference 06-bash-mode)', async () => {
  const {view} = await mount({initialValue: '!'});
  const got = tail(view.lastFrame()!, 6);
  expect(got[2]).toBe('! Try "write a test for <filepath>"');
  expect((await reference('06-bash-mode', 26, 26))[0]).toBe('! Try "write a test for <filepath>"');
  expect(got[5]).toBe('  ! for shell mode');
  expect(view.lastFrame()).not.toContain('manual mode');
});

test('# keeps the dispatch prefix but uses the normal prompt and footer (reference 06b-hash)', async () => {
  const {view} = await mount({initialValue: '#'});
  const got = tail(view.lastFrame()!, 6);
  expect(got[2]).toBe('❯ #');
  expect(got[5]).toBe('  ⏸ manual mode on');
});

test('a running turn shows an empty prompt without the rotating example', async () => {
  const fixture = withEffort();
  fixture.client.createSession();
  const view = renderInk(<Harness onSubmit={() => {}} busy />, {fixture});
  await settle();
  expect(tail(view.lastFrame()!, 5)[1]).toBe('❯');
});

test('rotating placeholder starts with the reference phrase', async () => {
  const {view} = await mount();
  expect(view.lastFrame()).toContain('Try "write a test for <filepath>"');
});

test('messages typed while a turn runs show as "❯ text" + Queued hint; Up retracts them atomically', async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => {
    finish = resolve;
  });
  const waitingInput: {steerId: string; content: string}[] = [];
  const fixture = createClientFixture({
    queuedInput: () => waitingInput,
    retractQueuedEntries: () => waitingInput.splice(0).map(p => ({id: p.steerId, type: 'text', content: p.content})),
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
    async *sendTurn() {
      await waiting;
      yield {type: 'textDelta', text: 'done'};
    },
    steerTurn: (_id, content) => {
      waitingInput.push({steerId: 'st', content});
      return {accepted: true, turnId: 't', steerId: 'st'};
    },
  });
  const iterator = fixture.client.sendMessage('original')[Symbol.asyncIterator]();
  const pending = iterator.next();
  const view = renderInk(<Harness onSubmit={() => {}} busy />, {fixture});
  await settle();
  expect(view.lastFrame()).not.toContain('Queued');
  view.stdin.write('also give it a title');
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(controller.queued).toEqual(['also give it a title']);
  const lines = view.lastFrame()!.split('\n');
  const at = lines.indexOf('❯ also give it a title');
  expect(at).toBeGreaterThanOrEqual(0);
  expect(lines[at + 1]).toBe('  ⎿  Queued · ctrl+x ctrl+s to send now');
  expect(lines[at - 1]).toBe('');
  expect(view.lastFrame()).toContain('❯ Press up to edit queued messages');
  view.stdin.write('\u001b[A');
  await settle();
  expect(controller.content).toBe('also give it a title');
  expect(controller.queued).toEqual([]);
  finish();
  await pending;
  await iterator.return?.();
  view.rerender(<Harness onSubmit={() => {}} />);
  await settle();
  expect(controller.queued).toEqual([]);
});

test('Ctrl+X Ctrl+S sends queued messages through the host bridge, or reports Not implemented', async () => {
  let sendNow = 0;
  const {view} = await mount({onSendQueuedNow: () => sendNow++});
  view.stdin.write('\x18');
  await settle();
  view.stdin.write('\x13');
  await settle();
  expect(sendNow).toBe(1);
  // Ctrl+S alone is still the stash key, never the chord.
  view.stdin.write('draft');
  await settle();
  view.stdin.write('\x13');
  await settle();
  expect(sendNow).toBe(1);
  expect(controller.content).toBe('');
  view.unmount();
  const bare = await mount();
  bare.view.stdin.write('\x18');
  await settle();
  bare.view.stdin.write('\x13');
  await settle();
  expect(controller.notice).toContain('Not implemented: sending queued messages now');
});

test('Esc Esc: empty input calls the rewind bridge, text is cleared and recoverable with Ctrl+Y', async () => {
  let rewinds = 0;
  const {view} = await mount({onRewind: () => rewinds++, initialValue: 'half typed'});
  expect(controller.interrupt()).toBe(true);
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(rewinds).toBe(0);
  expect(controller.content).toBe('');
  expect(view.lastFrame()).toContain('ctrl+y to paste deleted text');
  view.stdin.write('\x19');
  await settle();
  expect(controller.content).toBe('half typed');
  controller.setDraft({...controller.draft, value: '', cursor: 0, pastes: []});
  await settle();
  expect(controller.interrupt()).toBe(true);
  expect(controller.interrupt()).toBe(true);
  expect(rewinds).toBe(1);
  view.unmount();
  await mount();
  expect(controller.interrupt()).toBe(true);
  expect(controller.interrupt()).toBe(true);
  await settle();
  expect(controller.notice).toContain('Not implemented: conversation rewind');
});

test('Ctrl+G, Ctrl+Z and Ctrl+V call their host bridges; none of them types or sends text', async () => {
  const calls: string[] = [];
  const sent: string[] = [];
  const {view} = await mount({
    initialValue: 'keep',
    onSubmit: text => {
      sent.push(text);
    },
    onEditor: () => calls.push('editor'),
    onSuspend: () => calls.push('suspend'),
    onPasteImage: () => calls.push('image'),
  });
  for (const code of ['\x07', '\x1a', '\x16']) {
    view.stdin.write(code);
    await settle();
  }
  expect(calls).toEqual(['editor', 'suspend', 'image']);
  expect(controller.content).toBe('keep');
  expect(sent).toEqual([]);
});
