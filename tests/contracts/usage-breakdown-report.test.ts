import {expect, test} from 'bun:test';
import type {TurnReceipt, Usage, UsageBreakdown} from '@cosmew/contracts';
import type {AccountLimits, FutrynClient} from '@cosmew/sdk';
import {summarizeUsage} from '../../packages/sdk/src/telemetry';
import {
  limitItemText,
  limitRows,
  limitSnapshotText,
  usageBreakdownRows,
  reportRows,
} from '../../apps/tui/src/ink/features/usage/logic';
import {usageMeters} from '../../apps/tui/src/ink/features/settings/logic';

const accountA = crypto.randomUUID();
const accountB = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const agentId = crypto.randomUUID();
function receipt(usage: Usage | null): TurnReceipt {
  return {
    requestId: crypto.randomUUID(),
    accountId: accountA,
    modelId: 'parent-selection',
    startedAt: '2026-11-22T00:00:00Z',
    finishedAt: '2026-11-22T00:01:00Z',
    outcome: 'completed',
    context: null,
    usage,
  };
}
function source(
  providerId: string,
  accountId: string,
  inputTokens: number,
  extra: Partial<UsageBreakdown> = {},
): UsageBreakdown {
  return {
    providerId,
    accountId,
    modelId: 'shared-name',
    sessionId,
    inputTokens,
    outputTokens: 2,
    costUSD: null,
    ...extra,
  };
}

test('identical model names remain separate by provider/account and child sources partition parent totals', () => {
  const parent = source('provider-a', accountA, 10, {costUSD: 0.1, costEstimated: true});
  const child = source('provider-b', accountB, 20, {agentId, costUSD: 0.2});
  const report = summarizeUsage(
    [receipt({inputTokens: 30, outputTokens: 4, costUSD: 0.3, costEstimated: true, breakdown: [parent, child]})],
    0,
  );
  expect(report.inputTokens).toBe(30);
  expect(report.byModel).toHaveLength(2);
  expect(report.byProvider.map(row => [row.providerId, row.inputTokens])).toEqual([
    ['provider-a', 10],
    ['provider-b', 20],
  ]);
  expect(report.byAccount.map(row => row.accountId)).toEqual([accountA, accountB]);
  expect(report.byAgent.find(row => row.agentId === agentId)?.inputTokens).toBe(20);
  expect(report.byModel.reduce((total, row) => total + (row.inputTokens ?? 0), 0)).toBe(30);
  expect(report.estimatedCostUSD).toBe(0.1);
  expect(report.reportedCostUSD).toBe(0.2);
  expect(report.unknownSourceTurns).toBe(0);
  const rows = usageBreakdownRows(report).join('\n');
  expect(rows).toContain('shared-name / provider-a');
  expect(rows).toContain('shared-name / provider-b');
  expect(rows).not.toContain('parent-selection');
});

test('legacy aggregate provenance stays unknown; unknown prices and missing history are not free', () => {
  const report = summarizeUsage(
    [
      receipt({inputTokens: 17, outputTokens: 3, costUSD: null}),
      receipt({
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        breakdown: [source('provider-a', accountA, 0, {outputTokens: 0, costUSD: 0})],
      }),
    ],
    2,
  );
  expect(report.inputTokens).toBe(17);
  expect(report.costUSD).toBe(0);
  expect(report.unknownTurns).toBe(2);
  expect(report.unknownSourceTurns).toBe(1);
  expect(report.byModel[0]).toMatchObject({providerId: null, accountId: null, modelId: null, costUSD: null});
  expect(report.unknownCostSources).toBe(1);
  expect(usageBreakdownRows(report).join('\n')).toContain('1 source(s) unpriced');
  expect(summarizeUsage([receipt(null)], 0).costUSD).toBeNull();
});

test('truncated attribution is visible and source sections explicitly describe subdivisions', () => {
  const report = summarizeUsage(
    [receipt({inputTokens: 1, outputTokens: 1, costUSD: null, breakdownTruncated: true})],
    0,
  );
  const rows = usageBreakdownRows(report).join('\n');
  expect(rows).toContain('Source attribution incomplete');
  expect(rows).toContain('do not add sections together');
});

