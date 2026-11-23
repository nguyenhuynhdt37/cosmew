import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynError, type ModelEvent, type ModelPort, type ModelRequest} from '@cosmew/contracts';
import {COMPACTION_PROMPT, Conversation, SUMMARY_PREFIX, estimateTokens} from '@cosmew/core';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test('a persisted model checkpoint retains three later turns after SQLite close and reopen', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-compact-restart-'));
  let app = startup(home, {vault: memoryVault()});
  cleanups.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  const selection = {accountId: crypto.randomUUID(), modelId: 'fixture'};
  const requests: ModelRequest[] = [];
  let summaryCalls = 0;
  const summary = 'EXACT-CHECKPOINT: investigation constraints and confirmed evidence.';
  const usage = {inputTokens: 10, outputTokens: 5, costUSD: null};
  const model: ModelPort = {
    async *stream(request): AsyncGenerator<ModelEvent> {
      requests.push(request);
      const summarizing = request.messages.at(-1)?.content.startsWith(COMPACTION_PROMPT.slice(0, 30));
      if (summarizing) summaryCalls++;
      const text = summarizing
        ? summary
        : request.messages.at(-1)!.content.startsWith('old-')
          ? 'OLD-BULK-REPLY ' + 'historical detailed evidence '.repeat(600)
          : `answer:${request.messages.at(-1)!.content}`;
      yield {type: 'textDelta', text};
      yield {type: 'completed', finishReason: 'stop', usage};
    },
    generate: async () => {
      throw new FutrynError('UNSUPPORTED');
    },
  };
  const options = {contextLimit: () => 128000, autoCompact: () => false};
  const conversation = new Conversation(
    selection,
    model,
    app.conversations,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
  const send = async (target: Conversation, text: string) => {
    for await (const _ of target.send(text)) {
      /* drain the actual journaled turn */
    }
  };
  for (let i = 0; i < 4; i++) await send(conversation, `old-${i}`);
  expect(await conversation.compact()).toMatchObject({compacted: true, strategy: 'model'});
  const checkpoint = app.conversations.recover(conversation.id).compaction!;
  expect(checkpoint.summary).toBe(summary);
  for (let i = 0; i < 3; i++) await send(conversation, `recent-${i}`);
  const before = [...conversation.history()];
  const previewBefore = conversation.previewContext(undefined, 0);
  expect(before).toHaveLength(14);
  expect(summaryCalls).toBe(1);
  app.db.close();
  app = startup(home, {vault: memoryVault()});
  const recovered = app.conversations.recover(conversation.id);
  expect(recovered.compaction).toEqual(checkpoint);
  expect(recovered.messages).toEqual(before);
  const reopened = new Conversation(
    selection,
    model,
    app.conversations,
    {id: conversation.id, messages: recovered.messages},
    undefined,
    undefined,
    undefined,
    options,
  );
  expect(reopened.history()).toEqual(before);
  expect(reopened.previewContext(undefined, 0)).toEqual(previewBefore);
  expect(previewBefore.estimateTokens).toBeLessThan(estimateTokens(before) / 4);
  await send(reopened, 'after-restart');
  const sent = requests.at(-1)!;
  expect(sent.messages.filter(message => message.content.startsWith(SUMMARY_PREFIX))).toEqual([
    {role: 'user', content: `${SUMMARY_PREFIX}\n${summary}`},
  ]);
  expect(sent.messages.slice(-7).map(message => message.content)).toEqual([
    'recent-0',
    'answer:recent-0',
    'recent-1',
    'answer:recent-1',
    'recent-2',
    'answer:recent-2',
    'after-restart',
  ]);
  expect(sent.messages.some(message => message.content.includes('OLD-BULK-REPLY'))).toBe(false);
  expect(summaryCalls).toBe(1);
  expect(reopened.history()).toHaveLength(16);
});

test('public SDK resume after closing SQLite preserves compacted preview and all recent chat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-sdk-compact-restart-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const wire: {messages: {role: string; content: string}[]}[] = [];
  let summaries = 0;
  const summary = 'SDK-EXACT-CHECKPOINT: preserve the investigation and recent chat.';
  const services = {
    vault: memoryVault(),
    offline: true,
    fetch: (async (_url, init) => {
      if (!init?.body) return Response.json({data: [{id: 'fixture-model'}]});
      const body = JSON.parse(String(init.body));
      wire.push(body);
      const summarizing = body.messages.at(-1)?.content.startsWith(COMPACTION_PROMPT.slice(0, 30));
      if (summarizing) summaries++;
      const last = body.messages.at(-1)!.content;
      const content = summarizing
        ? summary
        : last.startsWith('old-sdk-')
          ? 'SDK-OLD-BULK ' + 'historical evidence '.repeat(600)
          : `reply:${last}`;
      const base = {id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model'};
      return new Response(
        [
          {...base, choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: null}]},
          {
            ...base,
            choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 100, completion_tokens: 10, total_tokens: 110},
          },
        ]
          .map(event => `data: ${JSON.stringify(event)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
        {headers: {'content-type': 'text/event-stream'}},
      );
    }) as typeof fetch,
  };
  let app = startup(home, services);
  cleanups.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  app.registry.add({
    id: 'sdk-compact-fixture',
    name: 'Fixture',
    baseURL: 'https://api.example.test/v1',
    protocol: 'chat',
    auth: 'none',
    catalog: 'openai',
    metadataVersion: 1,
    streamUsage: true,
  });
  await app.accounts.add('sdk-compact-fixture', 'Fixture', {kind: 'none'});
  let client = app.createFutrynClient(workspace);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.updateUserPreferences({autoCompact: false});
  const send = async (text: string) => {
    for await (const _ of client.sendMessage(text)) {
      /* consume */
    }
  };
  for (let i = 0; i < 4; i++) await send(`old-sdk-${i}`);
  expect(await client.compact()).toMatchObject({compacted: true, strategy: 'model'});
  for (let i = 0; i < 3; i++) await send(`recent-sdk-${i}`);
  const session = client.activeSession()!;
  const preview = client.context();
  const checkpoint = app.conversations.recover(session.id).compaction;
  expect(preview.estimateSource).toBe('preview');
  expect(session.messages).toHaveLength(14);
  expect(summaries).toBe(1);
  await app.shutdownCommands();
  app.db.close();
  app = startup(home, services);
  client = app.createFutrynClient(workspace);
  const resumed = client.resumeSession(session.id);
  expect(resumed.messages).toEqual(session.messages);
  expect(client.activeSession()!.messages).toEqual(session.messages);
  expect(client.getSession(session.id)!.recovery!.messages).toEqual(session.messages);
  expect(app.conversations.recover(session.id).compaction).toEqual(checkpoint);
  expect(client.context().estimateSource).toBe('preview');
  expect(client.context().estimateTokens).toBe(preview.estimateTokens);
  await send('after-sdk-restart');
  const messages = wire.at(-1)!.messages;
  expect(messages.some(message => message.content === `${SUMMARY_PREFIX}\n${summary}`)).toBe(true);
  expect(messages.slice(-7).map(message => message.content)).toEqual([
    'recent-sdk-0',
    'reply:recent-sdk-0',
    'recent-sdk-1',
    'reply:recent-sdk-1',
    'recent-sdk-2',
    'reply:recent-sdk-2',
    'after-sdk-restart',
  ]);
  expect(messages.some(message => message.content.includes('SDK-OLD-BULK'))).toBe(false);
  expect(summaries).toBe(1);
  expect(client.activeSession()!.messages).toHaveLength(16);
  await app.shutdownCommands();
});
