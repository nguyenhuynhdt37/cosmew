/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import type {ToolCall, ToolResult} from '@cosmew/contracts';
import {renderInk, settle} from '../../testing';
import {Spinner, SPINNER_FRAMES, FUTRYN_VERBS, spinnerTokens} from '../../ui/spinner';
import {toolDisplay, reduceTranscript} from './logic';
import {TranscriptItem} from './index';
afterEach(cleanup);
const result = (name: string, content: string): ToolResult => ({callId: 'x', name, status: 'ok', content});
const call = (name: string, input: unknown): ToolCall => ({id: 'x', name, input});
for (const [name, input, title] of [
  ['read', {path: 'a'}, 'Read(a)'],
  ['glob', {pattern: '*.ts'}, 'Search(pattern: "*.ts", path: ".")'],
  ['grep', {pattern: 'x', path: 'src'}, 'Search(pattern: "x", path: "src")'],
  ['edit', {path: 'a'}, 'Update(a)'],
  ['apply_patch', {patch: '*** Update File: a'}, 'Update(a)'],
  ['write', {path: 'a'}, 'Write(a)'],
  ['exec_command', {cmd: 'pwd'}, 'Bash(pwd)'],
  ['write_stdin', {chars: 'x'}, 'Bash(stdin)'],
  ['web_fetch', {url: 'https://example.com'}, 'Fetch(https://example.com)'],
  ['web_search', {query: 'q'}, 'Web Search("q")'],
  ['agent', {description: 'inspect'}, 'Task(inspect)'],
  ['update_plan', {plan: []}, 'Update Todos'],
  ['lsp', {operation: 'hover'}, 'LSP(hover)'],
  ['skill', {name: 'review'}, 'Skill(review)'],
] as const)
  test(`${name} maps to its display name without changing its tool identity`, () => {
    const value = call(name, input);
    expect(toolDisplay(value).title).toBe(title);
    expect(value.name).toBe(name);
  });
test('read and search summaries count returned evidence, exclude metadata and context', () => {
  expect(toolDisplay(call('read', {path: 'a'}), result('read', ' 7\tfoo\n 8\tbar\n\n[50 lines total]')).lines).toEqual([
    'Read 2 lines (ctrl+o to expand)',
  ]);
  expect(toolDisplay(call('glob', {}), result('glob', 'a\nb\n\n[showing 2 of 50 files]')).lines[0]).toContain(
    'Found 2 files',
  );
  expect(toolDisplay(call('grep', {}), result('grep', 'a:2:match\na-3-context\n--\nb:4:match')).lines[0]).toContain(
    'Found 2 lines',
  );
  expect(toolDisplay(call('grep', {}), result('grep', 'No matches.')).lines[0]).toContain('Found 0 lines');
});
test('only confirmed receipts summarize edits; writes count complete written content', () => {
  const receipt = result(
    'edit',
    JSON.stringify({changes: [{path: 'a', action: 'update', diff: '@@ -1,1 +1,2 @@\n-old\n+new\n+next'}]}),
  );
  expect(toolDisplay(call('edit', {path: 'a'}), receipt).lines).toEqual(['Added 2 lines, removed 1 line']);
  const created = result(
    'write',
    JSON.stringify({changes: [{path: 'a', action: 'add', diff: '@@ -0,0 +1,2 @@\n+new\n+next'}]}),
  );
  expect(toolDisplay(call('write', {path: 'a', content: 'new\nnext\n'}), created).lines).toEqual([
    'Wrote 2 lines to a',
  ]);
  expect(toolDisplay(call('edit', {path: 'a'}), {...receipt, status: 'denied'}).lines.join('\n')).not.toContain(
    'Updated a',
  );
});
test('Bash preview retains first four lines and expansion preserves all output', () => {
  const output = result('exec_command', '1\n2\n3\n4\n5\n6');
  expect(toolDisplay(call('exec_command', {}), output).lines).toEqual([
    '1',
    '2',
    '3',
    '4',
    '… +2 lines (ctrl+o to expand)',
  ]);
  expect(toolDisplay(call('exec_command', {}), output, false, true).lines.join('\n')).toBe(output.content);
});
test('denied, failed exit, continuing session and missing results stay distinct', () => {
  const c = call('exec_command', {}),
    r = result('exec_command', 'failed');
  expect(toolDisplay(c, {...r, status: 'denied'})).toMatchObject({
    status: 'denied',
    lines: ['User rejected Bash', 'failed'],
  });
  expect(toolDisplay(c, {...r, exitCode: 2})).toMatchObject({status: 'error', lines: ['Error: Exit code 2', 'failed']});
  expect(toolDisplay(c, {...r, sessionId: 'session'}).status).toBe('running');
  expect(toolDisplay(c, undefined, false).status).toBe('stopped');
  expect(toolDisplay(c, undefined, true).status).toBe('running');
});
test('spinner uses specified cycle and real usage only, unknown output tokens are omitted', async () => {
  expect(SPINNER_FRAMES.join('')).toBe('·✢✳✶✻✽✻✶✳✢');
  expect(FUTRYN_VERBS.length).toBeGreaterThan(3);
  expect(spinnerTokens(1200)).toBe(' · ↓ 1.2k tokens');
  expect(spinnerTokens(undefined)).toBe('');
  const view = renderInk(<Spinner verb="Crafting" elapsedMs={12000} tokens={1200} animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('(12s · ↓ 1.2k tokens)');
  let state = reduceTranscript({items: []}, {type: 'begin', id: 'a', prompt: 'x', now: 0});
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'many words'}, now: 1});
  expect(state.items.at(-1)?.usage).toBeUndefined();
  view.rerender(<TranscriptItem item={state.items.at(-1)!} animate={false} />);
  await settle();
  expect(view.lastFrame()).not.toContain('tokens');
  state = reduceTranscript(state, {
    type: 'event',
    event: {type: 'usage', usage: {inputTokens: 5000, outputTokens: 1200, costUSD: null}},
    now: 2,
  });
  view.rerender(<TranscriptItem item={state.items.at(-1)!} animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('↓ 1.2k tokens');
});

