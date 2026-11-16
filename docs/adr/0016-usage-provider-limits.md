# ADR 0016: Provider limits in /usage

Accepted 2026-11-15 at the user's request. Additive SDK API; no contract schema, storage or dependency change.

## Decision

`/usage` gains a **LIMITS BY PROVIDER** section (also `/switch` is public again, see the ADR 0013 amendment) listing every connected (not signed-out) account, shown even before the first message. Only provider-reported numbers are displayed; nothing is estimated locally and a missing value is never shown as zero.

| Source | Accounts | Data |
|---|---|---|
| `live` | OpenRouter at `https://openrouter.ai/api/v1` | `GET /key` → `usage`, `limit`, `limit_remaining`, `is_free_tier` (USD credit). `limit: null` is shown as "no spending cap". |
| `last-turn` | Subscription runtimes that attach a plan snapshot to replies (Codex `rateLimits`, Copilot `quotaSnapshots`) | The latest `usage.quota` stored for that account, across its saved sessions. It survives starting a new chat. |
| `last-turn` | API-key providers whose replies carry rate-limit headers: OpenAI-style `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`, Anthropic `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` | Read from the chat response itself (no extra request) and stored as the turn's `usage.quota`: percent used and reset time. Inconsistent or missing values are skipped. |
| `unavailable` | Providers with neither (e.g. Gemini, many gateways and local endpoints), or before the first reply | "not reported by provider". These APIs have no balance endpoint Hannes can call with an inference key. |

SDK 1.6 (additive): `FutrynClient.limits()` (synchronous, sends nothing), `FutrynClient.refreshLimits(signal?)` (shares one in-flight refresh), and the optional port `fetchAccountLimits(account, signal)`. That port returns `null` **synchronously** when the provider has no limit API, so the UI never shows a pending check for it. `@futryn/models` adds `parseOpenRouterKeyLimits`, which rejects malformed bodies with `PROTOCOL`.

The TUI refreshes on opening `/usage`. `R` refreshes again, and closing the dialog aborts the refresh. Failures show the redacted error code (`check failed (AUTH)`).

## Evidence and limits

Covered by fixture tests: parser cases, including malformed bodies; row formatting; no request sent for providers without an API; Codex/Copilot plan snapshots attributed to the account after a new chat. Live OpenRouter `/key` behavior and field semantics follow the public API reference and are **Needs verification** against a real key. Rate-limit headers are parsed in `parseRateLimitHeaders` (`@futryn/models`) and attached by `ProviderAdapter` on stream finish. Fixture tests cover both header families end to end; window length is not inferred, and live header presence varies by provider and gateway (Needs verification). A rate limit is not a spending balance.
