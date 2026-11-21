/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {Text} from 'ink';
import {cleanup} from 'ink-testing-library';
import {useEffect, useState} from 'react';
import {InkApp} from '../app';
import {useOverlay} from '../core/overlay';
import {useClientEvents, useStatus} from '../hooks';
import {Panel, KeyHint, Spinner, TextLine, Truncate, Markdown, CodeBlock, Diff, ListPicker} from '../ui';
import {createClientFixture, renderInk, settle} from './index';
import {runInkTui} from '../runtime';
import {PassThrough} from 'node:stream';

afterEach(cleanup);

test('shared primitives render readable plain text', async () => {
  const view = renderInk(
    <Panel title="Preview" width={40}>
      <KeyHint keys="Esc" label="close" />
      <Spinner verb="Reading" elapsedMs={2300} tokens={42} animate={false} />
      <TextLine width={8}>你好世界hello</TextLine>
      <Truncate text={'a\nb\nc'} maxLines={2} />
    </Panel>,
  );
  await settle();
  expect(view.lastFrame()).toMatchSnapshot();
});

test('Markdown renders structural blocks and code without terminal injection', async () => {
  const view = renderInk(
    <Markdown
      width={64}
      text={
        '# Title\n\n**bold** *italic* `inline` [docs](https://example.com)\n\n- first\n- second\n\n> quote\n\n| A | B |\n| - | - |\n| x | y |\n\n```typescript\nconst x = 1;\n```\n\u001b]52;c;evil\u0007'
      }
    />,
  );
  await settle();
  expect(view.lastFrame()).toMatchSnapshot();
  expect(view.lastFrame()).not.toContain('\u001b');
});

test('CodeBlock falls back for unknown languages', async () => {
  const view = renderInk(<CodeBlock code={'a\nb'} language="unknown-lang" lineNumbers />);
  await settle();
  expect(view.lastFrame()).toMatchSnapshot();
});

test('Diff numbers hunk lines, handles header-like source and folds', async () => {
  const diff = '--- a/file\n+++ b/file\n@@ -10,2 +20,2 @@\n--- old text\n+++ new text\n context';
  const view = renderInk(<Diff diff={diff} maxLines={4} />);
  await settle();
  expect(view.lastFrame()).toMatchSnapshot();
  view.rerender(<Diff diff={diff} expanded />);
  await settle();
  expect(view.lastFrame()).toMatchSnapshot();
});

test('ListPicker filters, navigates, selects and cancels', async () => {
  const selected: string[] = [];
  let cancelled = 0;
  const items = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(label => ({id: label, label}));
  const view = renderInk(
    <ListPicker items={items} visibleRows={2} onSelect={item => selected.push(item.id)} onCancel={() => cancelled++} />,
  );
  await settle();
  expect(view.lastFrame()).toMatchSnapshot();
  view.stdin.write('\u001b[B');
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(selected).toEqual(['Beta']);
  view.stdin.write('ga');
  await settle();
  expect(view.lastFrame()).toContain('Gamma');
  expect(view.lastFrame()).not.toContain('Alpha');
  view.stdin.write('\r');
  await settle();
  expect(selected).toEqual(['Beta', 'Gamma']);
  view.stdin.write('zzz');
  await settle();
  expect(view.lastFrame()).toContain('No matches');
  view.stdin.write('\r');
  await settle();
  expect(selected).toHaveLength(2);
  view.stdin.write('\u001b');
  await settle();
  expect(cancelled).toBe(1);
});

test('ListPicker scrolls and clamps when items change', async () => {
  const items = Array.from({length: 6}, (_, n) => ({id: String(n), label: `Item ${n}`}));
  const choose: string[] = [];
  const view = renderInk(<ListPicker items={items} visibleRows={2} onSelect={i => choose.push(i.id)} />);
  await settle();
  for (let i = 0; i < 5; i++) {
    view.stdin.write('\u001b[B');
    await settle();
  }
  expect(view.lastFrame()).toContain('Item 5');
  expect(view.lastFrame()).not.toContain('Item 0');
  view.rerender(<ListPicker items={items.slice(0, 1)} onSelect={i => choose.push(i.id)} />);
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(choose).toEqual(['0']);
});

function OverlayProbe() {
  const {open, active} = useOverlay();
  useEffect(() => {
    open('models', <Text>Models</Text>);
    open('help', <Text>Help</Text>);
  }, [open]);
  return <Text>active:{active?.id ?? 'none'}</Text>;
}

