import {z} from 'zod';
import type {Selection} from './models';
export const contextMeasurementSchema = z.strictObject({
  usedTokens: z.number().int().nonnegative().nullable(),
  limitTokens: z.number().int().positive().nullable(),
  source: z.enum(['provider', 'runtime', 'estimate']),
  measuredAt: z.string().datetime(),
});
export type ContextMeasurement = z.infer<typeof contextMeasurementSchema>;
export const CONTEXT_COMPACTION_FRACTION = 0.85;
/** Local estimate of a single prepared model request, with its effective window. */
export const requestContextSchema = z.strictObject({
  estimateTokens: z.number().int().nonnegative(),
  limitTokens: z.number().int().positive(),
  outputReserve: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
});
export type RequestContext = z.infer<typeof requestContextSchema>;
/** A source-owned snapshot; rate limits are distinct from subscription allowance and credits. */
export const usageQuotaSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_ .:/-]+$/),
  usedPercent: z.number().nonnegative().finite().nullable(),
  resetAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
  unlimited: z.boolean().optional(),
  kind: z.enum(['rate-limit', 'subscription-quota', 'api-credits']).optional(),
  windowMinutes: z.number().int().positive().optional(),
});
export type UsageQuota = z.infer<typeof usageQuotaSchema>;
const usageCounters = {
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUSD: z.number().nonnegative().finite().nullable(),
  costEstimated: z.boolean().optional(),
  cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
  cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningTokens: z.number().int().nonnegative().nullable().optional(),
  premiumRequests: z.number().nonnegative().finite().nullable().optional(),
  quota: z.array(usageQuotaSchema).max(20).optional(),
  pricingSource: z.string().max(2048).nullable().optional(),
  pricingAt: z.string().datetime().nullable().optional(),
};
export const usageSourceSchema = z.strictObject({
  accountId: z.string().uuid().optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(300).optional(),
  agentId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
});
export type UsageSource = z.infer<typeof usageSourceSchema>;
/** Flat, exclusive source buckets. Missing identity means unknown, never the current selection. */
export const usageBreakdownSchema = z.strictObject({...usageSourceSchema.shape, ...usageCounters});
export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;
export const MAX_USAGE_BREAKDOWN = 4096;
export const usageSchema = z.strictObject({
  ...usageCounters,
  breakdown: z.array(usageBreakdownSchema).max(MAX_USAGE_BREAKDOWN).optional(),
  /** Counters are complete, but overflow source buckets were coalesced into unknown provenance. */
  breakdownTruncated: z.boolean().optional(),
});
/**
 * Why a turn stopped (ADR 0030). `completed`: the model ended with no tool request. `budget_*`: a
 * user-configured work budget ran out and the model gave a final answer without tools.
 * `context_window`: safe compaction could not sufficiently reduce context; tools were withdrawn or the limit was reported.
 * `safety_limit`: an internal safety bound (e.g. a runaway external bridge loop) ended the turn.
 */
export const turnStopReasonSchema = z.enum([
  'completed',
  'cancelled',
  'failed',
  'budget_steps',
  'budget_tool_calls',
  'budget_tokens',
  'budget_time',
  'budget_cost',
  'context_window',
  'safety_limit',
  'stalled',
]);
export type TurnStopReason = z.infer<typeof turnStopReasonSchema>;
export const turnReceiptSchema = z.strictObject({
  kind: z.enum(['agent', 'user-shell']).optional(),
  requestId: z.string().uuid(),
  accountId: z.string().uuid(),
  modelId: z.string().min(1).max(300),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  outcome: z.enum(['pending', 'completed', 'cancelled', 'failed', 'interrupted']),
  usage: usageSchema.nullable(),
  context: contextMeasurementSchema.nullable(),
  stopReason: turnStopReasonSchema.optional(),
  errorCode: z
    .string()
    .max(64)
    .regex(/^[A-Z_]+$/)
    .optional(),
});
/**
 * Optional user-configured work budget for one turn (ADR 0030). Absent fields mean no limit: Cosmew
 * has no hidden per-turn round or call ceiling. Internal safety bounds are separate and named.
 */
export const turnBudgetSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(100000).optional(),
  maxToolCalls: z.number().int().min(1).max(100000).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000_000).optional(),
  maxDurationMs: z.number().int().min(1000).max(86_400_000).optional(),
  maxCostUSD: z.number().positive().max(1000).optional(),
});
export type TurnBudget = z.infer<typeof turnBudgetSchema>;
export type TurnReceipt = z.infer<typeof turnReceiptSchema>;
export interface SessionUsage {
  selection: Selection;
  turns: TurnReceipt[];
  historicalTurns: number;
}

