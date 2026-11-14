import { z } from 'zod';
import type { Selection } from './models';
export const contextMeasurementSchema = z.strictObject({
  usedTokens: z.number().int().nonnegative().nullable(), limitTokens: z.number().int().positive().nullable(),
  source: z.enum(['provider', 'runtime', 'estimate']), measuredAt: z.string().datetime(),
});
export type ContextMeasurement = z.infer<typeof contextMeasurementSchema>;
export const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
  costUSD: z.number().nonnegative().finite().nullable(), costEstimated: z.boolean().optional(),
  cacheReadTokens: z.number().int().nonnegative().nullable().optional(), cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningTokens: z.number().int().nonnegative().nullable().optional(), premiumRequests: z.number().nonnegative().finite().nullable().optional(),
  quota: z.array(z.strictObject({
    name: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_ .:/-]+$/), usedPercent: z.number().nonnegative().finite().nullable(),
    resetAt: z.string().datetime().nullable(), observedAt: z.string().datetime(), unlimited: z.boolean().optional(),
  })).max(20).optional(),
  pricingSource: z.string().max(2048).nullable().optional(), pricingAt: z.string().datetime().nullable().optional(),
});
export const turnReceiptSchema = z.strictObject({
  requestId: z.string().uuid(), accountId: z.string().uuid(), modelId: z.string().min(1).max(300),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  outcome: z.enum(['pending', 'completed', 'cancelled', 'failed', 'interrupted']),
  usage: usageSchema.nullable(), context: contextMeasurementSchema.nullable(),
});
export type TurnReceipt = z.infer<typeof turnReceiptSchema>;
export interface SessionUsage { selection: Selection; turns: TurnReceipt[]; historicalTurns: number }
