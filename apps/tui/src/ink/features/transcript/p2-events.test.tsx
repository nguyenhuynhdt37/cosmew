/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {reduceTranscript, Transcript, type TranscriptState} from './index';
import {renderInk, settle} from '../../testing';

afterEach(cleanup);

test('preemption discards provisional model text and retains observed hooks exactly once', () => {
  let state = reduceTranscript({items: []}, {type: 'begin', id: 'turn', prompt: 'work', now: 0});
  const hook = {type: 'hook.ran' as const, event: 'PostToolUse' as const, name: 'Check', summary: 'Completed'};
  state = reduceTranscript(state, {type: 'event', event: hook, now: 1});
  state = reduceTranscript(state, {type: 'event', event: {type: 'started', requestId: 'r'}, now: 2});
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'discard me'}, now: 3});
  state = reduceTranscript(state, {type: 'event', event: hook, now: 4});
  state = reduceTranscript(state, {type: 'event', event: {type: 'responseDiscarded', reason: 'preempted'}, now: 5});
  expect(state.items.at(-1)?.content).toBe('');
  expect(state.items.at(-1)?.parts?.map(part => part.kind)).toEqual(['hook', 'hook']);
});

test('background completion deduplicates without redirecting the running turn output or cancellation', () => {
  let state = reduceTranscript({items: []}, {type: 'begin', id: 'turn', prompt: 'work', now: 10});
  const notification = {
    type: 'notification' as const,
    id: 'task:1',
    text: 'Background command "build" completed (exit code 0)',
  };
  state = reduceTranscript(state, notification);
  expect(reduceTranscript(state, notification)).toBe(state);
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'Still working'}, now: 12});
  state = reduceTranscript(state, {type: 'finish', cancelled: true, now: 13});
  expect(state.items.find(item => item.id === 'task:1')?.content).toBe(notification.text);
  expect(state.items.at(-1)?.id).toBe('turn');
  expect(state.items.at(-1)?.content).toBe('Still working');
  expect(state.items.at(-1)?.interrupted).toBe(true);
});

test('hook events preserve arrival order, render names and PostToolUse count only in detail mode', async () => {
  let state: TranscriptState = reduceTranscript({items: []}, {type: 'begin', id: 't', prompt: 'test', now: 0});
  state = reduceTranscript(state, {type: 'event', now: 1, event: {type: 'textDelta', text: 'Before hook'}});
  for (const event of ['PostToolUse', 'Stop'] as const)
    state = reduceTranscript(state, {
      type: 'event',
      now: 2,
      event: {type: 'hook.ran', event, name: 'Check', summary: `${event} finished`},
    });
  state = reduceTranscript(state, {type: 'event', now: 3, event: {type: 'textDelta', text: 'After hook'}});
  expect(state.items.at(-1)?.parts?.map(part => part.kind)).toEqual(['text', 'hook', 'hook', 'text']);
  const view = renderInk(<Transcript items={state.items} detailed={false} animate={false} />);
  await settle();
  expect(view.lastFrame()).not.toContain('Check says:');
  view.rerender(<Transcript items={state.items} detailed animate={false} />);
  await settle();
  expect(view.lastFrame()).toContain('⎿  Check says: PostToolUse finished');
  expect(view.lastFrame()).toContain('⎿  1 PostToolUse hooks ran');
  const frame = view.lastFrame()!;
  expect(frame.indexOf('Before hook')).toBeLessThan(frame.indexOf('Check says:'));
  expect(frame.indexOf('Check says:')).toBeLessThan(frame.indexOf('After hook'));
});