const addCounter = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? null : a + b;
type UsageValue = z.infer<typeof usageSchema>;
const countersOnly = (value: UsageValue): UsageBreakdown => {
  const {breakdown: _breakdown, breakdownTruncated: _truncated, ...counters} = value;
  return counters;
};
const latestQuota = (previous: UsageQuota[] | undefined, next: UsageQuota[] | undefined) => {
  if (!previous) return next;
  if (!next) return previous;
  const snapshots = new Map<string, UsageQuota>();
  for (const snapshot of [...previous, ...next]) {
    const key = JSON.stringify([snapshot.name, snapshot.kind, snapshot.windowMinutes]);
    const existing = snapshots.get(key);
    if (!existing || Date.parse(snapshot.observedAt) >= Date.parse(existing.observedAt)) snapshots.set(key, snapshot);
  }
  return [...snapshots.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, 20);
};
const sumCounters = (previous: UsageBreakdown, next: UsageBreakdown): UsageBreakdown => ({
  ...next,
  ...(previous.quota || next.quota ? {quota: latestQuota(previous.quota, next.quota)} : {}),
  ...(next.pricingSource === undefined && previous.pricingSource !== undefined
    ? {pricingSource: previous.pricingSource}
    : {}),
  ...(next.pricingAt === undefined && previous.pricingAt !== undefined ? {pricingAt: previous.pricingAt} : {}),
  inputTokens: addCounter(previous.inputTokens, next.inputTokens),
  outputTokens: addCounter(previous.outputTokens, next.outputTokens),
  costUSD: addCounter(previous.costUSD, next.costUSD),
  costEstimated: Boolean(previous.costEstimated || next.costEstimated),
  cacheReadTokens: addCounter(previous.cacheReadTokens, next.cacheReadTokens),
  cacheWriteTokens: addCounter(previous.cacheWriteTokens, next.cacheWriteTokens),
  reasoningTokens: addCounter(previous.reasoningTokens, next.reasoningTokens),
  premiumRequests: addCounter(previous.premiumRequests, next.premiumRequests),
});
const sourceKey = (source: UsageBreakdown) =>
  JSON.stringify([
    source.accountId,
    source.providerId,
    source.modelId,
    source.agentId,
    source.sessionId,
    source.costUSD == null ? 'unknown' : source.costEstimated ? 'estimated' : 'reported',
  ]);

/** Bind only at a known execution boundary. Existing descendant source identities are retained. */
export function attributeUsage(value: UsageValue, source: UsageSource): UsageValue {
  const buckets = value.breakdown ?? [countersOnly(value)];
  return {...value, breakdown: buckets.map(bucket => ({...source, ...bucket}))};
}

/** Request counters add; usage/completed snapshots of the same response must replace, not add. */
export function combineUsage(previous: UsageValue | null, next: UsageValue): UsageValue {
  if (!previous) return next;
  const total: UsageValue = sumCounters(previous, next);
  // Preserve legacy records as explicitly unknown when they meet attributed usage.
  if (!previous.breakdown && !next.breakdown) return total;
  const buckets = new Map<string, UsageBreakdown>();
  for (const bucket of [
    ...(previous.breakdown ?? [countersOnly(previous)]),
    ...(next.breakdown ?? [countersOnly(next)]),
  ]) {
    const key = sourceKey(bucket);
    const existing = buckets.get(key);
    buckets.set(key, existing ? sumCounters(existing, bucket) : bucket);
  }
  let breakdown = [...buckets.values()];
  let truncated = previous.breakdownTruncated || next.breakdownTruncated;
  if (breakdown.length > MAX_USAGE_BREAKDOWN) {
    const overflow = breakdown.slice(MAX_USAGE_BREAKDOWN - 1);
    const unknown = overflow.reduce((sum, bucket) => sumCounters(sum, bucket));
    const {
      accountId: _account,
      providerId: _provider,
      modelId: _model,
      agentId: _agent,
      sessionId: _session,
      quota: _quota,
      pricingAt: _at,
      pricingSource: _pricing,
      ...counters
    } = unknown;
    breakdown = [...breakdown.slice(0, MAX_USAGE_BREAKDOWN - 1), counters];
    truncated = true;
  }
  // Quota/pricing on a multi-source aggregate would mislabel a child's snapshot as its parent's.
  if (buckets.size > 1) {
    delete total.quota;
    delete total.pricingAt;
    delete total.pricingSource;
  }
  return {...total, breakdown, ...(truncated ? {breakdownTruncated: true} : {})};
}
