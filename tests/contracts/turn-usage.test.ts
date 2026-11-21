import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelPort, Usage} from '@cosmew/contracts';
import {Conversation} from '@cosmew/core';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {SessionGrants} from '@cosmew/security';
import {ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';

async function roundTrip(usages: Usage[]) {
  const root = mkdtempSync(join(tmpdir(), 'futryn-turn-usage-'));
  const db = openPrivateDatabase(root);
  try {
    writeFileSync(join(root, 'note.txt'), 'usage fixture');
    const store = new SqliteConversations(db);
    let round = 0;
    const model: ModelPort = {
      generate: async () => {
        throw new Error('stream only');
      },
      async *stream() {
        const index = round++;
        const usage = usages[index]!;
        yield {type: 'usage', usage};
        yield {type: 'usage', usage}; // snapshots, never deltas
        if (index < usages.length - 1)
          yield {type: 'toolCallComplete', call: {id: `read-${index}`, name: 'read', input: {path: 'note.txt'}}};
        else yield {type: 'textDelta', text: 'Done'};
        yield {type: 'completed', finishReason: index < usages.length - 1 ? 'tool-calls' : 'stop', usage};
      },
    };
    const tools = new ToolDispatcher({
      workspace: new WorkspaceRoot(root),
      grants: new SessionGrants(),
      approve: async () => 'once',
      redact: text => text,
    });
    const conversation = new Conversation(
      {accountId: crypto.randomUUID(), modelId: 'fixture'},
      model,
      store,
      undefined,
      tools,
    );
    for await (const event of conversation.send('Read the note')) {
      if (event.type === 'toolResult') expect(event.result.status).toBe('ok');
    }
    expect(round).toBe(usages.length);
    return store.get(conversation.id)!.turns![0]!.usage!;
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
}

test('multi-request turn adds every usage counter once despite repeated usage and completed snapshots', async () => {
  const usage = await roundTrip([
    {
      inputTokens: 100,
      outputTokens: 10,
      costUSD: 0.1,
      costEstimated: true,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      reasoningTokens: 3,
      premiumRequests: 1,
    },
    {
      inputTokens: 200,
      outputTokens: 20,
      costUSD: 0.2,
      cacheReadTokens: 80,
      cacheWriteTokens: 6,
      reasoningTokens: 4,
      premiumRequests: 2,
    },
  ]);
  expect(usage).toMatchObject({
    inputTokens: 300,
    outputTokens: 30,
    cacheReadTokens: 120,
    cacheWriteTokens: 11,
    reasoningTokens: 7,
    premiumRequests: 3,
    costEstimated: true,
  });
  expect(usage.costUSD).toBeCloseTo(0.3);
});

test('unreported request counters remain unknown in totals rather than becoming zero or latest-round values', async () => {
  const usage = await roundTrip([
    {inputTokens: null, outputTokens: 10, costUSD: null},
    {inputTokens: 200, outputTokens: 20, costUSD: 0.2, cacheReadTokens: 80, cacheWriteTokens: 6, reasoningTokens: 4},
  ]);
  expect(usage).toMatchObject({
    inputTokens: null,
    outputTokens: 30,
    costUSD: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  });
});
