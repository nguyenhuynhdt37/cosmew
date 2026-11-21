/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Text} from 'ink';
import type {SubagentSummaryView} from '@cosmew/contracts';
import {renderInk, settle} from '../../testing';
import {Subagents, tokenTotal, useSubagents} from './index';
afterEach(cleanup);
const child: SubagentSummaryView = {
  id: 'child',
  parentConversationId: 'parent',
  parentTurnId: null,
  callId: 'call',
  depth: 1,
  agentType: 'worker',
  description: 'Implement feature',
  selection: {accountId: '00000000-0000-4000-8000-000000000001', modelId: 'm'},
  forkContext: false,
  background: true,
  status: 'running',
  toolCount: 2,
  usage: null,
  createdAt: '2026-11-18T00:00:00Z',
  finishedAt: null,
  summary: '',
  steps: [
    {kind: 'tool', toolName: 'edit', target: 'a.ts', status: 'running', output: 'a\nb\nc\nd\nHIDDEN'},
    {kind: 'text', text: '**child answer**'},
  ],
};
test('unknown tokens remain unknown rather than fake zero', () => {
  expect(tokenTotal(null)).toBeUndefined();
  expect(tokenTotal({inputTokens: 5, outputTokens: 7, costUSD: null})).toBe(12);
});
test('tree renders truthful progress; Enter opens child; expansion is scoped to selected child', async () => {
  let inspected = '';
  const view = renderInk(
    <Subagents
      agents={[child, {...child, id: 'second', depth: 2, status: 'failed', errorCode: 'CANCELLED'}]}
      isActive
      width={90}
      onInspect={id => {
        inspected = id;
        return undefined;
      }}
    />,
  );
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('❯ worker(Implement feature)');
  expect(frame).toContain('⎿  Running in the background (2 tool uses');
  expect(frame).toContain('Failed: CANCELLED');
  // Unknown usage is omitted, never shown as a zero.
  expect(frame).not.toContain('tokens');
  view.stdin.write('\r');
  await settle();
  expect(inspected).toBe('child');
  expect(view.lastFrame()).toContain('child answer');
  expect(view.lastFrame()).not.toContain('HIDDEN');
  view.stdin.write('\u000f');
  await settle();
  expect(view.lastFrame()).toContain('HIDDEN');
  view.stdin.write('\u001b[B');
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(inspected).toBe('second');
});
test('subagent hook reads SDK and unsupported inspect stays undefined', async () => {
  let state: ReturnType<typeof useSubagents> | undefined;
  function Harness() {
    state = useSubagents();
    return <Text>{state.agents.length} children</Text>;
  }
  const view = renderInk(<Harness />);
  await settle();
  expect(view.lastFrame()).toContain('0 children');
  expect(state!.inspect('missing')).toBeUndefined();
  expect(() => state!.stop('missing')).toThrow();
});

test('opened child transcript hides raw memory block and retains provenance line', async () => {
  const view = renderInk(
    <Subagents
      agents={[
        {
          ...child,
          summary:
            'Done\n<oai-mem-citation>\n<citation_entries>\nchild-notes.md\n</citation_entries>\n</oai-mem-citation>',
        },
      ]}
      isActive
      width={90}
    />,
  );
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(view.lastFrame()).toContain('Ký ức đã dùng: child-notes.md');
  expect(view.lastFrame()).not.toContain('<oai-mem-citation>');
});

test('finished children read like the reference: Done with real tool count, tokens and duration', async () => {
  const view = renderInk(
    <Subagents
      agents={[
        {
          ...child,
          background: false,
          status: 'completed',
          toolCount: 1,
          usage: {inputTokens: 1000, outputTokens: 2300, costUSD: null},
          finishedAt: '2026-11-18T00:00:08Z',
        },
      ]}
      width={90}
    />,
  );
  await settle();
  expect(view.lastFrame()).toContain('⏺ worker(Implement feature)');
  expect(view.lastFrame()).toContain('⎿  Done (1 tool use · 3.3k tokens · 8s)');
});
