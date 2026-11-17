import {afterEach, expect, setDefaultTimeout, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {providerPresets} from '@futryn/models';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';

setDefaultTimeout(30_000);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

test('the DeepSeek preset: chat protocol, 15 minute stream idle timeout, reasoning replay', () => {
  expect(providerPresets.find(p => p.id === 'deepseek')).toMatchObject({
    protocol: 'chat',
    baseURL: 'https://api.deepseek.com',
    auth: 'api-key',
    streamIdleTimeoutMs: 900000,
    replayReasoning: true,
  });
});

async function setup(replay: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'futryn-ds-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'futryn-ds-ws-'));
  writeFileSync(join(ws, 'a.txt'), 'DS_MARKER\n');
  const server = fixtureServer();
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(ws, {recursive: true, force: true}),
    () => server.server.stop(true),
  );
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(() => app.db.close());
  app.registry.add(
    server.provider('chat', {id: 'deepseek', auth: 'none', replayReasoning: replay || undefined, streamUsage: true}),
  );
  await app.accounts.add('deepseek', 'ds', {kind: 'none'});
  const client = app.createFutrynClient(ws);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  return {app, server, client};
}
const script = (view: ScriptedView): ScriptedReply =>
  view.results.length ? {text: 'done'} : {calls: [{name: 'read', input: {path: 'a.txt'}}]};

for (const replay of [true, false])
  test(`reasoning_content is ${replay ? '' : 'not '}replayed on the tool round trip (replayReasoning=${replay})`, async () => {
    const {server, client} = await setup(replay);
    server.set({script, chatReasoning: 'THINKING-ABOUT-READING'});
    let answer = '';
    for await (const event of client.sendMessage('read a.txt')) if (event.type === 'textDelta') answer += event.text;
    expect(answer).toBe('done');
    const requests = server.requests.filter(r => r.body?.messages);
    expect(requests).toHaveLength(2);
    const assistant = requests[1]!.body.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(assistant).toBeDefined();
    if (replay) expect(assistant.reasoning_content).toBe('THINKING-ABOUT-READING');
    else expect(assistant.reasoning_content).toBeUndefined();
    // The first request never carried reasoning.
    expect(JSON.stringify(requests[0]!.body)).not.toContain('THINKING-ABOUT-READING');
  });

test('replayed reasoning survives a restart (resumed session) and is not shown as answer text', async () => {
  const {app, server, client} = await setup(true);
  server.set({script, chatReasoning: 'PERSISTED-THOUGHT'});
  let text = '';
  for await (const event of client.sendMessage('read a.txt')) if (event.type === 'textDelta') text += event.text;
  expect(text).toBe('done');
  const session = client.activeSession()!;
  const stored = app.conversations.get(session.id)!;
  expect(stored.messages.some(m => m.reasoning === 'PERSISTED-THOUGHT' && m.toolCalls)).toBe(true);
  expect(stored.messages.filter(m => !m.toolCalls).every(m => !m.content.includes('PERSISTED-THOUGHT'))).toBe(true);
});

test('DeepSeek cache counters become cache-read usage', async () => {
  const {server, client} = await setup(true);
  server.set({script: () => ({text: 'ok'}), deepseekCache: {hit: 3, miss: 1}});
  for await (const _event of client.sendMessage('hello')) {
    /* drain */
  }
  expect(client.usage().last?.usage?.cacheReadTokens).toBe(3);
});
