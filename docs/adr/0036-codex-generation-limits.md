# ADR 0036 — Generation limits at or above Codex

Accepted 2026-11-16 at the user's request ("fix triệt để toàn bộ tham số ngang hoặc hơn cả Codex"), after a real `grok-4.7` turn failed with `TIMEOUT` while streaming a whole HTML file (ADR 0033, "Provider timeout is an idle timeout").

## Upstream reference
openai/codex `75fc67e8f4284a669eebd90ab6bc9ef7697e876e`, `codex-rs/model-provider-info/src/lib.rs` (accessed 2026-11-16): `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`, `DEFAULT_STREAM_MAX_RETRIES = 5`, `DEFAULT_REQUEST_MAX_RETRIES = 4`; backoff from `codex_async_utils::backoff` (200 ms × 2ⁿ⁻¹, jitter). Codex sends no `max_output_tokens` and has no byte ceiling on response text or tool-call arguments. Evidence limit: only those files were read; the request-retry path was not compared line by line.

## Decision
All limits live in one place, `GENERATION_LIMITS` (`packages/contracts/src/limits.ts`), and every layer (contracts, models, core, tools, CLI runtimes, TUI) reads it.

| Parameter | Before | Codex | Now |
|---|---|---|---|
| Model stream timeout | whole request, 60 s (direct APIs) / whole turn 300 s (subscriptions) | 300 s idle | 300 s idle (`Provider.streamIdleTimeoutMs`, default); paused while Futryn handles approvals/tools |
| Stream retries / backoff | 2, 250 ms × 2ⁿ | 5, 200 ms × 2ⁿ | 5, 200 ms × 2ⁿ |
| Output tokens when not given | 4096 | none sent (model limit) | the model's output limit, else 32 768; at most half the context window |
| Output tokens accepted | ≤ 32 768 | — | ≤ 262 144 |
| Text per response / message | 256 KiB | none | 4 MiB |
| Arguments of one tool call | 64 KiB | none | 4 MiB |
| Tool calls per response | 32 | none | 128 |
| Patch / approval diff | 64 KiB / 50 KiB | none | 4 MiB / 4 MiB (TUI renders the whole diff) |
| Streamed HTTP body, runtime frame | 4 MiB | none | 64 MiB |
| One serialized model request | 1 MiB | none (context window) | 64 MiB (context window still applies first) |

The byte ceilings remain because a broken provider must not exhaust memory; each is sized well above what a real response produces. Metadata requests (catalog, `doctor`) keep `Provider.timeoutMs` as a whole-request timeout.

## Contract 1.17
- New `GENERATION_LIMITS` export.
- `Provider.streamIdleTimeoutMs?` (optional; existing stored providers get the 300 s default without migration).
- `ModelRequest.maxOutputTokens` maximum 262 144 (default 32 768); `Message.content` ≤ 4 MiB; `Message.toolCalls` ≤ 128; `PermissionRequest.diffPreview` ≤ 4 MiB; journal `assistant.text` ≤ 4 MiB.
- `Conversation.send(…, maxOutputTokens?)` and `TurnRequest.maxOutputTokens?` are optional; `--max-output-tokens` is optional on the CLI.
All changes widen accepted values; data written by 1.16 still parses. No SQLite schema change.

## Evidence
- `tests/security/provider-failures.test.ts`: idle timeout (long slow stream completes, silence fails) and a > 256 KiB tool call; both fail on the previous code.
- `tests/security/apply-patch.test.ts`: > 256 KiB Add File patch parses; above the limit is refused.
- `tests/contracts/agent-continuation.test.ts`: default output tokens (model limit, 32 768, half of a small window); retry backoff 200/400 ms.
- Window-arithmetic tests pin `maxOutputTokens = 4096` explicitly; e2e retry tests allow 30 s for 5 retries.
- Fixture models only; no live provider run after this change.

## Remaining differences
- Codex also retries the initial HTTP request separately (`request_max_retries = 4`); Futryn counts both under the 5 stream retries.
- Tool *results* sent back to the model stay bounded (64 KiB content), like Codex's output truncation policy.
- Reserving the output budget still shrinks the input window (Codex reserves none).
