import type { Usage } from '@futryn/contracts';

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'] as const;

/** One fresh ephemeral thread per ModelPort request. Snapshots replace; they never add. */
export class CodexUsageTracker {
  private watermark = -1;
  private readonly observed = new Map<string, number>();

  observe(data: any): {usage: Usage; usedTokens: number | null; limitTokens: number | null} | null {
    const total = data?.total;
    const cumulative = count(total?.totalTokens);
    // There is no notification sequence number. Equal/conflicting and older snapshots cannot
    // revise already selected measurements. Partial newer snapshots retain unknown fields.
    if (cumulative === null || cumulative <= this.watermark) return null;
    const values = {
      inputTokens: count(total?.inputTokens), outputTokens: count(total?.outputTokens),
      cachedInputTokens: count(total?.cachedInputTokens), cacheWriteInputTokens: count(total?.cacheWriteInputTokens),
      reasoningOutputTokens: count(total?.reasoningOutputTokens),
    };
    // Invalid subset measurements must not poison the regression guard for later valid data.
    for (const [subset, parent] of [['cachedInputTokens','inputTokens'],['cacheWriteInputTokens','inputTokens'],['reasoningOutputTokens','outputTokens']] as const) {
      if (values[subset] != null && values[parent] != null && values[subset]! > values[parent]!) values[subset] = null;
    }
    if (fields.some(field => values[field] !== null && values[field]! < (this.observed.get(field) ?? 0))) return null;
    this.watermark = cumulative;
    fields.forEach(field => {if (values[field] !== null) this.observed.set(field, values[field]!);});
    return {
      usage: {inputTokens: values.inputTokens, outputTokens: values.outputTokens, costUSD: null,
        cacheReadTokens: values.cachedInputTokens, cacheWriteTokens: values.cacheWriteInputTokens,
        reasoningTokens: values.reasoningOutputTokens},
      usedTokens: count(data?.last?.totalTokens),
      limitTokens: count(data?.modelContextWindow) || null,
    };
  }
}
