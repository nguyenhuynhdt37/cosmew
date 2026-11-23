/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import type {ToolCall, ToolResult} from '@cosmew/contracts';
import {renderInk, settle} from '../../testing';
import {Spinner, turnVerb, TURN_VERBS} from '../../ui/spinner';
import {Transcript, TranscriptItem, formatClock, reduceTranscript, type TranscriptItem as Item} from './index';

afterEach(cleanup);
const REF = `${import.meta.dir}/../../../../../../docs/delivery/tui-v4/reference/live-120x36`;
/** Reference rows (1-based as captured) as text, cut at `cut` columns to drop the diff panel on the right. */
async function reference(name: string, from: number, to: number, cut = 120): Promise<string[]> {
  const rows = new Map(
    (await Bun.file(`${REF}/${name}.txt`).text())
      .split('\n')
      .map(line => /^(\d+)\|(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map(
        m =>
          [
            Number(m[1]),
            m[2]!
              .replace(/\u00a0/g, ' ')
              .slice(0, cut)
              .trimEnd(),
          ] as const,
      ),
  );
  return Array.from({length: to - from + 1}, (_, i) => rows.get(from + i) ?? '');
}
const frameLines = (frame: string | undefined) =>
  (frame ?? '')
    .replace(/\x1b\[[\d;]*m/g, '')
    .split('\n')
    .map(line => line.trimEnd());
const result = (call: ToolCall, content: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  callId: call.id,
  name: call.name,
  status: 'ok',
  content,
  ...extra,
});
const at = (hour: number, minute = 0) => new Date(2026, 10, 19, hour, minute).getTime();
const user = (id: string, content: string): Item => ({id, role: 'user', content});

const lsCall: ToolCall = {id: 'ls', name: 'exec_command', input: {cmd: 'ls -la'}};
const answer = [
  '`ls -la` lists **5 entries**:',
  '',
  '1. . (the current directory)',
  '2. .. (the parent directory)',
  '3. .git',
  '4. a.txt',
  '5. index.ts',
  '',
  'Leaving out . and .., the directory holds 3 items: .git, a.txt and index.ts.',
].join('\n');
const lsTurn: Item = {
  id: 'ls-turn',
  role: 'assistant',
  content: answer,
  startedAt: at(23, 0) - 8000,
  finishedAt: at(23, 0),
  durationMs: 8000,
  toolCalls: [lsCall],
  toolResults: [result(lsCall, 'total 0\n. .. .git a.txt index.ts')],
  parts: [
    {kind: 'tools', callIds: ['ls']},
    {kind: 'text', text: answer},
  ],
};

test('L01: user row, merged `Listed 1 directory`, answer with numbered list and end-of-turn line match the reference rows', async () => {
  const view = renderInk(
    <Transcript
      bounded
      width={120}
      items={[user('u', 'Run the shell command `ls -la` and tell me how many entries it lists.'), lsTurn]}
    />,
  );
  await settle();
  const got = frameLines(view.lastFrame());
  const want = await reference('L01-bash-done', 11, 28);
  // Rows 11-23 (prompt, grouped tool line, answer, list, last paragraph line) are identical text.
  expect(got.slice(0, 13)).toEqual(want.slice(0, 13));
  expect(got[0]).toBe('❯ Run the shell command ls -la and tell me how many entries it lists.');
  expect(got[2]).toBe('  Listed 1 directory');
  expect(got[4]).toBe('⏺ ls -la lists 5 entries:');
  // `✻ <Past-tense verb> for 8s · done 11:00 PM`: Cosmew's own verb, the reference's duration and clock.
  const end = got.find(line => line.startsWith('✻'))!;
  expect(end).toMatch(/^✻ \S+ for 8s · done 11:00 PM$/);
  expect(want.at(-1)).toMatch(/^✻ \S+ for 8s · done 11:00 PM$/);
  expect(TURN_VERBS.map(([, past]) => past)).toContain(end.split(' ')[1]!);
});

test('L02: a single edit stands alone as Update(a.txt) with the diff gutter, after a merged read', async () => {
  const read: ToolCall = {id: 'r', name: 'read', input: {path: 'a.txt'}};
  const edit: ToolCall = {id: 'e', name: 'edit', input: {path: 'a.txt'}};
  const receipt = JSON.stringify({
    changes: [{path: 'a.txt', action: 'update', diff: '@@ -1,2 +1,2 @@\n-hello\n+HELLO\n world'}],
  });
  const view = renderInk(
    <Transcript
      bounded
      width={120}
      items={[
        user('u', 'In a.txt replace the word hello with HELLO.'),
        {
          id: 't',
          role: 'assistant',
          content: '',
          toolCalls: [read, edit],
          toolResults: [result(read, '     1\thello\n     2\tworld'), result(edit, receipt)],
          parts: [{kind: 'tools', callIds: ['r', 'e']}],
        },
      ]}
    />,
  );
  await settle();
  const got = frameLines(view.lastFrame());
  const want = await reference('L02-edit-done', 18, 27, 65);
  expect(got).toEqual(want.concat(['']).slice(0, got.length));
  expect(got.slice(2)).toEqual([
    '  Read 1 file',
    '',
    '⏺ Update(a.txt)',
    '  ⎿  Added 1 line, removed 1 line',
    '      1 -hello',
    '      1 +HELLO',
    '      2  world',
    '',
  ]);
});

test('L06: Write shows `Wrote N lines`, ten numbered rows and `… +40 lines` (no signs, no background)', async () => {
  const write: ToolCall = {id: 'w', name: 'write', input: {path: 'poem.txt'}};
  const lines = Array.from({length: 60}, (_, n) => `line ${n + 1}`);
  const receipt = JSON.stringify({
    changes: [{path: 'poem.txt', action: 'add', diff: `@@ -0,0 +1,60 @@\n${lines.map(line => `+${line}`).join('\n')}`}],
  });
  const view = renderInk(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        toolCalls: [write],
        toolResults: [result(write, receipt)],
        parts: [{kind: 'tools', callIds: ['w']}],
      }}
    />,
  );
  await settle();
  const got = frameLines(view.lastFrame());
  expect(got.slice(0, 5)).toEqual([
    '⏺ Write(poem.txt)',
    '  ⎿  Wrote 60 lines to poem.txt',
    '       1 line 1',
    '       2 line 2',
    '       3 line 3',
  ]);
  // Two-digit gutter from row 10, then the reference's truncation row `     … +50 lines` (60 - 10 here: 50).
  expect(got).toContain('      10 line 10');
  expect(got).toContain('     … +50 lines');
  expect(got).not.toContain('      11 line 11');
  const refRows = await reference('L06-agent-spinner1', 5, 17, 65);
  expect(refRows[0]).toBe('  ⎿  Wrote 60 lines to poem.txt');
  expect(refRows[1]).toMatch(/^ {7}1 A cursor/);
  expect(refRows[11]).toBe('     … +50 lines');
});

