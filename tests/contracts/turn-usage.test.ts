import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelPort, Usage} from '@futryn/contracts';
import {Conversation} from '@futryn/core';
import {openPrivateDatabase, SqliteConversations} from '@futryn/persistence';
import {SessionGrants} from '@futryn/security';
import {ToolDispatcher} from '@futryn/tools';
import {WorkspaceRoot} from '@futryn/workspace';
import {deriveTokensFromTriplet, renderTranscriptMessages} from '@futryn/tui';

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

test('turn footer labels input/output and cache without adding subsets, and wraps at narrow widths', () => {
  for (const width of [24, 80, 160]) {
    const rows = renderTranscriptMessages({
      items: [
        {
          id: 'usage',
          role: 'assistant',
          content: '',
          durationMs: 14100,
          usage: {inputTokens: 112000, outputTokens: 704, costUSD: null, cacheReadTokens: 100000, reasoningTokens: 100},
        },
      ],
      width,
      tokens: deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f'),
      borderStyle: 'rounded',
    });
    const text = rows.map(row => row.spans.map(span => span.text).join('')).join('\n');
    expect(text).toContain('Turn total');
    expect(text.replace(/\s+/g, ' ')).toContain('112000 in');
    expect(text.replace(/\s+/g, ' ')).toContain('704 out');
    expect(text).toContain('cache read');
    expect(text).not.toContain('212804');
    for (const row of rows) expect(row.spans.map(span => span.text).join('').length).toBeLessThanOrEqual(width);
  }
});

test('footer displays unknown output explicitly and preserves reported zero counts', () => {
  const text = renderTranscriptMessages({
    items: [{id: 'usage', role: 'assistant', content: '', usage: {inputTokens: 0, outputTokens: null, costUSD: null}}],
    width: 100,
    tokens: deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f'),
    borderStyle: 'rounded',
  })
    .flatMap(row => row.spans.map(span => span.text))
    .join('\n');
  expect(text).toContain('0 in');
  expect(text).toContain('? out');
});
