import type { TurnReceipt, Usage } from '@hannes/contracts';
export function summarizeUsage(turns: TurnReceipt[], historicalTurns: number) {
  const known = (field: keyof Usage, subset = turns): number | null => {
    const values = subset.map(t => t.usage?.[field]).filter((n): n is number => typeof n === 'number');
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const reportedTurns = turns.filter(t => t.usage?.inputTokens != null && t.usage.outputTokens != null).length;
  return {
    last: turns.at(-1) ?? null, turns: turns.length, historicalTurns, reportedTurns,
    pricedTurns: turns.filter(t => t.usage?.costUSD != null).length,
    unknownTurns: turns.length - reportedTurns + historicalTurns,
    inputTokens: known('inputTokens'), outputTokens: known('outputTokens'), costUSD: known('costUSD'), premiumRequests: known('premiumRequests'),
    estimatedCost: turns.some(t => t.usage?.costEstimated),
    byModel: [...new Set(turns.map(t => t.modelId))].map(modelId => {
      const subset = turns.filter(t => t.modelId === modelId);
      return { modelId, turns: subset.length, inputTokens: known('inputTokens', subset), outputTokens: known('outputTokens', subset), costUSD: known('costUSD', subset) };
    }),
  };
}
