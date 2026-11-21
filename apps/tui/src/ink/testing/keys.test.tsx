/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup, render} from 'ink-testing-library';
import {Text} from 'ink';
import {useState} from 'react';
import type {ModelEvent, WorkspaceDiffReport} from '@cosmew/contracts';
import {InkApp} from '../app';
import {keymapStore} from '../hooks';
import {buildKeymap, defaultKeymap, IMPLEMENTED_ACTIONS, keyLabels} from '../hooks/keymap';
import {ListPicker} from '../ui';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {EffortDialog} from '../features/models';
import {RewindDialog} from '../features/panels';
import {PermissionsDialog} from '../features/permissions';
import {Diff} from '../features/diff';
import {renderInk, settle} from './index';

afterEach(() => {
  cleanup();
  keymapStore.reset();
});
const untilReady = async (view: {lastFrame(): string | undefined}) => {
  for (let wait = 0; wait < 100 && !view.lastFrame()?.includes('manual mode on'); wait++) await settle();
  await settle();
};
const key = async (view: {stdin: {write(s: string): void}}, text: string) => {
  view.stdin.write(text);
  await settle();
};
async function readyApp(overrides: Parameters<typeof dialogFixture>[0] = {}, width = 100) {
  const f = dialogFixture({validateAccount: async () => ({models: 1, validation: 'fixture'}), ...overrides});
  const view = render(<InkApp client={f.client} width={width} />);
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  await untilReady(view);
  return {f, view};
}
const down = '\x1b[B';
const up = '\x1b[A';

test('Transcript defaults equal the Claude 2.1.330 evidence table and controller keys', () => {
  // B1 keymap plus B4 controller keys, centralized for user remapping.
  expect(Object.fromEntries(defaultKeymap().bindings.get('Transcript')!)).toEqual({
    'ctrl+e': 'transcript:toggleShowAll',
    'ctrl+c': 'transcript:exit',
    escape: 'transcript:exit',
    q: 'transcript:exit',
    'ctrl+u': 'scroll:halfPageUp',
    'ctrl+d': 'scroll:halfPageDown',
    'ctrl+b': 'scroll:fullPageUp',
    'ctrl+f': 'scroll:fullPageDown',
    'ctrl+n': 'scroll:lineDown',
    'ctrl+p': 'scroll:lineUp',
    g: 'scroll:top',
    'shift+g': 'scroll:bottom',
    j: 'scroll:lineDown',
    k: 'scroll:lineUp',
    space: 'scroll:fullPageDown',
    b: 'scroll:fullPageUp',
    up: 'scroll:lineUp',
    down: 'scroll:lineDown',
    home: 'scroll:top',
    end: 'scroll:bottom',
    '/': 'transcript:search',
    n: 'transcript:nextMatch',
    'shift+n': 'transcript:previousMatch',
    '{': 'transcript:previousPrompt',
    '}': 'transcript:nextPrompt',
    '[': 'transcript:dumpScrollback',
    v: 'transcript:openEditor',
    '?': 'transcript:help',
  });
});
test('keybindings.json can remap transcript:toggleShowAll to ctrl+k', () => {
  const keymap = buildKeymap(
    JSON.stringify({
      bindings: [{context: 'Transcript', bindings: {'ctrl+e': null, 'ctrl+k': 'transcript:toggleShowAll'}}],
    }),
  );
  expect(keymap.warnings).toEqual([]);
  expect(keymap.bindings.get('Transcript')?.get('ctrl+k')).toBe('transcript:toggleShowAll');
  expect(keyLabels(keymap, 'Transcript', 'transcript:toggleShowAll')).toEqual(['ctrl+k']);
});
test('Transcript overlays cannot rebind reserved keys, including built-in Ctrl+C/D', () => {
  const reserved = ['ctrl+c', 'ctrl+d', 'ctrl+m', 'ctrl+[', 'ctrl+i', 'ctrl+h'];
  const keymap = buildKeymap(
    JSON.stringify({
      bindings: [
        {context: 'Transcript', bindings: Object.fromEntries(reserved.map(key => [key, 'transcript:search']))},
      ],
    }),
  );
  expect(keymap.warnings).toHaveLength(reserved.length);
  for (const key of reserved)
    expect(keymap.warnings).toContain(`Transcript: "${key}" is reserved and cannot be rebound.`);
  expect(keymap.bindings.get('Transcript')?.get('ctrl+c')).toBe('transcript:exit');
  expect(keymap.bindings.get('Transcript')?.get('ctrl+d')).toBe('scroll:halfPageDown');
  expect(keymap.bindings.get('Global')?.get('ctrl+c')).toBe('app:interrupt');
  expect(keymap.bindings.get('Global')?.get('ctrl+d')).toBe('app:exit');
  expect(keymap.bindings.get('Chat')?.get('ctrl+b')).toBe('task:background');
});
test('Transcript show-all keyLabels uses the default ctrl+e legend label', () => {
  expect(keyLabels(defaultKeymap(), 'Transcript', 'transcript:toggleShowAll')).toEqual(['ctrl+e']);
});
test('transcript parity actions are known to the help source', () => {
  for (const action of [
    'transcript:toggleShowAll',
    'transcript:search',
    'transcript:nextMatch',
    'transcript:previousMatch',
    'scroll:halfPageUp',
    'scroll:halfPageDown',
    'scroll:fullPageUp',
    'scroll:fullPageDown',
    'scroll:lineUp',
    'scroll:lineDown',
    'scroll:top',
    'scroll:bottom',
  ])
    expect(IMPLEMENTED_ACTIONS.has(action)).toBe(true);
});

