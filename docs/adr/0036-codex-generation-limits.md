# ADR 0036 — Generation limits at or above Codex

Accepted 2026-11-16 at the user's request ("fix triệt để toàn bộ tham số ngang hoặc hơn cả Codex"), after a real `grok-4.7` turn failed with `TIMEOUT` while streaming a whole HTML file (ADR 0033, "Provider timeout is an idle timeout").

## Upstream reference
openai/codex `75fc67e8f4284a669eebd90ab6bc9ef7697e876e`, `codex-rs/model-provider-info/src/lib.rs` (accessed 2026-11-16): `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`, `DEFAULT_STREAM_MAX_RETRIES = 5`, `DEFAULT_REQUEST_MAX_RETRIES = 4`; backoff from `codex_async_utils::backoff` (200 ms × 2ⁿ⁻¹, jitter). Codex sends no `max_output_tokens` and has no byte ceiling on response text or tool-call arguments. Evidence limit: only those files were read; the request-retry path was not compared line by line.

## Decision (revised 2026-11-17: follow Codex exactly)
The first version of this ADR raised Futryn's own ceilings; at the user's request ("ko fix theo codex đi") they were removed instead, so Futryn behaves as Codex does. `GENERATION_LIMITS` (`packages/contracts/src/limits.ts`) now holds only Codex's values, and `codexBackoffMs` ports `backoff()`.

| Parameter | Futryn before | Codex `75fc67e8` | Futryn now |
|---|---|---|---|
| Model stream timeout | whole request 60 s / whole subscription turn 300 s | `stream_idle_timeout_ms` 300 s | 300 s idle (`Provider.streamIdleTimeoutMs`), paused while Futryn handles approvals/tools |
| Request resend (before streaming) | none | `request_max_retries` 4, 5xx + transport, not 429 (`codex-client/src/retry.rs`) | 4, 5xx + transport, not 429 |
| Stream re-sample | 2 | `stream_max_retries` 5 | 5 (each may resend its request 4 times, as on Codex) |
| Backoff | 250 ms × 2ⁿ, cap 10 s | 200 ms × 2ⁿ⁻¹, ±10% jitter; server Retry-After wins | same as Codex |
| Retry notice | only when partial text was discarded | "Reconnecting... n/max" on every retry | "Reconnecting... n/5" in TUI and CLI |
| Output tokens | always sent, default 4096 | none sent | none sent; `--max-output-tokens` sends one (clamped to the model); Anthropic, whose API requires `max_tokens`, gets the model's output limit (32 000 if unknown) |
| Output reserved from the window | 4096 | none | none (only an explicit cap is reserved) |
| Text per response, tool-call arguments, calls per response, request size, streamed body, runtime frame | 256 KiB, 64 KiB, 32, 1 MiB, 4 MiB, 4 MiB | no ceiling | no ceiling |
| Patch / approval diff | 64 KiB / 50 KiB, 4 MiB aggregate | no ceiling | no ceiling; the TUI renders the whole diff |

Kept: duplicate tool-call ids in one response are still a protocol error; metadata requests (catalog, `doctor`) keep `Provider.timeoutMs`; tool *results* returned to the model stay bounded (64 KiB), like Codex's output truncation; file reads keep their own limits.

Risk accepted with the user's instruction: like Codex, a misbehaving provider or runtime can stream without a byte bound until the idle timeout, the context window or the user's cancel stops it.

## Contract 1.17
- `GENERATION_LIMITS`, `codexBackoffMs` exports; `Provider.streamIdleTimeoutMs?`.
- `ModelRequest.maxOutputTokens` optional with no default; `Message.content`, `Message.toolCalls`, `PermissionRequest.diffPreview` and journal `assistant.text` have no maximum.
- `responseDiscarded` gains `maxRetries?` and is emitted on every retry.
- `Conversation.send(…, maxOutputTokens?)`, `TurnRequest.maxOutputTokens?`, optional `--max-output-tokens`.
All changes widen accepted values; 1.16 data still parses. No SQLite schema change.

## Evidence
- `tests/security/provider-failures.test.ts`: idle timeout (slow long stream completes, silence fails) and a > 256 KiB tool call (fails on the code before this ADR).
- `tests/contracts/provider-adapters.test.ts`: 503 is resent 1 + 4 times, 401/403/404/429 are not.
- `tests/contracts/agent-continuation.test.ts`: no output cap sent unless asked; asked cap clamped; backoff 200/400 ms ±10%.
- `tests/contracts/usage-context.test.ts`: no `max_tokens` in the wire body by default; an explicit cap over the window is refused before sending.
- `tests/contracts/agent-loop-codex.test.ts` V: a 5 MiB answer completes; `tests/security/apply-patch.test.ts`: a > 256 KiB patch parses.
- `tests/end-to-end/hannes-agent-matrix.test.ts`: at most (1+4)×(1+5) requests on persistent 5xx.
- Fixture models only; no live provider run after this change.

## Remaining differences
- Codex's WebSocket transport, HTTP fallback and unbounded connection retries (feature flag) are not ported; Futryn uses HTTP SSE only.
- Codex auto-compacts near the window; Futryn withdraws tools at 85% and fails honestly past the window (ADR 0030).
