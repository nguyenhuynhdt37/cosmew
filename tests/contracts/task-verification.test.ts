import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Conversation} from '@cosmew/core';
import {FutrynError, type ModelEvent, type ToolCall, type ToolPort, type ToolResult} from '@cosmew/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
const usage = {inputTokens: 10, outputTokens: 5, costUSD: null};
function environment(rounds: ToolCall[][], invoke: ToolPort['invoke'], canWrite = true) {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-verification-'));
  const app = startup(home, {vault: memoryVault()});
  cleanups.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  let requests = 0;
  const c = new Conversation(
    {accountId: crypto.randomUUID(), modelId: 'fixture'},
    {
      async *stream(): AsyncGenerator<ModelEvent> {
        const calls = rounds[requests++] ?? [];
        for (const call of calls) yield {type: 'toolCallComplete', call};
        if (!calls.length) yield {type: 'textDelta', text: 'Finished with the observed results.'};
        yield {type: 'completed', finishReason: calls.length ? 'tool_calls' : 'stop', usage};
      },
      generate: async () => {
        throw new FutrynError('UNSUPPORTED');
      },
    },
    app.conversations,
    undefined,
    {
      descriptors: () => [
        {name: 'read', description: 'Read', capability: 'fs.read', inputSchema: {type: 'object'}},
        ...(canWrite
          ? [{name: 'edit', description: 'Edit', capability: 'fs.write' as const, inputSchema: {type: 'object'}}]
          : []),
        {name: 'exec_command', description: 'Check', capability: 'process.execute', inputSchema: {type: 'object'}},
      ],
      invoke,
    },
  );
  return {c, requests: () => requests, task: () => app.conversations.recover(c.id).task!};
}
const ok = (call: ToolCall, content: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  callId: call.id,
  name: call.name,
  status: 'ok',
  content,
  ...extra,
});
async function send(c: Conversation, request: string) {
  for await (const _ of c.send(request)) {
  }
}
const edit = (path: string): ToolCall => ({id: 'edit-target', name: 'edit', input: {path}});
const check: ToolCall = {id: 'check', name: 'exec_command', input: {cmd: 'project-check'}};
const receipt = (path: string) => JSON.stringify({changes: [{path, action: 'update'}]});

for (const path of ['src/main.ts', 'main.go'])
  test(`a changed ${path} with a finished check does not require a full-file reread`, async () => {
    const e = environment([[edit(path)], [check]], async call =>
      call.name === 'edit' ? ok(call, receipt(path)) : ok(call, 'check passed', {exitCode: 0}),
    );
    await send(e.c, `Fix ${path}`);
    expect(e.requests()).toBe(3);
    expect(e.task().state).toBe('verified');
    expect(e.task().verifiedActions.some(a => a.status === 'changed:' + path)).toBe(true);
    expect(e.task().verifiedActions.some(a => a.tool === 'read')).toBe(false);
  });

test('reading code is content evidence and does not prove a requested edit happened', async () => {
  const path = 'src/main.ts';
  const e = environment([[{id: 'read-target', name: 'read', input: {path}}]], async call =>
    ok(call, 'existing source'),
  );
  await send(e.c, `Fix ${path}`);
  expect(e.task().state).toBe('unfinished');
  expect(e.task().verifiedActions.some(a => a.status === 'verified:' + path)).toBe(false);
});

test('an unrelated successful check cannot prove an unwritten artifact exists', async () => {
  const e = environment([[check]], async call => ok(call, 'passed', {exitCode: 0}));
  await send(e.c, 'Create missing.ts');
  expect(e.task().state).toBe('unfinished');
});

for (const extra of [{exitCode: 1}, {sessionId: '00000000-0000-4000-8000-000000000001'}])
  test(`artifact receipt does not hide an unresolved check ${JSON.stringify(extra)}`, async () => {
    const path = 'main.ts';
    const e = environment([[edit(path)], [check]], async call =>
      call.name === 'edit' ? ok(call, receipt(path)) : ok(call, 'check result', extra),
    );
    await send(e.c, `Fix ${path} and verify the tests`);
    expect(e.task().state).toBe('unfinished');
  });