test('Ctrl+C while a turn runs interrupts it (no exit); Esc does the same', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const {f, view} = await readyApp({
    startSession: () => ({id: 's', selection, messages: []}),
    async *sendTurn(_id, _content, signal): AsyncIterable<ModelEvent> {
      yield {type: 'textDelta', text: 'working'};
      await Promise.race([held, new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve()))]);
      if (signal?.aborted) return;
      yield {type: 'textDelta', text: ' done'};
    },
  });
  try {
    await key(view, 'go');
    await key(view, '\r');
    await settle();
    expect(view.lastFrame()).toContain('esc to interrupt');
    await key(view, '\x03');
    await settle();
    expect(view.lastFrame()).not.toContain('esc to interrupt');
    expect(view.lastFrame()).toContain('Interrupted');
    expect(view.lastFrame()).not.toContain('Press Ctrl-C again');
    expect(f.client.toolsEnabled()).toBe(true);
  } finally {
    release();
    view.unmount();
  }
});
test('Ctrl+D on an empty prompt hints, then exits on the second press', async () => {
  const {f, view} = await readyApp();
  await key(view, '\x04');
  expect(view.lastFrame()).toContain('Press Ctrl-D again to exit');
  expect(f.client.toolsEnabled()).toBe(true);
  await key(view, '\x04');
  expect(f.client.toolsEnabled()).toBe(false);
  view.unmount();
});
test('Ctrl+D with text deletes the character after the cursor and never exits', async () => {
  const {f, view} = await readyApp();
  await key(view, 'abc');
  await key(view, '\x01');
  await key(view, '\x04');
  expect(view.lastFrame()).toContain('❯ bc');
  expect(f.client.toolsEnabled()).toBe(true);
  view.unmount();
});
test('in a dialog Ctrl+C and Ctrl+D need two presses to close it and never exit', async () => {
  const {f, view} = await readyApp();
  await key(view, '/help');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('Help');
  await key(view, '\x03');
  expect(view.lastFrame()).toContain('Press Ctrl-C again to close');
  expect(view.lastFrame()).toContain('Help');
  await key(view, '\x03');
  expect(view.lastFrame()).not.toContain('Help  General');
  expect(f.client.toolsEnabled()).toBe(true);
  await key(view, '/help');
  await key(view, '\r');
  await key(view, '\x04');
  expect(view.lastFrame()).toContain('Press Ctrl-D again to close');
  await key(view, '\x04');
  expect(view.lastFrame()).not.toContain('Help  General');
  expect(f.client.toolsEnabled()).toBe(true);
  view.unmount();
});
test('a permission dialog closed with Ctrl+C twice is denied, not granted', async () => {
  const fixture = dialogFixture({validateAccount: async () => ({models: 1, validation: 'fixture'})});
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'process.execute',
    action: 'exec_command · NO SANDBOX',
    target: 'npm test',
    reason: 'Escalation',
    decisions: ['once'],
  });
  const view = render(<InkApp client={fixture.client} width={100} />);
  await settle();
  await key(view, '\x1b[A');
  await key(view, '\r');
  for (let wait = 0; wait < 100 && !view.lastFrame()?.includes('NO SANDBOX'); wait++) await settle();
  await key(view, '\x03');
  expect(fixture.client.listPermissions().find(r => r.approvalId === request.approvalId)?.status).toBe('pending');
  await key(view, '\x03');
  expect(fixture.client.listPermissions().find(r => r.approvalId === request.approvalId)?.status).toBe('denied');
  view.unmount();
});
test('a half-typed ctrl+x chord that cannot continue is cancelled with a notice', async () => {
  const {view} = await readyApp();
  await key(view, 'keep');
  await key(view, '\x18');
  await key(view, 'z');
  expect(view.lastFrame()).toContain('Chord cancelled');
  expect(view.lastFrame()).toContain('❯ keep'); // the stray key was swallowed, not typed
  view.unmount();
});
test('Ctrl+L redraws without touching the draft; Ctrl+T toggles tasks', async () => {
  const {view} = await readyApp();
  await key(view, 'draft survives');
  await key(view, '\x0c');
  expect(view.lastFrame()).toContain('draft survives');
  view.unmount();
});
test('transcript viewer: footer lists its keys; q, Esc and Ctrl+C leave; ? lists them; [ reports the scrollback', async () => {
  const {view} = await readyApp({}, 140);
  await key(view, 'keep this');
  await key(view, '\x0f');
  expect(view.lastFrame()).toContain('Showing detailed transcript');
  expect(view.lastFrame()).toContain('v to open in code');
  expect(view.lastFrame()).toContain('? for shortcuts');
  await key(view, '?');
  expect(view.lastFrame()).toContain('exit');
  expect(view.lastFrame()).toContain('open in editor');
  await key(view, '[');
  expect(view.lastFrame()).toContain('already in the terminal scrollback');
  await key(view, 'q');
  expect(view.lastFrame()).not.toContain('Showing detailed transcript');
  expect(view.lastFrame()).toContain('keep this'); // q did not type into the composer
  for (const leave of ['\x1b', '\x03']) {
    await key(view, '\x0f');
    expect(view.lastFrame()).toContain('Showing detailed transcript');
    await key(view, leave);
    expect(view.lastFrame()).not.toContain('Showing detailed transcript');
  }
  view.unmount();
});
test('/keybindings is a real command: it appears in the slash menu and routes to the editor flow', async () => {
  const {routeCommand} = await import('../features/commands');
  const opened: string[] = [];
  const notices: string[] = [];
  const f = dialogFixture();
  await routeCommand(
    {
      client: f.client,
      busy: () => false,
      open: route => void opened.push(route),
      notice: text => void notices.push(text),
      reset: () => {},
      submit: () => false,
      exit: () => {},
    },
    '/keybindings',
  );
  expect(opened).toEqual(['keybindings']);
  expect(notices).toEqual([]);
});

