import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  attributeUsage,
  combineUsage,
  MAX_USAGE_BREAKDOWN,
  usageSchema,
  type ModelPort,
  type Usage,
} from '@cosmew/contracts';
import {Conversation} from '@cosmew/core';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';

const usage = (tokens: number): Usage => ({inputTokens: tokens, outputTokens: tokens, costUSD: tokens / 100});
const source = (modelId: string) => ({accountId: crypto.randomUUID(), providerId: 'fixture', modelId});
const quota = (name: string) => [{name, usedPercent: 40, observedAt: '2026-11-22T00:00:00.000Z', resetAt: null}];

test('source buckets retain independent account quota and unknown legacy provenance', () => {
  const first = attributeUsage({...usage(10), quota: quota('first')}, source('same-model'));
  const second = attributeUsage({...usage(20), quota: quota('second')}, source('same-model'));
  const total = combineUsage(combineUsage(first, second), usage(3));
  expect(total.inputTokens).toBe(33);
  expect(total.breakdown).toHaveLength(3);
  expect(total.breakdown?.map(bucket => bucket.quota?.[0]?.name)).toEqual(['first', 'second', undefined]);
  expect(total.breakdown?.[2]?.accountId).toBeUndefined();
  expect(total.quota).toBeUndefined();
  expect(usageSchema.safeParse(total).success).toBe(true);
});

test('same identity coalesces requests while nested agent identities survive parent folding', () => {
  const parent = source('parent');
  const child = {...source('child'), agentId: crypto.randomUUID(), sessionId: crypto.randomUUID()};
  const descendant = {...source('nested'), agentId: crypto.randomUUID(), sessionId: crypto.randomUUID()};
  const children = combineUsage(attributeUsage(usage(4), child), attributeUsage(usage(8), descendant));
  const folded = attributeUsage(children, child);
  const total = combineUsage(combineUsage(attributeUsage(usage(2), parent), attributeUsage(usage(3), parent)), folded);
  expect(total.inputTokens).toBe(17);
  expect(total.breakdown).toHaveLength(3);
  expect(total.breakdown?.map(bucket => [bucket.modelId, bucket.inputTokens])).toEqual([
    ['parent', 5],
    ['child', 4],
    ['nested', 8],
  ]);
  expect(total.breakdown?.[2]?.agentId).toBe(descendant.agentId);
});

test('overflow is explicit and preserves counters without assigning unknown quota to a source', () => {
  const breakdown = Array.from({length: MAX_USAGE_BREAKDOWN}, (_, i) => ({...usage(1), ...source(`m${i}`)}));
  const total = combineUsage(
    {...usage(MAX_USAGE_BREAKDOWN), breakdown},
    attributeUsage({...usage(1), quota: quota('overflow')}, source('overflow')),
  );
  expect(total.inputTokens).toBe(MAX_USAGE_BREAKDOWN + 1);
  expect(total.breakdown).toHaveLength(MAX_USAGE_BREAKDOWN);
  expect(total.breakdownTruncated).toBe(true);
  expect(total.breakdown?.reduce((sum, bucket) => sum + (bucket.inputTokens ?? 0), 0)).toBe(MAX_USAGE_BREAKDOWN + 1);
  expect(total.breakdown?.at(-1)?.accountId).toBeUndefined();
  expect(total.breakdown?.at(-1)?.quota).toBeUndefined();
  expect(usageSchema.safeParse(total).success).toBe(true);
});

test('stream snapshots count once and nested/background usage persists with its actual source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-attribution-'));
  const db = openPrivateDatabase(root);
  try {
    const store = new SqliteConversations(db);
    const parentSource = source('actual-model');
    const childSource = {...source('child'), agentId: crypto.randomUUID(), sessionId: crypto.randomUUID()};
    const own = attributeUsage(usage(10), parentSource);
    const child = attributeUsage(usage(4), childSource);
    let conversation: Conversation;
    const model: ModelPort = {
      generate: async () => {
        throw new Error('stream only');
      },
      async *stream() {
        yield {type: 'usage', usage: own};
        conversation.addSubagentUsage(child);
        yield {type: 'usage', usage: own};
        yield {type: 'textDelta', text: 'done'};
        yield {type: 'completed', usage: own, finishReason: 'stop'};
      },
    };
    conversation = new Conversation({accountId: crypto.randomUUID(), modelId: 'selection-is-not-source'}, model, store);
    for await (const _event of conversation.send('test')) {
      /* consume */
    }
    // Late background completion folds into the durable receipt once.
    conversation.addSubagentUsage(attributeUsage(usage(2), {...source('background'), agentId: crypto.randomUUID()}));
    const saved = store.get(conversation.id)!.turns![0]!.usage!;
    expect(saved.inputTokens).toBe(16);
    expect(saved.breakdown?.map(bucket => [bucket.modelId, bucket.inputTokens])).toEqual([
      ['actual-model', 10],
      ['child', 4],
      ['background', 2],
    ]);
    expect(saved.breakdown?.[0]?.sessionId).toBe(conversation.id);
    expect(saved.breakdown?.[0]?.accountId).toBe(parentSource.accountId);
    expect(saved.breakdown?.[1]?.agentId).toBe(childSource.agentId);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('known reported and estimated cost evidence survives unknown requests from the same source', () => {
  const identity = source('mixed-cost');
  const total = combineUsage(
    combineUsage(attributeUsage(usage(1), identity), attributeUsage({...usage(2), costEstimated: true}, identity)),
    attributeUsage({...usage(3), costUSD: null}, identity),
  );
  expect(total.costUSD).toBeNull();
  expect(total.breakdown?.map(bucket => [bucket.costUSD, bucket.costEstimated ?? false])).toEqual([
    [0.01, false],
    [0.02, true],
    [null, false],
  ]);
});

test('source quota snapshots survive missing headers and ignore older observations', () => {
  const identity = source('quota');
  const first = attributeUsage({...usage(1), quota: quota('requests')}, identity);
  const older = attributeUsage(
    {...usage(1), quota: [{...quota('requests')[0]!, usedPercent: 1, observedAt: '2026-11-21T00:00:00.000Z'}]},
    identity,
  );
  const result = combineUsage(combineUsage(first, older), attributeUsage(usage(1), identity));
  expect(result.breakdown?.[0]?.quota?.[0]?.usedPercent).toBe(40);
  expect(result.quota?.[0]?.usedPercent).toBe(40);
});
