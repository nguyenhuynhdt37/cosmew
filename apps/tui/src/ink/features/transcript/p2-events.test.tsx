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

test('a slash-command row during a live turn cannot steal model output or leave its spinner streaming', () => {
  let state = reduceTranscript({items: []}, {type: 'begin', id: 'turn', prompt: 'work', now: 1});
  state = reduceTranscript(state, {type: 'command', id: 'cmd', command: '/mcp', lines: ['Closed mcp']});
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'Final answer'}, now: 2});
  state = reduceTranscript(state, {type: 'finish', now: 3});
  expect(state.items.find(item => item.id === 'turn')).toMatchObject({
    content: 'Final answer',
    streaming: false,
    finishedAt: 3,
  });
  expect(state.items.find(item => item.id === 'cmd')).toMatchObject({content: '/mcp', notices: ['Closed mcp']});
  expect(state.items.some(item => item.streaming)).toBe(false);
});

test('starting a replacement turn cannot leave the earlier activity spinner alive', () => {
  let state = reduceTranscript({items: []}, {type: 'begin', id: 'old', prompt: 'old request', now: 1});
  state = reduceTranscript(state, {type: 'begin', id: 'new', prompt: 'new request', now: 2});
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'Done'}, now: 3});
  state = reduceTranscript(state, {type: 'finish', now: 4});
  expect(state.items.filter(item => item.streaming)).toEqual([]);
  expect(state.items.find(item => item.id === 'old')?.content).toBe('');
  expect(state.items.find(item => item.id === 'new')?.content).toBe('Done');
});

test('steering preserves interleaved command rows and completion settles the new active response', () => {
  let state = reduceTranscript({items: []}, {type: 'begin', id: 'turn', prompt: 'work', now: 1});
  state = reduceTranscript(state, {type: 'command', id: 'cmd', command: '/mcp', lines: ['Closed mcp']});
  state = reduceTranscript(state, {
    type: 'event',
    event: {type: 'steered', steerId: 'steer', content: 'finish now'},
    now: 2,
  });
  state = reduceTranscript(state, {type: 'event', event: {type: 'textDelta', text: 'Final response'}, now: 3});
  state = reduceTranscript(state, {type: 'notification', id: 'background-done', text: 'Background task finished'});
  state = reduceTranscript(state, {type: 'finish', now: 4});
  expect(state.items.find(item => item.id === 'steer')).toMatchObject({
    content: 'Final response',
    streaming: false,
    finishedAt: 4,
  });
  expect(state.items.find(item => item.id === 'cmd')).toMatchObject({content: '/mcp', notices: ['Closed mcp']});
  expect(state.items.find(item => item.id === 'background-done')?.content).toBe('Background task finished');
  expect(state.items.some(item => item.streaming)).toBe(false);
});

test('detailed transcript prefers per-item model attribution over the active session model', async () => {
  const items = [
    {id: 'u1', role: 'user' as const, content: 'First'},
    {id: 'a1', role: 'assistant' as const, content: 'Reply A', model: 'model-a'},
    {id: 'u2', role: 'user' as const, content: 'Second'},
    {id: 'a2', role: 'assistant' as const, content: 'Reply B'},
  ];
  const view = renderInk(<Transcript items={items} detailed model="model-b" animate={false} />);
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('model-a');
  expect(frame).toContain('model-b');
});
