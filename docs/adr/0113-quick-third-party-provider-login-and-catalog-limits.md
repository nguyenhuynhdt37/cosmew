# ADR 0113: Quick Third-Party Provider Login and General Catalog Limit Parsing

- Date: 2026-11-22
- Status: Accepted
- Contract: 1.58 (no breaking change to `@cosmew/contracts`; optional SDK port `quickConnectProvider`)

## Context

Connecting a third-party gateway (such as 9Router, LiteLLM, NewAPI, vLLM, or any OpenAI-compatible proxy) previously had two major friction points:

1. **Multi-step manual setup:** Users had to step through 7–9 fields (`id`, `baseURL`, `protocol`, `auth`, `catalog`, `manual model`, `headers`, `method`, `api key`) in TUI `/connect` and CLI `loginWizard`.
2. **Dropped context/output metadata:** `packages/models/src/catalog.ts` only extracted `context_length`, `max_completion_tokens`, and `pricing` for `https://openrouter.ai/api/v1` (and `inputTokenLimit`/`outputTokenLimit` for `gemini`). Every other third-party gateway fell back to `contextLimit: null` (`SAFETY_LIMITS.unknownContextTokens` = 128k), even when `/v1/models` explicitly advertised 200k or 1M (`1,048,576`) context windows and `64k`/`65,536` output limits. This caused `/context`, the Context meter, and 85% auto-compaction to underestimate available capacity.

## Decision

1. **Generalize catalog metadata extraction (`packages/models/src/catalog.ts`):**
   - Extract `contextLimit` and `outputLimit` from explicit, documented provider catalog fields for _all_ providers (e.g., `context_length`, `context_window`, `max_context_length`, `input_token_limit`, `inputTokenLimit`, `max_input_tokens`, `capabilities.contextWindow`, `limits.context`, `top_provider.context_length`, and matching output fields). Model IDs are never guessed (preserving ADR 0078).
   - Extend advertised capability parsing to read `capabilities.thinkingCanDisable` (`reasoningOptions.toggle`) and `capabilities.thinkingRange.min` (`reasoningOptions.budgetMin`), plus general `pricing.{prompt,completion}` (per-token USD) and `pricing.{input,output}` (per-million USD).
   - Set `metadataSource = <baseURL>/models` and `metadataFetchedAt` whenever `/models` provides `contextLimit`, `outputLimit`, or `pricing`.
   - Preserve provider-reported metadata in `ModelCatalog.manual(id)` when pinning an existing catalog model and in `enrichModelsDev()` so advisory metadata only fills missing gaps.

2. **Add pure quick parser and endpoint auto-prober (`packages/models/src/custom-probe.ts`):**
   - `parseQuickProviderInput` accepts one-line `URL | API_KEY | MODEL`, `URL | API_KEY`, or `URL`, enforcing HTTPS (or loopback HTTP) and rejecting embedded credentials, queries, or fragments.
   - `deriveProviderId` creates a unique `config.toml`-valid provider ID from the endpoint hostname.
   - `probeCustomProvider` inspects `GET <baseURL>/models` (detecting `openai`, `anthropic`, `gemini`, `ollama`, or falling back to `manual` on 404/405 when a model ID is supplied), selects the target model (retaining full `/models` metadata when present), and validates the working wire protocol via a lightweight `maxOutputTokens: 16` generation probe (`chat` with `streamUsage: true` preferred for OpenAI-compatible gateways, falling back across `responses`, `anthropic`, `gemini` on endpoint-unsupported errors while failing fast on `AUTH`/`FORBIDDEN`/`RATE_LIMIT`/`PROVIDER_BILLING`/`CANCELLED`).

3. **Wire `quickConnectProvider` across Composition Root, SDK, TUI, and CLI:**
   - `apps/cli/src/bootstrap/startup.ts` registers the API key in `Redactor` immediately, runs `probeCustomProvider`, saves/reuses the provider in `~/.cosmew/config.toml` (never storing secrets), stores the key exclusively in `SecureVault`, caches discovered models with full metadata, validates/activates the account and selected model, and rolls back cleanly on any failure or cancellation.
   - `packages/sdk/src/client.ts` exposes `FutrynClient.quickConnectProvider(input, signal)` via an optional backend port.
   - TUI `ConnectDialog` opens `custom-quick` on Custom provider selection (one-line paste with automatic key masking, or 3 short steps `URL` → hidden `API key` → optional `Model`, plus `Tab` for the existing advanced custom provider form). `ModelsDialog` displays compact context/output limits (e.g., `1M ctx · 64k out`) next to models.
   - CLI `loginWizard` and `cosmew login "https://... | ... | ..."` / `cosmew login <base-url>` use the same quick-connect path.

## Consequences

- Third-party gateways connect in a single pasted line (or 3 short prompts) with automatic protocol detection and verified generation.
- `/context`, Context meter, `ModelsDialog`, and auto-compaction use each gateway model's actual advertised context and output windows.
- Security invariants remain unchanged: API keys are redacted immediately, never written to `config.toml` or settings, and rolled back on failure.
