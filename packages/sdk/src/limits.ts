import type { Usage } from '@hannes/contracts';

/** One limit shown to the user. Percent-based (subscription plans) or amount-based (API credit). */
export interface LimitItem {
  label: string;
  usedPercent?: number | null;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  unit?: 'USD' | '%';
  resetAt?: string | null;
  unlimited?: boolean;
}

/**
 * Limits for one connected account.
 *  - live:        fetched from the provider's API just now
 *  - last-turn:   the plan snapshot the subscription runtime reported with its latest reply
 *  - unavailable: this provider exposes no balance or quota API to Hannes
 */
export interface AccountLimits {
  accountId: string;
  alias: string;
  providerId: string;
  providerName: string;
  source: 'live' | 'last-turn' | 'unavailable';
  observedAt: string | null;
  items: LimitItem[];
  note?: string;
  /** Redacted error code when a live fetch failed. */
  error?: string;
  /** A live fetch for this account is in flight. */
  checking?: boolean;
}

/**
 * Live limits a composition root can fetch. Returns null synchronously when the provider has no
 * such API, so the UI can say so at once instead of showing a pending check.
 */
export type FetchAccountLimits = (account: import('@hannes/contracts').Account, signal?: AbortSignal) =>
  Promise<{ items: LimitItem[]; note?: string }> | null;

/** Convert a runtime quota snapshot (subscription plans) into display items. */
export function quotaItems(quota: NonNullable<Usage['quota']>): LimitItem[] {
  return quota.map(q => ({ label: q.name, usedPercent: q.usedPercent, resetAt: q.resetAt, unlimited: q.unlimited ?? false, unit: '%' as const }));
}
