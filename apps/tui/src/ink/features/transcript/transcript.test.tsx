/** @jsxImportSource react */
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Box, Text} from 'ink';
import {InputScope} from '../../hooks';
import {renderInk, settle} from '../../testing';
import {
  Transcript,
  TranscriptItem,
  messagesToTranscript,
  reduceTranscript,
  transcriptWindow,
  toolState,
  useTranscript,
  type TranscriptState,
  type TranscriptItem as Item,
} from './index';
afterEach(cleanup);
const citation =
  '<oai-mem-citation>\n<citation_entries>\nproject-map.md:1-3|note=[architecture]\n</citation_entries>\n</oai-mem-citation>';
const call = {id: 'read-1', name: 'read', input: {path: 'src/main.ts'}};
function start(): TranscriptState {
  return reduceTranscript({items: []}, {type: 'begin', id: 'turn', prompt: 'hello', now: 10});
}
function event(state: TranscriptState, event: Parameters<typeof reduceTranscript>[1] & {type: 'event'}) {
  return reduceTranscript(state, event);
}
describe('transcript event presentation', () => {
  test('preserves text/reasoning/tool round chronology and immutable snapshots', () => {
    const initial = start();
    let state = event(initial, {type: 'event', event: {type: 'reasoningDelta', text: 'why'}, now: 11});
    state = event(state, {type: 'event', event: {type: 'textDelta', text: 'before'}, now: 12});
    state = event(state, {type: 'event', event: {type: 'toolCallComplete', call}, now: 13});
    state = event(state, {
      type: 'event',
      event: {
        type: 'toolResult',
        result: {callId: call.id, name: 'read', status: 'denied', code: 'DENIED', content: 'refused'},
      },
      now: 14,
    });
    state = event(state, {type: 'event', event: {type: 'toolCallComplete', call: {...call, id: 'next'}}, now: 15});
    expect(state.items.at(-1)?.parts?.map(part => part.kind)).toEqual(['reasoning', 'text', 'tools', 'tools']);
    expect(initial.items.at(-1)?.parts).toEqual([]);
  });
  test('discard removes provisional text and keeps actual tool executions', () => {
    let state = start();
    state = event(state, {type: 'event', event: {type: 'toolCallComplete', call}, now: 11});
    state = event(state, {type: 'event', event: {type: 'started', requestId: 'r'}, now: 12});
    state = event(state, {type: 'event', event: {type: 'textDelta', text: 'wrong'}, now: 13});
    state = event(state, {type: 'event', event: {type: 'toolCallComplete', call: {...call, id: 'next'}}, now: 14});
    state = event(state, {type: 'event', event: {type: 'responseDiscarded', reason: 'preempted'}, now: 15});
    expect(state.items.at(-1)?.content).toBe('');
    expect(state.items.at(-1)?.parts?.flatMap(part => (part.kind === 'tools' ? part.callIds : []))).toEqual([
      'read-1',
      'next',
    ]);
    expect(state.items.at(-1)?.toolCalls).toHaveLength(2);
  });
  test('stream output bounded, final result authoritative, cancellation does not invent result', () => {
    let state = start();
    state = event(state, {type: 'event', event: {type: 'toolCallComplete', call}, now: 11});
    state = event(state, {
      type: 'event',
      event: {type: 'toolOutputDelta', callId: call.id, name: call.name, stream: 'stdout', text: 'x'.repeat(300000)},
      now: 12,
    });
    expect(state.items.at(-1)?.toolOutput?.[call.id]?.length).toBe(262144);
    state = reduceTranscript(state, {type: 'finish', cancelled: true, now: 100});
    expect(state.items.at(-1)?.interrupted).toBe(true);
    expect(state.items.at(-1)?.finishedAt).toBe(100);
    expect(state.items.at(-1)?.toolResults).toEqual([]);
    expect(toolState(undefined, false)).toContain('stopped');
  });
  test('steering is displayed only on delivered event and starts a new assistant', () => {
    const state = event(start(), {
      type: 'event',
      event: {type: 'steered', steerId: 's', content: 'correction'},
      now: 20,
    });
    expect(state.items.map(item => item.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(state.items[1]?.streaming).toBe(false);
    expect(state.items.at(-1)?.awaitingModel).toBe(true);
  });
  test('replay preserves errors, denied status, chronology and command exit codes', () => {
    const items = messagesToTranscript([
      {role: 'user', content: 'run'},
      {role: 'assistant', content: 'before', toolCalls: [{...call, name: 'exec_command'}]},
      {role: 'tool', content: '[error: EXEC_FAILED] Exit code: 2\nno', toolCallId: call.id, toolName: 'exec_command'},
      {role: 'assistant', content: 'after'},
    ]);
    expect(items[1]?.parts?.map(part => part.kind)).toEqual(['text', 'tools', 'text']);
    expect(items[1]?.toolResults?.[0]).toMatchObject({status: 'error', exitCode: 2, code: 'EXEC_FAILED'});
  });
  test('Static boundary is a settled prefix and bounds 1500 message live rendering', () => {
    const items: Item[] = Array.from({length: 1500}, (_, n) => ({id: `${n}`, role: 'assistant', content: `row ${n}`}));
    const result = transcriptWindow(items);
    expect(result.settled).toHaveLength(1492);
    expect(result.live).toHaveLength(8);
    items[1490]!.streaming = true;
    expect(transcriptWindow(items).settled).toHaveLength(1490);
  });
});
describe('Ink transcript', () => {
  test('renders user, Markdown, reasoning collapsed and compact memory citation (F13)', async () => {
    const view = renderInk(
      <Box flexDirection="column">
        <TranscriptItem item={{id: 'u', role: 'user', content: 'prompt'}} />
        <TranscriptItem
          item={{id: 'a', role: 'assistant', content: `**Answer**\n${citation}`, reasoning: 'secret thought'}}
        />
      </Box>,
    );
    await settle();
    const frame = view.lastFrame()!;
    expect(frame).toContain('❯ prompt');
    expect(frame).toContain('Answer');
    expect(frame).toContain('✻ Thinking…');
    expect(frame).not.toContain('secret thought');
    expect(frame).toContain('Ký ức đã dùng: project-map.md');
    expect(frame).not.toContain('<oai-mem-citation>');
    expect(frame).not.toContain('\u001b[');
  });
  test('hides incomplete streamed citations, including opening tag split across deltas', async () => {
    const view = renderInk(
      <TranscriptItem
        item={{id: 'a', role: 'assistant', content: 'answer\n<oai-mem-ci', streaming: true}}
        animate={false}
      />,
    );
    await settle();
    expect(view.lastFrame()).toContain('answer');
    expect(view.lastFrame()).not.toContain('<oai');
    view.rerender(
      <TranscriptItem item={{id: 'a', role: 'assistant', content: `answer\n${citation}`, streaming: false}} />,
    );
    await settle();
    expect(view.lastFrame()).toContain('Ký ức đã dùng: project-map.md');
  });
  test('citation in earlier text part does not eat later text after tools', async () => {
    const view = renderInk(
      <TranscriptItem
        item={{
          id: 'a',
          role: 'assistant',
          content: '',
          toolCalls: [call],
          toolResults: [{callId: call.id, name: call.name, status: 'ok', content: 'read'}],
          parts: [
            {kind: 'text', text: `before\n${citation}\n`},
            {kind: 'tools', callIds: [call.id]},
            {kind: 'text', text: 'after'},
          ],
        }}
      />,
    );
    await settle();
    expect(view.lastFrame()).toContain('before');
    expect(view.lastFrame()).toContain('after');
    expect(view.lastFrame()).not.toContain('<oai');
  });
  test('Ctrl+O expands only focused item; overlay scope disables shortcuts', async () => {
    const items: Item[] = [
      {
        id: 'a',
        role: 'assistant',
        content: '',
        parts: [
          {kind: 'reasoning', text: 'private reasoning'},
          {kind: 'tools', callIds: ['one', 'two']},
        ],
        toolCalls: [
          {...call, id: 'one'},
          {...call, id: 'two'},
        ],
        toolResults: ['one', 'two'].map(id => ({
          callId: id,
          name: 'read',
          status: 'ok',
          content: `a\nb\nc\nd\n${id}-hidden`,
        })),
      },
    ];
    const view = renderInk(
      <InputScope active={true}>
        <Transcript items={items} isActive />
      </InputScope>,
    );
    await settle();
    expect(view.lastFrame()).not.toContain('two-hidden');
    view.stdin.write('\u000f');
    await settle();
    expect(view.lastFrame()).toContain('two-hidden');
    expect(view.lastFrame()).not.toContain('one-hidden');
    expect(view.lastFrame()).not.toContain('private reasoning');
    view.rerender(
      <InputScope active={false}>
        <Transcript items={items} isActive />
      </InputScope>,
    );
    await settle();
    view.stdin.write('\u000f');
    await settle();
    expect(view.lastFrame()).toContain('two-hidden');
  });
  test('history inspection mounts a bounded window, supports narrow CJK resize', async () => {
    const items: Item[] = Array.from({length: 1500}, (_, n) => ({
      id: `${n}`,
      role: 'user',
      content: `row ${n} 日本語 👨‍👩‍👦`,
    }));
    const view = renderInk(<Transcript items={items} width={24} historyOffset={10} liveItems={4} />);
    await settle();
    expect(view.lastFrame()).toContain('4 of 1500');
    expect(view.lastFrame()).toContain('row 1489');
    expect(view.lastFrame()).not.toContain('row 1490');
    view.rerender(<Transcript items={items} width={14} historyOffset={0} liveItems={2} />);
    await settle();
    expect(view.lastFrame()).toContain('row 1499');
  });
  test('Static history is not reprinted when live tail changes', async () => {
    const items: Item[] = Array.from({length: 12}, (_, n) => ({id: `${n}`, role: 'user', content: `settled-${n}`}));
    const view = renderInk(<Transcript items={items} liveItems={2} />);
    await settle();
    view.rerender(
      <Transcript items={[...items.slice(0, -1), {...items.at(-1)!, content: 'changed tail'}]} liveItems={2} />,
    );
    await settle();
    expect(view.lastFrame()).toContain('changed tail');
    expect(view.lastFrame()!.split('❯ settled-0').length - 1).toBe(1);
  });
  test('hook feeds SDK event lifecycle without starting a provider request', async () => {
    let state: ReturnType<typeof useTranscript> | undefined;
    function Harness() {
      state = useTranscript();
      return <Text>{state.items.map(item => item.content).join('|')}</Text>;
    }
    const view = renderInk(<Harness />);
    await settle();
    state!.begin('hello', 't');
    await settle();
    state!.applyEvent({type: 'textDelta', text: 'response'});
    await settle();
    expect(view.lastFrame()).toContain('hello|response');
    state!.finish({cancelled: true});
    await settle();
    expect(state!.items.at(-1)?.streaming).toBe(false);
    state!.reset([]);
    await settle();
    expect(state!.items).toEqual([]);
  });
});

test('real Static rendering exceeds 1000 lines and streaming updates retain history once', async () => {
  const history: Item[] = Array.from({length: 110}, (_, index) => ({
    id: `history-${index}`,
    role: 'user',
    content: Array.from({length: 10}, (_, line) => `h${index}:${line}`).join('\n'),
  }));
  const view = renderInk(
    <Transcript
      items={[...history, {id: 'live', role: 'assistant', content: '', streaming: true}]}
      liveItems={2}
      animate={false}
    />,
  );
  await settle();
  for (let index = 1; index <= 3; index++) {
    view.rerender(
      <Transcript
        items={[...history, {id: 'live', role: 'assistant', content: `stream-${index}`, streaming: true}]}
        liveItems={2}
        animate={false}
      />,
    );
    await settle();
  }
  expect(view.lastFrame()).toContain('stream-3');
  expect(view.lastFrame()!.split('❯ h0:0').length - 1).toBe(1);
  expect(view.lastFrame()).toContain('h109:9');
  // This stress case renders 1,100 real terminal rows. Its assertions concern
  // retention and once-only delivery; native PTY tests own the input latency budget.
}, 15000);

test('citation code examples are preserved and reasoning focus expands independently', async () => {
  const items: Item[] = [
    {id: 'a', role: 'assistant', content: `\`\`\`xml\n${citation}\n\`\`\``, reasoning: 'expanded reasoning'},
  ];
  const view = renderInk(<Transcript items={items} isActive />);
  await settle();
  expect(view.lastFrame()).toContain('<oai-mem-citation>');
  expect(view.lastFrame()).not.toContain('Ký ức đã dùng:');
  view.stdin.write('\u000f');
  await settle();
  expect(view.lastFrame()).toContain('expanded reasoning');
});

test('shell continuation and nonzero exit are never described as successful completion', () => {
  expect(
    toolState(
      {callId: 'c', name: 'exec_command', status: 'ok', content: '', sessionId: '00000000-0000-4000-8000-000000000001'},
      false,
    ),
  ).toContain('running');
  expect(toolState({callId: 'c', name: 'exec_command', status: 'ok', content: '', exitCode: 1}, false)).toContain(
    'error',
  );
});
test('a streaming answer shows a bounded tail; the finished item keeps every line', async () => {
  const {liveTail} = await import('./index');
  const text = Array.from({length: 2000}, (_, n) => `line ${n}`).join('\n');
  const tail = liveTail(text, 20);
  expect(tail.split('\n')).toHaveLength(21);
  expect(tail).toContain('1980 earlier lines');
  expect(tail).toContain('line 1999');
  expect(tail).not.toContain('line 1000');
  expect(liveTail('short\nanswer', 20)).toBe('short\nanswer');
});

const windowHistory: Item[] = Array.from({length: 35}, (_, n) => ({
  id: `window-${n}`,
  role: 'user',
  content: `message-${String(n).padStart(3, '0')}`,
}));

test('detailed transcript shows only the recent 30 with the evidence hidden-count hint, then shows all', async () => {
  const view = renderInk(<Transcript items={windowHistory} detailed animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('Ctrl+E to show 5 previous messages');
  expect(view.lastFrame()).not.toContain('message-004');
  expect(view.lastFrame()).toContain('message-005');
  expect(view.lastFrame()).toContain('message-034');
  view.rerender(<Transcript items={windowHistory} detailed showAll animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('message-000');
  expect(view.lastFrame()).toContain('Ctrl+E to hide 5 previous messages');
  expect(view.lastFrame()).not.toContain('to show 5');
  view.rerender(<Transcript items={windowHistory} detailed animate={false} />);
  await settle();
  expect(view.lastFrame()).not.toContain('message-000');
});

test('short detailed histories have no hidden-count hint; non-detailed histories are never windowed', async () => {
  const view = renderInk(<Transcript items={windowHistory.slice(0, 4)} detailed animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('message-000');
  expect(view.lastFrame()).not.toContain('previous messages');
  view.rerender(<Transcript items={windowHistory} bounded animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('message-000');
  expect(view.lastFrame()).toContain('message-034');
  expect(view.lastFrame()).not.toContain('previous messages');
});

test('virtual scrolling bypasses the detailed recent window and its hints', async () => {
  const view = renderInk(<Transcript items={windowHistory} detailed virtualScroll animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('message-000');
  expect(view.lastFrame()).toContain('message-034');
  expect(view.lastFrame()).not.toContain('previous messages');
});
