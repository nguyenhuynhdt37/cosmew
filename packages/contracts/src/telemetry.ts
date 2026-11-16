import {z} from 'zod';
import type {Selection} from './models';
export const contextMeasurementSchema = z.strictObject({
  usedTokens: z.number().int().nonnegative().nullable(),
  limitTokens: z.number().int().positive().nullable(),
  source: z.enum(['provider', 'runtime', 'estimate']),
  measuredAt: z.string().datetime(),
});
export type ContextMeasurement = z.infer<typeof contextMeasurementSchema>;
export const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUSD: z.number().nonnegative().finite().nullable(),
  costEstimated: z.boolean().optional(),
  cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
  cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningTokens: z.number().int().nonnegative().nullable().optional(),
  premiumRequests: z.number().nonnegative().finite().nullable().optional(),
  quota: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-zA-Z0-9_ .:/-]+$/),
        usedPercent: z.number().nonnegative().finite().nullable(),
        resetAt: z.string().datetime().nullable(),
        observedAt: z.string().datetime(),
        unlimited: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
  pricingSource: z.string().max(2048).nullable().optional(),
  pricingAt: z.string().datetime().nullable().optional(),
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
  requestId: z.string().uuid(),
  accountId: z.string().uuid(),
  modelId: z.string().min(1).max(300),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  outcome: z.enum(['pending', 'completed', 'cancelled', 'failed', 'interrupted']),
  usage: usageSchema.nullable(),
  context: contextMeasurementSchema.nullable(),
  stopReason: turnStopReasonSchema.optional(),
});
/**
 * Optional user-configured work budget for one turn (ADR 0030). Absent fields mean no limit: Futryn
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