test('L14: an interrupted turn ends with the Interrupted line directly under the partial answer', async () => {
  const view = renderInk(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: 'Partial answer',
        interrupted: true,
        durationMs: 3000,
        finishedAt: at(23, 8),
        parts: [{kind: 'text', text: 'Partial answer'}],
      }}
    />,
  );
  await settle();
  const got = frameLines(view.lastFrame());
  expect(got.slice(0, 2)).toEqual(['⏺ Partial answer', '  ⎿  Interrupted · What should Cosmew do instead?']);
  expect(got.join('\n')).not.toContain('✻');
  expect((await reference('L14-interrupted', 29, 29))[0]).toBe('  ⎿  Interrupted · What should Claude do instead?');
});

test('L13: a failed shell command merges as `Ran 1 shell command · 1 failed`; output keeps its own entry', async () => {
  const bare: ToolCall = {id: 'f', name: 'exec_command', input: {cmd: 'false'}};
  const noisy: ToolCall = {id: 'n', name: 'exec_command', input: {cmd: 'tsc --noEmit'}};
  const view = renderInk(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        toolCalls: [bare],
        toolResults: [result(bare, '', {status: 'ok', exitCode: 1})],
        parts: [{kind: 'tools', callIds: ['f']}],
      }}
    />,
  );
  await settle();
  expect(frameLines(view.lastFrame())[0]).toBe('  Ran 1 shell command · 1 failed');
  expect((await reference('L13-fail-done', 23, 23))[0]).toBe('  Ran 1 shell command · 1 failed');
  view.rerender(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        toolCalls: [noisy],
        toolResults: [result(noisy, 'src/a.ts(1,1): error TS2322', {exitCode: 2})],
        parts: [{kind: 'tools', callIds: ['n']}],
      }}
    />,
  );
  await settle();
  const frame = frameLines(view.lastFrame()).join('\n');
  // The reason a command failed is never hidden behind the one-line summary.
  expect(frame).toContain('⏺ Bash(tsc --noEmit)');
  expect(frame).toContain('Error: Exit code 2');
  expect(frame).toContain('error TS2322');
});

