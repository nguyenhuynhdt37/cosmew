import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SubagentManager} from '@cosmew/agents';
import type {ModelEvent, ModelInfo, SubagentEvent} from '@cosmew/contracts';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach(fn => fn()),
);
const pause = (ms = 130) => new Promise(resolve => setTimeout(resolve, ms));
const text = (event: SubagentEvent) =>
  'steps' in event
    ? (event.steps ?? [])
        .filter(step => step.kind === 'text')
        .map(step => step.text)
        .join('')
    : '';
function setup(run: (signal: AbortSignal) => AsyncIterable<ModelEvent>) {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-live-text-'));
  const db = openPrivateDatabase(dir);
  cleanup.push(() => {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  });
  const store = new SqliteConversations(db, s => s);
  const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
  const parent = store.create(selection);
  const events: SubagentEvent[] = [];
  const manager = new SubagentManager({
    getConfig: () => ({}),
    getParentState: () => ({sessionId: parent, selection, analysisOnly: false, messages: []}),
    lookupModel: () => ({selection, model: {id: 'fixture', capabilities: {tools: 'supported'}} as ModelInfo}),
    availableModelIds: () => ['fixture'],
    store,
    runChildTurn: (_context, signal) => run(signal),
    addParentUsage: () => undefined,
    redact: value => value.replaceAll('SECRET_TOKEN', '[REDACTED]'),
    onBackgroundEvent: event => events.push(event),
  });
  const spawn = (signal?: AbortSignal, background = false) =>
    manager.run(
      'call',
      {
        agent_type: 'explore',
        description: 'Inspect',
        prompt: 'Inspect files',
        background,
      },
      signal,
      event => events.push(event),
    );
  return {manager, events, spawn};
}

test('publishes coalesced redacted live text before child completion and deduplicates final steps', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const fixture = setup(async function* () {
    yield {type: 'started', requestId: 'request'};
    for (const chunk of ['Working ', 'SECRET_', 'TOKEN', ' done']) yield {type: 'textDelta', text: chunk};
    await gate;
  });
  const pending = fixture.spawn();
  try {
    await pause();
    const updates = fixture.events.filter(event => event.type === 'subagent.progress');
    expect(updates).toHaveLength(1);
    expect(text(updates[0]!)).toBe('Working [REDACTED] done');
    expect(fixture.events.some(event => event.type === 'subagent.finished')).toBe(false);
    const started = fixture.events.find(event => event.type === 'subagent.started')!;
    const snapshot = fixture.manager.inspectSubagent(started.agentId)!;
    expect(snapshot.status).toBe('running');
    expect(
      snapshot.steps
        .filter(step => step.kind === 'text')
        .map(step => step.text)
        .join(''),
    ).toBe('Working [REDACTED] done');
  } finally {
    release();
  }
  expect((await pending).status).toBe('ok');
  const finished = fixture.events.at(-1)!;
  expect(finished.type).toBe('subagent.finished');
  expect(text(finished)).toBe('Working [REDACTED] done');
  expect(JSON.stringify(fixture.events)).not.toContain('SECRET_TOKEN');
});

test('retry retracts already published provisional text and retains preceding responses', async () => {
  const fixture = setup(async function* () {
    yield {type: 'started', requestId: 'first'};
    yield {type: 'textDelta', text: 'Accepted. '};
    yield {type: 'started', requestId: 'retrying'};
    yield {type: 'textDelta', text: 'Discard me'};
    await pause();
    yield {type: 'responseDiscarded', reason: 'retry'};
    yield {type: 'started', requestId: 'replacement'};
    yield {type: 'textDelta', text: 'Replacement.'};
  });
  await fixture.spawn();
  const projections = fixture.events.filter(event => event.type === 'subagent.progress').map(text);
  expect(projections).toContain('Accepted. Discard me');
  expect(projections).toContain('Accepted. ');
  expect(text(fixture.events.at(-1)!)).toBe('Accepted. Replacement.');
});

test('bounds text and step snapshots under many responses and token bursts', async () => {
  const fixture = setup(async function* () {
    for (let response = 0; response < 70; response++) {
      yield {type: 'started', requestId: String(response)};
      for (let token = 0; token < 100; token++) yield {type: 'textDelta', text: 'x'.repeat(100)};
    }
  });
  await fixture.spawn();
  const updates = fixture.events.filter(event => event.type === 'subagent.progress');
  expect(updates.length).toBeLessThanOrEqual(70);
  for (const event of fixture.events)
    if ('steps' in event) {
      expect(event.steps!.length).toBeLessThanOrEqual(64);
      for (const step of event.steps!) if (step.kind === 'text') expect(step.text!.length).toBeLessThanOrEqual(4000);
    }
});

test('cancellation clears pending text timer and cannot publish after finished', async () => {
  const controller = new AbortController();
  const fixture = setup(async function* (signal) {
    yield {type: 'started', requestId: 'cancel'};
    yield {type: 'textDelta', text: 'Never published'};
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
    signal.throwIfAborted();
  });
  const pending = fixture.spawn(controller.signal);
  await pause(10);
  controller.abort();
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
  const count = fixture.events.length;
  await pause();
  expect(fixture.events).toHaveLength(count);
  expect(fixture.events.filter(event => event.type === 'subagent.progress')).toHaveLength(0);
  expect(fixture.manager.scheduler.activeCount()).toBe(0);
});

test('background progress uses the same live text projection', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const fixture = setup(async function* () {
    yield {type: 'started', requestId: 'background'};
    yield {type: 'textDelta', text: 'Background update'};
    await gate;
  });
  const result = await fixture.spawn(undefined, true);
  const id = JSON.parse(result.content).id as string;
  try {
    await pause();
    expect(
      fixture.events.some(
        event => event.type === 'subagent.progress' && event.background && text(event) === 'Background update',
      ),
    ).toBe(true);
  } finally {
    release();
  }
  await fixture.manager.scheduler.getTask(id)!.done;
  expect(text(fixture.events.at(-1)!)).toBe('Background update');
});

test('failure clears pending text timer and tool boundaries preserve text activity order', async () => {
  const fixture = setup(async function* () {
    yield {type: 'started', requestId: 'failure'};
    yield {type: 'textDelta', text: 'Checking files'};
    yield {type: 'toolCallComplete', call: {id: 'read', name: 'read', input: {path: 'file.ts'}}};
    yield {type: 'textDelta', text: ' pending'};
    throw new Error('Provider failed');
  });
  expect((await fixture.spawn()).status).toBe('error');
  const count = fixture.events.length;
  await pause();
  expect(fixture.events).toHaveLength(count);
  const finished = fixture.events.at(-1)!;
  expect(finished.type).toBe('subagent.finished');
  if (finished.type === 'subagent.finished') {
    expect(finished.status).toBe('failed');
    expect(finished.steps?.map(step => step.kind)).toEqual(['text', 'tool']);
    expect(text(finished)).toBe('Checking files');
  }
  expect(fixture.manager.scheduler.activeCount()).toBe(0);
});
