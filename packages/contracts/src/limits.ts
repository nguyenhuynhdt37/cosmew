/**
 * Generation limits, at or above Codex (openai/codex `75fc67e8`, ADR 0036). Codex bounds a response
 * only by the model's output tokens and a stream idle timeout; these byte ceilings exist so a broken
 * provider cannot exhaust memory, and are sized so a real response never reaches them.
 */
export const GENERATION_LIMITS = {
  /** Codex DEFAULT_STREAM_IDLE_TIMEOUT_MS: silence allowed while waiting for or reading a response. */
  streamIdleTimeoutMs: 300_000,
  /** Codex DEFAULT_STREAM_MAX_RETRIES: a dropped stream is retried this many times. */
  streamMaxRetries: 5,
  /** Output tokens requested when the model's own limit is unknown (Codex sends none at all). */
  defaultOutputTokens: 32_768,
  /** Highest output-token request accepted (above every current model's output limit). */
  maxOutputTokens: 262_144,
  /** Text (answer + reasoning) of one response and of one stored message. */
  textBytes: 4 * 1024 * 1024,
  /** Arguments of one tool call, e.g. a patch that writes a whole file. */
  toolArgumentBytes: 4 * 1024 * 1024,
  /** Tool calls in one response. */
  toolCallsPerResponse: 128,
  /** One serialized model request (history is bounded first by the context window). */
  requestBytes: 64 * 1024 * 1024,
  /** Raw bytes of one streamed HTTP response or runtime frame. */
  responseBytes: 64 * 1024 * 1024,
  /** A patch and the complete diff shown for its approval. */
  patchBytes: 4 * 1024 * 1024,
} as const;