function limits(extra: Partial<AccountLimits> = {}): AccountLimits {
  return {
    accountId: accountA,
    providerId: 'provider-a',
    providerName: 'Provider A',
    alias: 'work',
    source: 'last-turn',
    observedAt: '2026-11-22T00:00:00Z',
    items: [],
    ...extra,
  };
}
test('quota rows distinguish rate windows, subscription allowances, credits and unsupported lookup', () => {
  expect(
    limitItemText({label: 'requests', kind: 'rate-limit', unit: '%', usedPercent: 25, resetAt: '2026-11-22T01:00:00Z'}),
  ).toContain('Rate limit');
  expect(limitItemText({label: '5h', kind: 'subscription-quota', unit: '%', usedPercent: 25})).toContain(
    'Subscription quota',
  );
  expect(
    limitItemText({label: 'balance', kind: 'api-credits', unit: 'USD', used: 1, limit: null, unlimited: true}),
  ).toContain('API credits');
  expect(limitItemText({label: 'legacy', unit: '%'})).toContain('Unclassified quota');
  const rows = limitRows([limits({status: 'unsupported', source: 'unavailable'})]).join('\n');
  expect(rows).toContain('unsupported');
  expect(rows).not.toContain('Unlimited');
  expect(rows).not.toContain('Subscription');
  expect(limitSnapshotText(limits({stale: true}), Date.parse('2026-11-22T00:30:00Z'))).toContain('30m old · STALE');
});

test('usage meters retain provider/account identity and snapshot metadata', () => {
  const account = limits({stale: true, items: [{label: 'requests', kind: 'rate-limit', unit: '%', usedPercent: 25}]});
  const meters = usageMeters({limits: () => [account]} as FutrynClient);
  expect(meters[0]?.label).toContain('Provider A / work · Rate limit');
  expect(meters[0]?.reset).toContain('source last-turn');
  expect(meters[0]?.reset).toContain('STALE');
});

test('missing usage and partial source counters keep coverage explicitly incomplete', () => {
  const first = source('provider-a', accountA, 10);
  const second = source('provider-a', accountA, 0, {inputTokens: null});
  const report = summarizeUsage(
    [receipt({inputTokens: null, outputTokens: 4, costUSD: null, breakdown: [first, second]}), receipt(null)],
    0,
  );
  expect(report.unknownSourceTurns).toBe(1);
  expect(report.byModel[0]).toMatchObject({inputTokens: 10, unknownInputSources: 1, costUSD: null});
  expect(usageBreakdownRows(report).join('\n')).toContain('in 10 (incomplete)');
});

test('summary does not infer subscription billing or plan quota from OAuth', () => {
  const usage = summarizeUsage([receipt({inputTokens: 1, outputTokens: 1, costUSD: null})], 0);
  const client = {
    status: () => ({activeProvider: {auth: 'oauth'}}),
    usage: () => usage,
    context: () => ({}),
    projectContext: () => null,
    toolsEnabled: () => false,
    limits: () => [limits({status: 'unsupported', source: 'unavailable'})],
  } as unknown as FutrynClient;
  const rows = reportRows(client, 'usage').join('\n');
  expect(rows).toContain('Unknown / not reported');
  expect(rows).toContain('unsupported');
  expect(rows).toContain('Unknown model');
  expect(rows).not.toContain('Plan usage');
  expect(rows).not.toContain('Billing         Subscription');
  expect(rows).not.toContain('Unlimited');
});

test('mixed snapshots display each item observation and source without making older data look fresh', () => {
  const old = '2026-11-21T00:00:00Z';
  const fresh = '2026-11-22T00:30:00Z';
  const account = limits({
    source: 'mixed',
    observedAt: fresh,
    items: [
      {label: 'credit', kind: 'api-credits', unit: 'USD', used: 1, observedAt: old, source: 'live'},
      {label: 'tokens', kind: 'rate-limit', unit: '%', usedPercent: 50, observedAt: fresh, source: 'last-turn'},
    ],
  });
  const rows = limitRows([account]);
  expect(rows.find(row => row.startsWith('API credits'))).toContain(`source live · observed ${old}`);
  expect(rows.find(row => row.startsWith('Rate limit'))).toContain(`source last-turn · observed ${fresh}`);
  const meter = usageMeters({limits: () => [account]} as FutrynClient)[0]!;
  expect(meter.reset).toContain(`source last-turn · observed ${fresh}`);
});

test('subscription windows show their provider-reported duration', () => {
  expect(limitItemText({label: 'Codex primary', kind: 'subscription-quota', windowMinutes: 300})).toContain(
    '5h window',
  );
  expect(limitItemText({label: 'Codex secondary', kind: 'subscription-quota', windowMinutes: 10080})).toContain(
    '7d window',
  );
});