test('overlay router replaces the previous overlay and Escape closes only once', async () => {
  const fixture = createClientFixture();
  const view = renderInk(<InkApp client={fixture.client} slots={{status: <OverlayProbe />}} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('Help');
  expect(view.lastFrame()).not.toContain('Models');
  view.stdin.write('\u001b');
  await settle();
  expect(view.lastFrame()).toContain('active:none');
  expect(view.lastFrame()).not.toContain('Help');
});

test('SDK hooks observe updates, retain fresh callbacks and unsubscribe', async () => {
  const fixture = createClientFixture();
  const calls: string[] = [];
  function Probe({label}: {label: string}) {
    const status = useStatus();
    useClientEvents({reactive: () => calls.push(label)});
    return <Text>{status.permissionMode}</Text>;
  }
  const view = renderInk(<Probe label="first" />, {fixture});
  await settle();
  fixture.client.setPermissionMode('plan');
  await settle();
  expect(view.lastFrame()).toContain('plan');
  view.rerender(<Probe label="second" />);
  await settle();
  fixture.client.setPermissionMode('acceptEdits');
  await settle();
  expect(calls.at(-1)).toBe('second');
  view.unmount();
  await settle();
  const count = calls.length;
  fixture.client.setPermissionMode('plan');
  await settle();
  expect(calls).toHaveLength(count);
});

test('non-TTY writes one Ink frame then exits', async () => {
  const fixture = createClientFixture();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let output = '';
  stdout.on('data', chunk => {
    output += chunk.toString();
  });
  await runInkTui({client: fixture.client, stdout, stdin, env: {NO_COLOR: '1'}});
  expect(output).toContain('Cosmew');
  expect(output).not.toContain('\u001b');
  expect(output.trim().split('Cosmew')).toHaveLength(2);
  expect(fixture.client.status().toolsEnabled).toBe(false);
  expect(stdin.listenerCount('data')).toBe(0);
});

test('folded components toggle only when focused', async () => {
  const view = renderInk(<Truncate text={'first\nsecond'} maxLines={1} isActive />);
  await settle();
  expect(view.lastFrame()).not.toContain('second');
  view.stdin.write('\u000f');
  await settle();
  expect(view.lastFrame()).toContain('second');
  view.rerender(<Truncate text={'first\nsecond'} maxLines={1} isActive={false} />);
  await settle();
  view.stdin.write('\u000f');
  await settle();
  expect(view.lastFrame()).toContain('second');
});

test('uncontrolled disclosure toggles and notifies its owner', async () => {
  let toggles = 0;
  const view = renderInk(<Diff diff={'one\ntwo'} maxLines={1} isActive onToggle={() => toggles++} />);
  await settle();
  view.stdin.write('\u000f');
  await settle();
  expect(view.lastFrame()).toContain('two');
  expect(toggles).toBe(1);
});

test('narrow Markdown tables remain readable as labeled rows', async () => {
  const view = renderInk(
    <Markdown width={12} text={'| Name | Version | License |\n| - | - | - |\n| ink | 8 | MIT |'} />,
  );
  await settle();
  expect(view.lastFrame()).toContain('Name: ink');
  expect(view.lastFrame()).toContain('License: MIT');
});

test('very long diffs stay bounded and render without argument overflow', async () => {
  const view = renderInk(<Diff diff={'\n'.repeat(270000)} maxLines={2} />);
  await settle();
  expect(view.lastFrame()).toContain('diff truncated');
  expect(view.lastFrame()).toContain('Ctrl+O');
});

test('overlay input never reaches the background composer', async () => {
  const {useTextInput} = await import('../hooks');
  function Composer() {
    const [text, setText] = useState('');
    useTextInput(input => setText(value => value + input));
    return <Text>draft:{text}</Text>;
  }
  function OpenPicker() {
    const {open} = useOverlay();
    useEffect(() => {
      open('picker', <ListPicker items={[{id: 'x', label: 'X'}]} onSelect={() => {}} />);
    }, [open]);
    return null;
  }
  const fixture = createClientFixture();
  const view = renderInk(<InkApp client={fixture.client} slots={{composer: <Composer />, status: <OpenPicker />}} />, {
    fixture,
  });
  await settle();
  view.stdin.write('x');
  await settle();
  expect(view.lastFrame()).toContain('⌕ x');
  expect(view.lastFrame()).not.toContain('draft:x');
  view.stdin.write('\u001b');
  await settle();
  view.stdin.write('y');
  await settle();
  expect(view.lastFrame()).toContain('draft:y');
});

test('theme updates propagate and no-color disables syntax color', async () => {
  const {ThemeEngine} = await import('../../theme/theme');
  const {useTheme} = await import('../theme');
  const engine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
  function Probe() {
    const theme = useTheme();
    return (
      <Text>
        {theme.mode}:{theme.color('accent') ?? 'none'}
      </Text>
    );
  }
  const view = renderInk(<Probe />, {themeEngine: engine});
  await settle();
  expect(view.lastFrame()).toBe('dark:none');
  engine.previewTheme('light');
  await settle();
  expect(view.lastFrame()).toBe('light:none');
  view.rerender(<CodeBlock code={'const x = "hello";'} language="typescript" />);
  await settle();
  expect(view.lastFrame()).not.toContain('\u001b');
});

test('hooks deliver interaction and subagent events, then remove both observers', async () => {
  const {FutrynClient} = await import('@cosmew/sdk');
  let emitNotice: ((notice: import('@cosmew/contracts').SubagentNotice) => void) | undefined;
  const fixture = createClientFixture({
    observeSubagentNotices: listener => {
      emitNotice = listener;
      return () => {};
    },
  });
  expect(fixture.client).toBeInstanceOf(FutrynClient);
  const events: string[] = [];
  function Probe() {
    useClientEvents({interaction: event => events.push(event.type), subagent: event => events.push(event.description)});
    return null;
  }
  const view = renderInk(<Probe />, {fixture});
  await settle();
  fixture.client.setUserInputAvailable(true);
  const question = () =>
    fixture.client.askUser([
      {
        id: 'q',
        header: 'Choice',
        question: 'Pick?',
        options: [
          {label: 'A', description: 'a'},
          {label: 'B', description: 'b'},
        ],
        multiple: false,
      },
    ]);
  const first = question();
  await settle();
  expect(events).toContain('question.asked');
  for (const pending of fixture.client.listPendingQuestions()) fixture.client.dismissQuestion(pending.questionId);
  await first;
  emitNotice?.({
    agentId: 'child',
    parentSessionId: 'parent',
    agentType: 'explore',
    description: 'finished',
    status: 'completed',
    delivery: 'queued',
  });
  await settle();
  expect(events).toContain('finished');
  view.unmount();
  await settle();
  const count = events.length;
  const second = question();
  for (const pending of fixture.client.listPendingQuestions()) fixture.client.dismissQuestion(pending.questionId);
  await second;
  emitNotice?.({
    agentId: 'child',
    parentSessionId: 'parent',
    agentType: 'explore',
    description: 'after unmount',
    status: 'completed',
    delivery: 'queued',
  });
  await settle();
  expect(events).toHaveLength(count);
});

test('public runtime entry is Ink without any opt-in and writes one frame without a TTY', async () => {
  const runtime = new URL('../../runtime.tsx', import.meta.url).pathname;
  const fixture = new URL('./client-fixture.ts', import.meta.url).pathname;
  const code = `import {runInteractiveTui} from ${JSON.stringify(runtime)}; import {createClientFixture} from ${JSON.stringify(fixture)}; await runInteractiveTui({client: createClientFixture().client, env: {NO_COLOR: '1', FUTRYN_THEME_MODE: 'dark'}, cols: 80, rows: 24});`;
  const child = Bun.spawn([process.execPath, '--eval', code], {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  expect(exit).toBe(0);
  expect(stdout).toContain('Ink preview');
  expect(stdout).not.toContain('\u001b');
  expect(stdout.trim().split('Cosmew')).toHaveLength(2);
});

test('keymap ignores releases and modified navigation', async () => {
  const {fromInk, defaultKeymap, lookup} = await import('../hooks');
  const key: import('ink').Key = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  };
  const keymap = defaultKeymap();
  const action = (context: 'Global' | 'Chat', input: string, k: import('ink').Key) => {
    const stroke = fromInk(input, k);
    return stroke ? lookup(keymap, context, [stroke]) : undefined;
  };
  expect(action('Global', 'o', {...key, ctrl: true})).toBe('app:toggleTranscript');
  expect(action('Chat', '', {...key, tab: true, shift: true})).toBe('chat:cycleMode');
  expect(action('Chat', '', {...key, return: true, shift: true})).toBe('chat:newline');
  expect(fromInk('', {...key, escape: true, eventType: 'release'})).toBeUndefined();
  expect(action('Chat', '', {...key, upArrow: true, meta: true})).toBeUndefined();
});

test('syntax highlighting uses theme colors and preserves code text', async () => {
  const {ThemeEngine} = await import('../../theme/theme');
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const view = renderInk(<CodeBlock code={'const value = "text";\n// comment'} language="typescript" />, {
    themeEngine: engine,
  });
  await settle();
  const frame = view.lastFrame() ?? '';
  expect(frame).toContain('\u001b[38;2;');
  expect(frame.replace(/\u001b\[[\d;]*m/g, '')).toContain('const value = "text";\n// comment');
});

test('picker sanitizes initial filter and placeholder terminal commands', async () => {
  const view = renderInk(
    <ListPicker items={[{id: 'a', label: 'Alpha'}]} initialQuery={'\u001b]52;c;evil\u0007Alpha'} onSelect={() => {}} />,
  );
  await settle();
  expect(view.lastFrame()).toMatch(/❯ +Alpha/);
  expect(view.lastFrame()).not.toContain('\u001b');
  view.rerender(
    <ListPicker key="placeholder" items={[]} placeholder={'\u001b]52;c;evil\u0007Filter'} onSelect={() => {}} />,
  );
  await settle();
  expect(view.lastFrame()).not.toContain('\u001b');
});