test('summaries merge consecutive tools of a turn and count each kind', async () => {
  const calls: ToolCall[] = [
    {id: '1', name: 'read', input: {path: 'a'}},
    {id: '2', name: 'read', input: {path: 'b'}},
    {id: '3', name: 'grep', input: {pattern: 'x'}},
    {id: '4', name: 'exec_command', input: {cmd: 'pnpm test'}},
    {id: '5', name: 'exec_command', input: {cmd: 'ls src'}},
  ];
  const view = renderInk(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        toolCalls: calls,
        toolResults: calls.map(call => result(call, 'x', {exitCode: call.name === 'exec_command' ? 0 : undefined})),
        parts: [
          {kind: 'tools', callIds: ['1', '2']},
          {kind: 'tools', callIds: ['3', '4', '5']},
        ],
      }}
    />,
  );
  await settle();
  expect(frameLines(view.lastFrame())[0]).toBe(
    '  Searched for 1 pattern, read 2 files, listed 1 directory, ran 1 shell command',
  );
  // While a tool has no result the same line is in the present tense.
  view.rerender(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        streaming: true,
        toolCalls: [calls[0]!],
        toolResults: [],
        parts: [{kind: 'tools', callIds: ['1']}],
      }}
    />,
  );
  await settle();
  expect(frameLines(view.lastFrame())[0]).toBe('  Reading 1 file…');
});

test('two successful edits merge into `Made 2 edits +a -r`; a refused edit never does', async () => {
  const receipt = (path: string) =>
    JSON.stringify({changes: [{path, action: 'update', diff: '@@ -1,1 +1,2 @@\n-a\n+b\n+c'}]});
  const one: ToolCall = {id: 'e1', name: 'edit', input: {path: 'a.ts'}};
  const two: ToolCall = {id: 'e2', name: 'edit', input: {path: 'b.ts'}};
  const view = renderInk(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        toolCalls: [one, two],
        toolResults: [result(one, receipt('a.ts')), result(two, receipt('b.ts'))],
        parts: [{kind: 'tools', callIds: ['e1', 'e2']}],
      }}
    />,
  );
  await settle();
  expect(frameLines(view.lastFrame())[0]).toBe('  Made 2 edits +4 -2');
  view.rerender(
    <TranscriptItem
      width={120}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        toolCalls: [one, two],
        toolResults: [
          result(one, receipt('a.ts')),
          result(two, 'Permission refused by the user', {status: 'denied', code: 'DENIED'}),
        ],
        parts: [{kind: 'tools', callIds: ['e1', 'e2']}],
      }}
    />,
  );
  await settle();
  const frame = frameLines(view.lastFrame()).join('\n');
  expect(frame).toContain('⏺ Update(a.ts)');
  expect(frame).toContain('⏺ Update(b.ts)');
  expect(frame).toContain('Update denied');
  expect(frame).toContain('Permission refused by the user');
  expect(frame).not.toContain('Made 2 edits');
});

test('L08 Ctrl+O: every tool as ⏺ Name(arg), right-aligned `<time> <model>` before each answer', async () => {
  const sleep: ToolCall = {id: 's', name: 'exec_command', input: {cmd: 'sleep 40'}};
  const item: Item = {
    id: 't',
    role: 'assistant',
    content: 'started',
    model: 'claude-opus-5-5',
    toolCalls: [sleep],
    toolResults: [result(sleep, 'Process running with session ID 1', {sessionId: '1'})],
    parts: [
      {kind: 'tools', callIds: ['s']},
      {kind: 'text', text: 'started', at: at(23, 5)},
    ],
  };
  const view = renderInk(<Transcript bounded detailed width={120} items={[item]} />);
  await settle();
  const got = frameLines(view.lastFrame());
  const want = await reference('L08-ctrl-o', 18, 23);
  expect(got[0]).toBe(want[0]);
  expect(got[0]).toBe('⏺ Bash(sleep 40)');
  expect(got).toContain(want[4]!);
  expect(got.find(line => line.includes('11:05 PM'))).toBe(' '.repeat(95) + '11:05 PM claude-opus-5-5');
  expect(got[got.findIndex(line => line.includes('11:05 PM')) + 1]).toBe('⏺ started');
  // Normal mode hides the tool line behind a summary and has no header.
  view.rerender(<Transcript bounded width={120} items={[item]} />);
  await settle();
  const normal = frameLines(view.lastFrame());
  expect(normal.join('\n')).not.toContain('Bash(sleep 40)');
  expect(normal.join('\n')).not.toContain('11:05 PM');
});

