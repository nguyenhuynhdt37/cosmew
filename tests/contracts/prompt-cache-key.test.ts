import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelPort, ModelRequest} from '@futryn/contracts';
import {Conversation} from '@futryn/core';
import {openPrivateDatabase, SqliteConversations} from '@futryn/persistence';
import {SessionGrants} from '@futryn/security';
import {ToolDispatcher} from '@futryn/tools';
import {WorkspaceRoot} from '@futryn/workspace';

/** F5: every round of one session carries the same cache key and the same instructions/tools prefix. */
async function run(rounds: number) {
  const root = mkdtempSync(join(tmpdir(), 'futryn-cache-key-'));
  const db = openPrivateDatabase(root);
  const seen: ModelRequest[] = [];
  try {
    writeFileSync(join(root, 'note.txt'), 'cache fixture');
    const model: ModelPort = {
      generate: async () => {
        throw new Error('stream only');
      },
      async *stream(request) {
        const index = seen.push(request) - 1;
        if (index < rounds - 1)
          yield {type: 'toolCallComplete', call: {id: `read-${index}`, name: 'read', input: {path: 'note.txt'}}};
        else yield {type: 'textDelta', text: 'Done'};
        yield {
          type: 'completed',
          finishReason: index < rounds - 1 ? 'tool-calls' : 'stop',
          usage: {inputTokens: 10, outputTokens: 1, costUSD: 0},
        };
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
      new SqliteConversations(db),
      undefined,
      tools,
    );
    for await (const _ of conversation.send('Read the note')) void _;
    for await (const _ of conversation.send('Read it again')) void _;
    return {seen, id: conversation.id};
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
}

test('cacheKey is the conversation id on every request, with an identical instructions and tools prefix', async () => {
  const a = await run(3);
  expect(a.seen.length).toBeGreaterThanOrEqual(4);
  expect(new Set(a.seen.map(r => r.cacheKey))).toEqual(new Set([a.id]));
  expect(new Set(a.seen.map(r => r.instructions)).size).toBe(1);
  expect(new Set(a.seen.map(r => JSON.stringify(r.tools))).size).toBe(1);
  const b = await run(1);
  expect(b.id).not.toBe(a.id);
  expect(b.seen[0]!.cacheKey).toBe(b.id);
});
