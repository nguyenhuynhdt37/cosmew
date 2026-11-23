import type {TurnReceipt, Usage, UsageBreakdown} from '@cosmew/contracts';

/** Source totals are a partition of usage, never additions to receipt totals. */
export function summarizeUsage(receipts: TurnReceipt[], historicalTurns: number, additionalUsage?: Usage) {
  const turns = receipts.filter(turn => turn.kind !== 'user-shell');
  const sum = (values: (number | null | undefined)[]): number | null => {
    const known = values.filter((n): n is number => typeof n === 'number');
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  const usages = [...turns.map(t => t.usage), ...(additionalUsage ? [additionalUsage] : [])];
  const known = (field: keyof Usage) => sum(usages.map(usage => usage?.[field] as number | null | undefined));
  const sources = usages.flatMap((usage, index) =>
    (usage?.breakdown?.length ? usage.breakdown : usage ? [unknownSource(usage)] : []).map(source => ({
      source,
      turnIndex: index < turns.length ? index : null,
    })),
  );
  const group = <K extends 'providerId' | 'accountId' | 'modelId' | 'agentId' | 'sessionId'>(fields: K[]) => {
    const groups = new Map<string, typeof sources>();
    for (const entry of sources) {
      const key = JSON.stringify(fields.map(field => entry.source[field] ?? null));
      const entries = groups.get(key) ?? [];
      entries.push(entry);
      groups.set(key, entries);
    }
    return [...groups.values()].map(entries => {
      const identity = Object.fromEntries(fields.map(field => [field, entries[0]!.source[field] ?? null])) as Record<
        K,
        string | null
      >;
      return {
        ...identity,
        turns: new Set(entries.filter(entry => entry.turnIndex !== null).map(entry => entry.turnIndex)).size,
        sources: entries.length,
        inputTokens: sum(entries.map(entry => entry.source.inputTokens)),
        outputTokens: sum(entries.map(entry => entry.source.outputTokens)),
        costUSD: sum(entries.map(entry => entry.source.costUSD)),
        estimatedCostUSD: sum(
          entries.filter(entry => entry.source.costEstimated === true).map(entry => entry.source.costUSD),
        ),
        reportedCostUSD: sum(
          entries.filter(entry => entry.source.costEstimated !== true).map(entry => entry.source.costUSD),
        ),
        unknownInputSources: entries.filter(entry => entry.source.inputTokens == null).length,
        unknownOutputSources: entries.filter(entry => entry.source.outputTokens == null).length,
        unknownCostSources: entries.filter(entry => entry.source.costUSD == null).length,
      };
    });
  };
  const reportedTurns = turns.filter(t => t.usage?.inputTokens != null && t.usage.outputTokens != null).length;
  return {
    last: turns.at(-1) ?? null,
    turns: turns.length,
    historicalTurns,
    reportedTurns,
    pricedTurns: turns.filter(t => t.usage?.costUSD != null).length,
    unknownTurns: turns.length - reportedTurns + historicalTurns,
    inputTokens: known('inputTokens'),
    outputTokens: known('outputTokens'),
    costUSD: known('costUSD'),
    premiumRequests: known('premiumRequests'),
    estimatedCost: usages.some(usage => usage?.costEstimated),
    estimatedCostUSD: sum(
      sources.filter(entry => entry.source.costEstimated === true).map(entry => entry.source.costUSD),
    ),
    reportedCostUSD: sum(
      sources.filter(entry => entry.source.costEstimated !== true).map(entry => entry.source.costUSD),
    ),
    breakdownTruncated: usages.some(usage => usage?.breakdownTruncated),
    unknownCostSources: sources.filter(entry => entry.source.costUSD == null).length,
    unknownSourceTurns: turns.filter(
      turn =>
        !turn.usage?.breakdown?.length ||
        turn.usage.breakdown.some(source => !source.providerId || !source.accountId || !source.modelId),
    ).length,
    byProvider: group(['providerId']),
    byAccount: group(['providerId', 'accountId']),
    byModel: group(['providerId', 'accountId', 'modelId']),
    byAgent: group(['sessionId', 'agentId', 'providerId', 'accountId', 'modelId']),
  };
}

function unknownSource(usage: Usage): UsageBreakdown {
  // Receipt selection cannot identify the sources of legacy aggregate child usage.
  const {breakdown: _breakdown, breakdownTruncated: _truncated, ...source} = usage;
  return source;
}