test('spinner: glyph and verb in the rule colour role, detail only after a few seconds, tokens and effort only when real', async () => {
  const view = renderInk(
    <Spinner seed="s" elapsedMs={1000} animate={false} tip="Send a message mid-task to steer Cosmew" />,
  );
  await settle();
  const verb = turnVerb('s').present;
  expect(frameLines(view.lastFrame())).toEqual([`✻ ${verb}…`, '  ⎿  Tip: Send a message mid-task to steer Cosmew']);
  view.rerender(<Spinner seed="s" elapsedMs={7000} tokens={279} animate={false} />);
  await settle();
  expect(frameLines(view.lastFrame())[0]).toBe(`✻ ${verb}… (7s · ↓ 279 tokens)`);
  view.rerender(<Spinner seed="s" elapsedMs={6000} tokens={278} effort="medium" thinking animate={false} />);
  await settle();
  expect(frameLines(view.lastFrame())[0]).toBe(`✻ ${verb}… (6s · ↓ 278 tokens · thinking with medium effort)`);
  // Unknown token usage is omitted rather than shown as zero; effort is not shown unless the model is thinking.
  view.rerender(<Spinner seed="s" elapsedMs={9000} effort="medium" animate={false} />);
  await settle();
  expect(frameLines(view.lastFrame())[0]).toBe(`✻ ${verb}… (9s)`);
});

test('formatClock is a 12-hour local clock without locale-dependent spacing', () => {
  expect(formatClock(at(23, 0))).toBe('11:00 PM');
  expect(formatClock(at(0, 5))).toBe('12:05 AM');
  expect(formatClock(at(12, 30))).toBe('12:30 PM');
});

test.skipIf(process.env.FORCE_COLOR !== '3')(
  'colour roles: user background spans the row, diff rows carry add/remove backgrounds',
  async () => {
    const {ThemeEngine} = await import('../../../theme/theme');
    const edit: ToolCall = {id: 'e', name: 'edit', input: {path: 'a.txt'}};
    const receipt = JSON.stringify({
      changes: [{path: 'a.txt', action: 'update', diff: '@@ -1,1 +1,1 @@\n-hello\n+HELLO'}],
    });
    for (const dark of [false, true]) {
      const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: dark});
      const view = renderInk(
        <Transcript
          bounded
          width={40}
          items={[
            user('u', 'hi'),
            {
              id: 't',
              role: 'assistant',
              content: '',
              toolCalls: [edit],
              toolResults: [result(edit, receipt)],
              parts: [{kind: 'tools', callIds: ['e']}],
            },
          ]}
        />,
        {themeEngine: engine},
      );
      await settle();
      const rows = view.lastFrame()!.split('\n');
      const userBg = /\x1b\[48;2;(\d+;\d+;\d+)m/.exec(rows[0]!)?.[1];
      expect(userBg).toBe(dark ? '53;57;64' : '242;243;243');
      // The padding after the prompt text is painted too (full-width row).
      expect(rows[0]!.replace(/\x1b\[[\d;]*m/g, '')).toHaveLength(40);
      const removed = rows.find(row => row.includes('hello'))!;
      const added = rows.find(row => row.includes('HELLO'))!;
      expect(/\x1b\[48;2;(\d+;\d+;\d+)m/.exec(removed)?.[1]).toBe(dark ? '66;59;60' : '232;225;226');
      expect(/\x1b\[48;2;(\d+;\d+;\d+)m/.exec(added)?.[1]).toBe(dark ? '58;64;59' : '224;228;225');
      view.unmount();
    }
  },
);

test('long user prompts wrap with continuation rows indented 2 and keep every word', async () => {
  const text =
    'Use TodoWrite to create 3 todos (alpha, beta, gamma) and complete them one at a time, updating TodoWrite after each; use no other tools.';
  const view = renderInk(<Transcript bounded width={66} items={[user('u', text)]} />);
  await settle();
  const rows = frameLines(view.lastFrame()).filter(Boolean);
  // Reference L04: width 66 pane wraps after `and` and after `use`.
  expect(rows).toEqual([
    '❯ Use TodoWrite to create 3 todos (alpha, beta, gamma) and',
    '  complete them one at a time, updating TodoWrite after each; use',
    '  no other tools.',
  ]);
  expect(rows.join(' ').replace(/ {2,}/g, ' ')).toContain('updating TodoWrite after each; use no other tools.');
});

test('answered questions render as the reference `Answered … questions:` block', async () => {
  const ask: ToolCall = {
    id: 'q',
    name: 'request_user_input',
    input: {questions: [{id: 'color', question: 'Which color do you prefer, red or blue?'}]},
  };
  const view = renderInk(
    <TranscriptItem
      width={80}
      item={{
        id: 't',
        role: 'assistant',
        content: '',
        toolCalls: [ask],
        toolResults: [result(ask, JSON.stringify({answers: {color: {answers: ['Red']}}}))],
        parts: [{kind: 'tools', callIds: ['q']}],
      }}
    />,
  );
  await settle();
  expect(frameLines(view.lastFrame()).slice(0, 2)).toEqual([
    "⏺ Answered Cosmew's questions:",
    '  ⎿  · Which color do you prefer, red or blue? → Red',
  ]);
});

test('reducer keeps the model, per-part arrival times and the finish clock for the detailed view', () => {
  let state = reduceTranscript({items: []}, {type: 'begin', id: 'a', prompt: 'hi', now: 1000, model: 'm-1'});
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'x'}, now: 2000});
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'y'}, now: 3000});
  state = reduceTranscript(state, {type: 'finish', now: 9000});
  const item = state.items.at(-1)!;
  expect(item).toMatchObject({model: 'm-1', durationMs: 8000, finishedAt: 9000});
  expect(item.parts).toEqual([{kind: 'text', text: 'xy', at: 2000}]);
});

