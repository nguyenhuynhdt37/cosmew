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
  const millisecond = attributeUsage(
    {...usage(1), quota: [{...quota('requests')[0]!, usedPercent: 45, observedAt: '2026-11-22T00:00:00.001Z'}]},
    identity,
  );
  const noFraction = attributeUsage(
    {...usage(1), quota: [{...quota('requests')[0]!, observedAt: '2026-11-22T00:00:00Z'}]},
    identity,
  );
  expect(combineUsage(noFraction, millisecond).breakdown?.[0]?.quota?.[0]?.usedPercent).toBe(45);
});

test('combineUsage preserves optional counters across undefined, numeric and explicit null values', () => {
  const identity = source('optional-counters');
  const withoutOptional = attributeUsage({inputTokens: 10, outputTokens: 5, costUSD: 0.01}, identity);
  const withOptional = attributeUsage(
    {
      inputTokens: 20,
      outputTokens: 15,
      costUSD: 0.02,
      cacheReadTokens: 80,
      reasoningTokens: 10,
    },
    identity,
  );
  const withOptionalSecond = attributeUsage(
    {
      inputTokens: 30,
      outputTokens: 25,
      costUSD: 0.03,
      cacheReadTokens: 40,
      reasoningTokens: 5,
    },
    identity,
  );

  // When every request reports the optional counter, totals add cleanly.
  const bothReported = combineUsage(withOptional, withOptionalSecond);
  expect(bothReported.cacheReadTokens).toBe(120);
  expect(bothReported.reasoningTokens).toBe(15);
  expect(bothReported.breakdown?.[0]?.cacheReadTokens).toBe(120);
  expect(bothReported.breakdown?.[0]?.reasoningTokens).toBe(15);
  expect('cacheWriteTokens' in bothReported).toBe(false);
  expect('premiumRequests' in bothReported).toBe(false);
  expect(usageSchema.safeParse(bothReported).success).toBe(true);

  // When one request omits an optional counter and another reports it, the aggregate remains unknown (null).
  const mergedForward = combineUsage(withoutOptional, withOptional);
  expect(mergedForward.cacheReadTokens).toBeNull();
  expect(mergedForward.reasoningTokens).toBeNull();
  expect(mergedForward.breakdown?.[0]?.cacheReadTokens).toBeNull();
  expect(mergedForward.breakdown?.[0]?.reasoningTokens).toBeNull();
  expect('cacheWriteTokens' in mergedForward).toBe(false);
  expect('premiumRequests' in mergedForward).toBe(false);
  expect(usageSchema.safeParse(mergedForward).success).toBe(true);

  const mergedReverse = combineUsage(withOptional, withoutOptional);
  expect(mergedReverse.cacheReadTokens).toBeNull();
  expect(mergedReverse.reasoningTokens).toBeNull();

  // Merging two usages whose optional counters are both undefined never invents null keys.
  const bothUndefined = combineUsage(
    {inputTokens: 4, outputTokens: 2, costUSD: 0.01, cacheReadTokens: undefined},
    {inputTokens: 6, outputTokens: 3, costUSD: 0.02},
  );
  expect(bothUndefined.cacheReadTokens).toBeUndefined();
  expect('cacheReadTokens' in bothUndefined).toBe(false);
  expect('cacheWriteTokens' in bothUndefined).toBe(false);
  expect('reasoningTokens' in bothUndefined).toBe(false);
  expect('premiumRequests' in bothUndefined).toBe(false);
  expect(usageSchema.safeParse(bothUndefined).success).toBe(true);

  // When either side explicitly reports null, null is preserved.
  const explicitNullLeft = combineUsage(
    attributeUsage(
      {inputTokens: 5, outputTokens: 5, costUSD: 0.01, cacheReadTokens: null, reasoningTokens: 7},
      identity,
    ),
    withOptional,
  );
  expect(explicitNullLeft.cacheReadTokens).toBeNull();
  expect(explicitNullLeft.reasoningTokens).toBe(17);
  expect(explicitNullLeft.breakdown?.[0]?.cacheReadTokens).toBeNull();
  expect(usageSchema.safeParse(explicitNullLeft).success).toBe(true);

  const explicitNullRight = combineUsage(
    withOptional,
    attributeUsage(
      {inputTokens: 5, outputTokens: 5, costUSD: 0.01, cacheReadTokens: null, reasoningTokens: 7},
      identity,
    ),
  );
  expect(explicitNullRight.cacheReadTokens).toBeNull();
  expect(explicitNullRight.reasoningTokens).toBe(17);
  expect(usageSchema.safeParse(explicitNullRight).success).toBe(true);
});