test('Update Todos renders acknowledged checklist and never renders denied proposals as applied', async () => {
  const c = call('update_plan', {
    plan: [
      {step: 'Read', status: 'completed'},
      {step: 'Code', status: 'in_progress'},
      {step: 'Test', status: 'pending'},
    ],
  });
  const item = {
    id: 't',
    role: 'assistant' as const,
    content: '',
    toolCalls: [c],
    toolResults: [result(c.name, 'Plan updated')],
  };
  const view = renderInk(<TranscriptItem item={item} />);
  await settle();
  expect(view.lastFrame()).toContain('⏺ Update Todos');
  expect(view.lastFrame()).toContain('☒ Read');
  expect(view.lastFrame()).toContain('☐ Code');
  expect(view.lastFrame()).toContain('☐ Test');
  view.rerender(<TranscriptItem item={{...item, toolResults: [{...result(c.name, 'refused'), status: 'denied'}]}} />);
  await settle();
  expect(view.lastFrame()).toContain('User rejected Update Todos');
  expect(view.lastFrame()).not.toContain('☒ Read');
});

test('terminal control bytes in titles and tool output are sanitized before Ink rendering', async () => {
  const c = call('read', {path: 'a\x1b]52;c;payload\x07'});
  const view = renderInk(
    <TranscriptItem
      detailed
      item={{id: 'a', role: 'assistant', content: '', toolCalls: [c], toolResults: [result('read', 'line\x1b[2J')]}}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('Read(a)');
  expect(view.lastFrame()).not.toContain('payload');
  expect(view.lastFrame()).not.toContain('\x1b');
});

test.skipIf(process.env.FORCE_COLOR !== '3')('colour terminal paints outcome dots and user background', async () => {
  const {ThemeEngine} = await import('../../../theme/theme');
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const c = call('read', {path: 'a'});
  const item = {
    id: 'a',
    role: 'assistant' as const,
    content: '',
    toolCalls: [c],
    toolResults: [result('read', '1\tline')],
  };
  const view = renderInk(<TranscriptItem item={item} animate={false} />, {themeEngine: engine});
  await settle();
  const okDot = /\x1b\[38;2;[\d;]+m⏺/.exec(view.lastFrame()!)?.[0];
  expect(okDot).toBeDefined();
  view.rerender(
    <TranscriptItem item={{...item, toolResults: [{...result('read', 'failed'), status: 'error'}]}} animate={false} />,
  );
  await settle();
  const errorDot = /\x1b\[38;2;[\d;]+m⏺/.exec(view.lastFrame()!)?.[0];
  expect(errorDot).toBeDefined();
  expect(errorDot).not.toBe(okDot);
  view.rerender(<TranscriptItem item={{id: 'u', role: 'user', content: 'prompt'}} width={20} />);
  await settle();
  expect(view.lastFrame()).toContain('\x1b[48;2;');
});

for (const name of ['exec_command', 'write_stdin'])
  test(`${name} previews output before metadata, retains envelope on expansion and reports nonzero exit`, async () => {
    const c = call(name, {cmd: 'rg marker source.ts'});
    const content =
      'Exit code: 0\nWall time: 0.00 s\nLeader exit: unconfirmed.\nDescendant termination: unconfirmed.\nOutput capture: complete.\nOutput:\nsource.ts:1:marker\nExit code: literal program output';
    const r = {...result(name, content), exitCode: 0, durationMs: 2};
    expect(toolDisplay(c, r).lines).toEqual(['source.ts:1:marker', 'Exit code: literal program output']);
    expect(toolDisplay(c, r, false, true).lines.join('\n')).toBe(content);
    expect(toolDisplay(c, {...r, exitCode: 7, content: content.replace('Exit code: 0', 'Exit code: 7')}).lines).toEqual(
      ['Error: Exit code 7', 'source.ts:1:marker', 'Exit code: literal program output'],
    );
    const failed = {...r, exitCode: 7, content: content.replace('Exit code: 0', 'Exit code: 7')};
    const view = renderInk(
      <TranscriptItem item={{id: 'bash', role: 'assistant', content: '', toolCalls: [c], toolResults: [failed]}} />,
    );
    await settle();
    // A failure with output keeps its own entry; the preview drops the dispatcher envelope.
    expect(view.lastFrame()).toContain('Error: Exit code 7');
    expect(view.lastFrame()).toContain('source.ts:1:marker');
    expect(view.lastFrame()).not.toContain('Wall time:');
    expect(view.lastFrame()).not.toContain('0.0s');
    // Ctrl+O shows the whole envelope.
    view.rerender(
      <TranscriptItem
        detailed
        item={{id: 'bash', role: 'assistant', content: '', toolCalls: [c], toolResults: [failed]}}
      />,
    );
    await settle();
    expect(view.lastFrame()).toContain('Wall time: 0.00 s');
  });