for (const request of [
  'Explain how to fix main.ts',
  'Review how to modify main.go',
  'Verify main.ts without changing it',
])
  test(`read-only intent stays read-only: ${request}`, async () => {
    const e = environment([], async call => ok(call, 'unused'));
    await send(e.c, request);
    expect(e.requests()).toBe(1);
    expect(e.task().state).toBe('verified');
  });

test('a corrected invalid lookup can continue while its failure remains visible', async () => {
  const e = environment(
    [
      [{id: 'bad', name: 'read', input: {path: 'bad-path'}}],
      [{id: 'corrected', name: 'read', input: {path: 'main.ts'}}],
    ],
    async call =>
      call.id === 'bad'
        ? {...ok(call, 'Path not found'), status: 'error', code: 'NOT_FOUND'}
        : ok(call, 'source evidence'),
  );
  await send(e.c, 'Explain main.ts');
  expect(e.task().verifiedActions.some(a => a.callId === 'corrected')).toBe(true);
  expect(e.task().failures.length).toBe(1);
  expect(e.requests()).toBe(3);
});

test('a missing write capability does not turn an unwritten artifact into completed work', async () => {
  const e = environment([], async call => ok(call, 'unused'), false);
  await send(e.c, 'Create missing.ts');
  expect(e.task().state).toBe('unfinished');
});

for (const same of [true, false])
  test(`a failed check is resolved only by the same completed command: ${same}`, async () => {
    const first: ToolCall = {id: 'red', name: 'exec_command', input: {cmd: 'test-project', workdir: 'src'}};
    const second: ToolCall = {
      id: 'green',
      name: 'exec_command',
      input: {cmd: same ? 'test-project' : 'echo unrelated', workdir: 'src'},
    };
    const e = environment([[first], [edit('main.ts')], [second]], async call =>
      call.name === 'edit'
        ? ok(call, receipt('main.ts'))
        : ok(call, 'actual result', {exitCode: call.id === 'red' ? 1 : 0}),
    );
    await send(e.c, 'Fix main.ts and verify the test');
    expect(e.task().state).toBe(same ? 'verified' : 'unfinished');
    expect(e.task().failures).toContain('exec_command exit 1');
  });

test('a denied session poll cannot remove pending command completion evidence', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000002';
  const poll: ToolCall = {id: 'poll', name: 'write_stdin', input: {session_id: sessionId}};
  const e = environment([[edit('main.ts')], [check], [poll]], async call =>
    call.name === 'edit'
      ? ok(call, receipt('main.ts'))
      : call.id === 'poll'
        ? {...ok(call, 'Denied poll'), status: 'denied'}
        : ok(call, 'running', {sessionId}),
  );
  await send(e.c, 'Fix main.ts and verify');
  expect(e.task().state).toBe('unfinished');
  expect(e.task().pending.some(p => p.includes(sessionId))).toBe(true);
});

test('a completed model plan cannot erase a failed command obligation', async () => {
  const plan: ToolCall = {
    id: 'plan',
    name: 'update_plan',
    input: {plan: [{step: 'Verify tests', status: 'completed'}]},
  };
  const e = environment([[edit('main.ts')], [check], [plan]], async call =>
    call.name === 'edit'
      ? ok(call, receipt('main.ts'))
      : call.name === 'exec_command'
        ? ok(call, 'failed', {exitCode: 1})
        : ok(call, 'Plan updated'),
  );
  await send(e.c, 'Fix main.ts and verify tests');
  expect(e.task().state).toBe('unfinished');
  expect(e.task().pending.some(p => p.startsWith('Resolve command check '))).toBe(true);
});

test('terminal session polling resolves only its own original command obligation', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000003';
  const poll: ToolCall = {id: 'finished-poll', name: 'write_stdin', input: {session_id: sessionId}};
  const e = environment([[edit('main.ts')], [check], [poll]], async call =>
    call.name === 'edit'
      ? ok(call, receipt('main.ts'))
      : call.id === 'finished-poll'
        ? ok(call, 'passed', {exitCode: 0})
        : ok(call, 'running', {sessionId}),
  );
  await send(e.c, 'Fix main.ts and verify tests');
  expect(e.task().state).toBe('verified');
  expect(e.task().pending).toEqual([]);
});