function Picker({filterable, onPick}: {filterable: boolean; onPick: (id: string) => void}) {
  const [query] = useState('');
  return (
    <>
      <Text>{query}</Text>
      <ListPicker
        filterable={filterable}
        visibleRows={4}
        hint={false}
        items={Array.from({length: 12}, (_, i) => ({id: `item-${i}`, label: `Item ${i}`}))}
        onSelect={item => onPick(item.id)}
      />
    </>
  );
}
test('Select keys: arrows, J/K and Ctrl+N/P, PageUp/PageDown, Home/End; J/K type when a text field is active', async () => {
  const picked: string[] = [];
  const view = renderInk(<Picker filterable={false} onPick={id => picked.push(id)} />);
  await settle();
  const choose = async () => {
    await key(view, '\r');
    return picked.at(-1);
  };
  await key(view, down);
  expect(await choose()).toBe('item-1');
  await key(view, 'j');
  expect(await choose()).toBe('item-2');
  await key(view, 'k');
  await key(view, 'k');
  expect(await choose()).toBe('item-0');
  await key(view, '\x0e'); // Ctrl+N
  expect(await choose()).toBe('item-1');
  await key(view, '\x10'); // Ctrl+P
  expect(await choose()).toBe('item-0');
  await key(view, '\x1b[6~'); // PageDown: a page of 4 rows
  expect(await choose()).toBe('item-4');
  await key(view, '\x1b[5~');
  expect(await choose()).toBe('item-0');
  await key(view, '\x1b[F'); // End
  expect(await choose()).toBe('item-11');
  await key(view, '\x1b[H'); // Home
  expect(await choose()).toBe('item-0');
  view.unmount();
  const filtering = renderInk(<Picker filterable onPick={id => picked.push(id)} />);
  await settle();
  await key(filtering, 'j');
  expect(filtering.lastFrame()).toContain('No matches'); // typed into the filter, did not move
  filtering.unmount();
});
test('effort slider: ←/→ move, s applies only to the session and Enter saves', async () => {
  const fixture = dialogFixture({selectModel: () => selection});
  fixture.client.selectModel('sample-model');
  const view = renderInk(<EffortDialog />, {fixture});
  await settle();
  await key(view, '\x1b[C');
  await key(view, '\x1b[C');
  await key(view, '\x1b[D');
  const preferences = JSON.stringify(fixture.settings.reasoningPreferences);
  await key(view, 's');
  expect(fixture.client.status().reasoningEffort).toBe('low');
  expect(JSON.stringify(fixture.settings.reasoningPreferences)).toBe(preferences);
  await key(view, '\r');
  expect(fixture.client.status().reasoningEffort).toBe('low');
  view.unmount();
});
test('rewind list: Home/End jump, Enter reports the missing checkpoints honestly', async () => {
  const fixture = dialogFixture({
    startSession: () => ({
      id: 'r',
      selection,
      messages: [
        {role: 'user', content: 'first'},
        {role: 'assistant', content: 'ok'},
        {role: 'user', content: 'second'},
      ],
    }),
  });
  fixture.client.createSession();
  const view = renderInk(<RewindDialog />, {fixture});
  await settle();
  await key(view, '\x1b[H');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('Nothing to rewind to.');
  await key(view, '\x1b[F');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('Nothing to rewind to');
  view.unmount();
});
test('permission dialog: Enter says yes, Tab opens the comment field and Tab again closes it', async () => {
  const fixture = dialogFixture();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'fs.read',
    action: 'Read',
    target: 'a.txt',
    reason: 'test',
    decisions: ['once', 'session'],
  });
  const view = renderInk(<PermissionsDialog />, {fixture});
  await settle();
  await key(view, '\t');
  expect(view.lastFrame()).toContain('Esc');
  await key(view, '\t');
  await key(view, '\r');
  expect(fixture.client.listPermissions().find(r => r.approvalId === request.approvalId)?.status).toBe('approved_once');
  view.unmount();
});
test('diff dialog keys: J/K pick the file, ←/→ the source, Space and B page, Enter shows the whole file', async () => {
  const lines = Array.from({length: 40}, (_, i) => ({
    type: 'add' as const,
    oldLine: null,
    newLine: i + 1,
    content: `row ${i}`,
  }));
  const report: WorkspaceDiffReport = {
    workspace: '/w',
    gitAvailable: true,
    files: [
      {path: 'a.ts', status: 'modified', additions: 40, deletions: 0, layer: 'unstaged', lines},
      {path: 'b.ts', status: 'added', additions: 1, deletions: 0, layer: 'staged', lines: lines.slice(0, 1)},
    ],
    totalAdditions: 41,
    totalDeletions: 0,
  };
  const view = renderInk(<Diff report={report} isActive maxLines={5} width={60} />);
  await settle();
  expect(view.lastFrame()).toContain('1/2 a.ts');
  await key(view, 'j');
  expect(view.lastFrame()).toContain('2/2 b.ts');
  await key(view, 'k');
  expect(view.lastFrame()).toContain('1/2 a.ts');
  await key(view, ' ');
  expect(view.lastFrame()).toContain('row 5');
  await key(view, 'b');
  expect(view.lastFrame()).toContain('row 0');
  await key(view, 'G'); // Shift+G
  expect(view.lastFrame()).toContain('row 39');
  await key(view, 'g');
  expect(view.lastFrame()).toContain('row 0');
  await key(view, '\x1b[C'); // next source: staged
  expect(view.lastFrame()).toContain('staged');
  view.unmount();
});
void up;
