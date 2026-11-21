/**
 * Model-stream defaults ported from Codex (openai/codex `75fc67e8`, `model-provider-info/src/lib.rs`,
 * `codex-client/src/retry.rs`, `async-utils/src/backoff.rs`; ADR 0036). Like Codex, Cosmew puts no
 * byte ceiling on a response, its text or its tool-call arguments, and sends no output-token cap
 * unless the user asks for one (Anthropic, whose API requires `max_tokens`, gets the model's limit).
 */
export const GENERATION_LIMITS = {
  /** DEFAULT_STREAM_IDLE_TIMEOUT_MS: silence allowed while waiting for or reading a response. */
  streamIdleTimeoutMs: 300_000,
  /** DEFAULT_STREAM_MAX_RETRIES: a dropped or failed stream is re-sampled this many times. */
  streamMaxRetries: 5,
  /** DEFAULT_REQUEST_MAX_RETRIES: an HTTP request failing with 5xx or a transport error, before streaming. */
  requestMaxRetries: 4,
  /** backoff(): 200 ms doubling per retry, with ±10% jitter. */
  retryBaseDelayMs: 200,
  /** `max_tokens` for Anthropic when the model's output limit is unknown (the API requires a value). */
  anthropicFallbackOutputTokens: 32_000,
} as const;

/** Codex backoff(attempt): attempts 0 and 1 wait the base delay, then it doubles; jitter 0.9–1.1. */
export function codexBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = GENERATION_LIMITS.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.floor(base * (0.9 + random() * 0.2));
}
