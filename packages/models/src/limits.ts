import {FutrynError, type Usage} from '@cosmew/contracts';

/** One spending or quota limit as reported by a provider API (never estimated locally). */
export interface ProviderLimitItem {
  label: string;
  /** Amount consumed, in `unit`. */
  used: number | null;
  /** Cap, in `unit`; null when the provider reports no cap. */
  limit: number | null;
  remaining: number | null;
  unit: 'USD';
  unlimited: boolean;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * OpenRouter `GET /api/v1/key`: `{ data: { usage, limit, limit_remaining, is_free_tier } }`.
 * `usage` and `limit` are credits in USD; `limit: null` means the key has no spending cap.
 * Field meanings follow OpenRouter's public API reference (live behavior: Needs verification).
 */
export function parseOpenRouterKeyLimits(body: unknown): {items: ProviderLimitItem[]; freeTier: boolean} {
  const data = body && typeof body === 'object' && 'data' in body ? (body as {data: unknown}).data : null;
  if (!data || typeof data !== 'object') throw new FutrynError('PROTOCOL');
  const raw = data as Record<string, unknown>;
  const used = num(raw.usage);
  const limit = num(raw.limit);
  if (raw.usage !== undefined && used === null) throw new FutrynError('PROTOCOL');
  if (raw.limit !== null && raw.limit !== undefined && limit === null) throw new FutrynError('PROTOCOL');
  const remaining = num(raw.limit_remaining) ?? (limit !== null && used !== null ? Math.max(0, limit - used) : null);
  return {
    items: [
      {
        label: 'Key credit',
        used,
        limit,
        remaining: limit === null ? null : remaining,
        unit: 'USD',
        unlimited: limit === null,
      },
    ],
    freeTier: raw.is_free_tier === true,
  };
}

type Quota = NonNullable<Usage['quota']>;

/** OpenAI reset values are Go-style durations such as `20ms`, `1s`, `6m0s`, `1h2m3.5s`. */
export function parseDurationMs(value: string): number | null {
  const parts = [...value.trim().matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length || parts.map(p => p[0]).join('') !== value.trim()) return null;
  const unit: Record<string, number> = {ms: 1, s: 1000, m: 60000, h: 3600000};
  return parts.reduce((total, p) => total + Number(p[1]) * unit[p[2]!]!, 0);
}

/**
 * Rate-limit headers that OpenAI-style (`x-ratelimit-{limit,remaining,reset}-{requests,tokens}`) and
 * Anthropic (`anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`)
 * APIs attach to responses, as quota entries. Missing or inconsistent headers are skipped, never guessed.
 */
export function parseRateLimitHeaders(headers: Headers, now = new Date()): Quota {
  const quota: Quota = [];
  const observedAt = now.toISOString();
  const add = (name: string, limitRaw: string | null, remainingRaw: string | null, reset: string | null) => {
    const limit = Number(limitRaw);
    const remaining = Number(remainingRaw);
    if (
      limitRaw === null ||
      remainingRaw === null ||
      !Number.isFinite(limit) ||
      !Number.isFinite(remaining) ||
      limit <= 0 ||
      remaining < 0 ||
      remaining > limit
    )
      return;
    quota.push({name, usedPercent: Math.round(((limit - remaining) / limit) * 1000) / 10, resetAt: reset, observedAt});
  };
  for (const kind of ['requests', 'tokens']) {
    const reset = headers.get(`x-ratelimit-reset-${kind}`);
    const ms = reset === null ? null : parseDurationMs(reset);
    add(
      kind,
      headers.get(`x-ratelimit-limit-${kind}`),
      headers.get(`x-ratelimit-remaining-${kind}`),
      ms === null ? null : new Date(now.getTime() + ms).toISOString(),
    );
  }
  for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    const reset = headers.get(`anthropic-ratelimit-${kind}-reset`);
    const at = reset === null ? null : new Date(reset);
    add(
      kind,
      headers.get(`anthropic-ratelimit-${kind}-limit`),
      headers.get(`anthropic-ratelimit-${kind}-remaining`),
      at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
    );
  }
  return quota;
}