// 2.1.330 captures are authoritative; compare the viewer region, not the product-specific banner.
const PARITY_REF = `${import.meta.dir}/../../../../../../docs/delivery/tui-v4/reference/transcript-2.1.330`;
async function viewerReference(width: number, name: string) {
  const rows = (await Bun.file(`${PARITY_REF}/${width}x36-${name}.txt`).text())
    .split('\n')
    .map(line => /^\d+\|(.*)$/.exec(line)?.[1] ?? '');
  const rule = rows.findIndex(row => row.startsWith('─'));
  return rows
    .slice(rule)
    .map(normalizeViewer)
    .filter(line => line !== '');
}
function normalizeViewer(line: string) {
  return line
    .replace(/Claude Code|Cosmew/g, '<product>')
    .replace(/open in (?:code|editor)/g, 'open in <editor>')
    .trimEnd();
}
for (const width of [100, 40]) {
  test(`2.1.330 footer frame matches at ${width} columns`, async () => {
    const {DetailedFooter} = await import('./detailed-footer');
    const view = renderInk(<DetailedFooter width={width} editorName="editor" />);
    await settle();
    expect(frameLines(view.lastFrame()).map(normalizeViewer).filter(Boolean)).toEqual(
      await viewerReference(width, '01-ctrl-o'),
    );
    view.unmount();
  });
  test(`2.1.330 legend frame matches at ${width} columns`, async () => {
    const {TranscriptLegend} = await import('./legend');
    const view = renderInk(<TranscriptLegend width={width} editorName="editor" />);
    await settle();
    expect(frameLines(view.lastFrame()).map(normalizeViewer).filter(Boolean)).toEqual(
      await viewerReference(width, '02-help'),
    );
    view.unmount();
  });
  for (const [name, query, badge] of [
    ['03-search-empty', '', undefined],
    ['05-search-no-match', 'zz_transcript_no_match_98371', 'no matches'],
  ] as const) {
    test(`2.1.330 ${name} frame matches at ${width} columns`, async () => {
      const {SearchBar} = await import('./search-bar');
      const view = renderInk(
        <SearchBar width={width} query={query} badge={badge} onChange={() => {}} onClose={() => {}} />,
      );
      await settle();
      expect(frameLines(view.lastFrame()).map(normalizeViewer).filter(Boolean)).toEqual(
        await viewerReference(width, name),
      );
      view.unmount();
    });
  }
}
