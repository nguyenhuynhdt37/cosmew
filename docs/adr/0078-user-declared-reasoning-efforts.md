# ADR 0078: User-declared reasoning efforts and provider-default reset

Date: 2026-11-21. Status: Accepted. Contract: **1.40** (additive optional
`Provider.reasoning`, folded into the uncommitted Cosmew rename; no 1.41).

## Problem

`CosmewClient.setReasoningEffort` rejected Auto before checking whether the value
was `default`. Catalog discovery understands `reasoning_efforts`, but compatible
endpoints can omit that metadata. The strict host parser previously refused any
reasoning declaration. The TUI offered Auto while reporting a generic action failure.

## Decision

Only user-level `~/.cosmew/config.toml` contributes provider declarations. The CLI
`HostConfigStore` continues reading the user state directory only; workspace
configuration never contributes providers or reasoning declarations.

```toml
[model_providers.my_xai]
name = "My xAI"
base_url = "https://api.x.ai/v1"
wire_api = "chat"
env_key = "XAI_API_KEY"

# Optional default levels for every model on this provider:
# [model_providers.my_xai.reasoning]
# efforts = ["low", "high"]

[model_providers.my_xai.reasoning.models."grok-4.7"]
supported = true
efforts = ["low", "high"]
```

The example is a declaration, not evidence that grok-4.7 accepts these levels.
**Needs verification**: live xAI grok-4.7 accepts `low`/`high` via Chat or Responses.
No live request was made for this decision.

Reasoning has three states: absent declaration/metadata is unknown; `supported =
false` is unsupported; `supported = true` or explicit efforts is supported.
Per-model user fields override provider user defaults, which override discovered
metadata. A model's explicit efforts imply supported even if the provider default
is unsupported. Unsupported clears levels and a default effort. Declaring support
alone does not invent effort levels. Model names never establish capabilities.

`ModelCatalog` resolves metadata in one place for discovered, cached and manual
models; all consumers receive `ModelInfo.reasoningEfforts` and
`ModelInfo.capabilities.reasoning`. Provider fingerprints include the declaration,
so changed config cannot reuse a catalog resolved under old config.

Declarations reject unknown keys, invalid model IDs, contradictory unsupported +
efforts, empty/duplicate lists, more than 20 levels, strings outside 1–40 characters,
whitespace/control characters and reserved `default`. Models are capped at 500.
Everything else in host config retains strict unknown-field rejection.

Auto resets without requiring levels. Enter clears the durable preference and the
session override; `s`/`{scope: 'session'}` changes memory only. Explicit levels
require resolved levels. Existing idle/active-selection guards remain in effect.

Chat serializes `reasoning_effort`; Responses serializes `reasoning.effort`.
Anthropic and Gemini still reject explicit effort before sending and name the
missing protocol mapping. Compatible Responses endpoints do not receive an
implicit summary request: explicit `reasoningSummary: null` suppresses the AI SDK
default; native OpenAI Responses retains `auto`. This does not add a summary
capability declaration. Errors use fixed safe diagnostics, never arbitrary
provider exception text, and the TUI displays the protocol/unknown-level message.

## Evidence and limits

Local source reviewed 2026-11-21 in the uncommitted working tree:
`packages/sdk/src/client.ts`, `packages/models/src/{host-config,catalog,adapter}.ts`,
`apps/cli/src/bootstrap/{host-config,startup}.ts`, and the Ink models panel.
Installed `@ai-sdk/openai` **4.0.118** Responses serializer (`packages/models/node_modules/@ai-sdk/openai/dist/index.js`)
defaults summaries to `detailed` when effort is present; explicit null omits the
wire summary. Installed version is pinned in `bun.lock`; no dependency added.

Regression tests cover SDK reset/session persistence, strict TOML parse/render,
metadata precedence, real AI SDK serialized request bodies at the fetch boundary,
and Ink panel text/reset. These are local contract/serialization evidence, not
live provider compatibility. HTTP fixture server binding in this execution sandbox
returned EADDRINUSE even on port 0; coordinator runs the complete suite outside it.

Verification in this sandbox: 71 focused tests passed across reasoning-effort,
host-config, p3-history-settings and Ink picker dialogs; the isolated contract 1.40
assertion passed. Typecheck passed. Repository lint reached Prettier and failed on
the unrelated existing untracked `apps/tui/src/ink/testing/fullscreen.test.tsx`;
that file was left untouched. `git diff --check` passed. The full compatibility
file also has two sandbox EPERM failures creating directories under the real home;
the coordinator must run those tests and the full suite with the required access.

## Follow-up: models.dev discovery and coding model defaults

Accepted 2026-11-21, additive within contract **1.40**, no SQLite change.
Online discovery and startup validation of an existing cached selection fetch the
bounded public models.dev catalog through the composition root's security fetcher.
One request is shared per application instance. Cached/offline reads perform no
network requests; advisory fetch/parse/mapping failures leave prior metadata usable.
`models sync-metadata --offline` is rejected before network access.

Matching reuses the exact models.dev provider key. A custom provider alias can also
match a unique provider entry's explicit `api` URL, equal to the configured base URL
apart from a trailing slash. If no entry advertises that URL, an exact unique URL
match against the existing `packages/models/src/registry.ts` provider presets can
resolve the key (xAI's supplied snapshot omits `api`). Ambiguous matches are ignored. Neither model names,
display names, host substrings nor model-ID patterns establish capabilities.
Matching model IDs are exact keys within that provider's `models` object.

`reasoning_options` entries of type `effort` supply ordered, deduplicated levels
(maximum 20): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
The existing contract accepts all these strings; it remains extensible for user
and provider declarations. `toggle`, `budget_tokens`, or `reasoning: true` establish
reasoning support without inventing effort levels. User model declarations > user
provider defaults > provider-advertised `reasoning_efforts` > models.dev > unknown.
Explicit unsupported reasoning retains its meaning. Enrichment also applies to
already cached catalogs, without replacing accounts. Chat and Responses pass the
chosen string unchanged (`reasoning_effort` / `reasoning.effort`). No value mappings
are invented. **Live check 2026-11-21 (xAI `grok-4.7`, account `xai`, tools off, prompt
"Reply with the single word OK.")**: `low`, `medium`, `high` and `xhigh` were each accepted
(HTTP success, answer `OK`, about USD 0.0025 per request). Reported `reasoningTokens`
were 57, 27, 30 and 30, so acceptance is verified but a monotonic effect of the level on
reasoning is **not** shown by this one-token probe. `none`/`max` were not probed;
their semantics and acceptance are endpoint/protocol-specific (**Needs verification**).
Anthropic/Gemini effort wire mappings remain unimplemented.

Default model listing filters explicit metadata that cannot serve a coding agent:
non-text output, types image/embedding/video/transcription/speech/reranking/realtime,
and explicit unsupported tools. Advisory text/tools evidence is stored separately in
optional `ModelInfo.codingEvidence` (additive within 1.40); models.dev never changes
capabilities other than reasoning under the precedence above. The filter checks
both evidence and provider capabilities. Unknown metadata, manual IDs and the
currently selected model remain visible. Provider rediscovery preserves manual
provenance. Successful ChatGPT account discovery supersedes configured preset
fallback IDs, while retaining explicit user-added manual IDs; `manualOrigin`
distinguishes the two. Legacy manual IDs matching configured fallbacks are dropped
from that merge, while other legacy manual IDs remain available. The model
panel reports the hidden count and `a` toggles all models; `fyn models list --all`
(and search/select `--all`) bypasses filtering. Explicit selection from the expanded
panel is allowed. No preference or additional SQLite data is introduced.

Evidence: [models.dev public API](https://models.dev/api.json), accessed **2026-11-21**;
the supplied snapshot contains 10,019 models across 324 providers. This data is
community-maintained advisory metadata, not live compatibility evidence. Examples:
xai/grok-4.7 advertises low/medium/high/xhigh; anthropic/claude-sonnet-4-5 advertises
budget tokens without effort levels. Local regression fixtures cover metadata
parsing, precedence, cache refresh, offline failure, endpoint identity, each excluded
type, exceptions, panel levels/toggle, and real AI SDK serialized `xhigh` bodies.

Follow-up verification (2026-11-21): `bun run typecheck` passed. The focused
models-dev-coding, reasoning-effort, host-config, p3-history-settings and Ink picker
dialog files passed **92 tests / 398 assertions**, including unchanged serialization
of all seven levels for Chat and Responses. `bun run lint` passed its TypeScript
stage but Prettier reported unrelated dirty `apps/tui/src/ink/integrated-shell.tsx`
and `apps/tui/src/ink/testing/native-pty.test.ts`; those files were left untouched.
The coordinator runs the full suite. No live provider generation was performed.

Cached-session refresh follow-up (2026-11-21, additive within the uncommitted contract **1.40**): session startup and model/effort panels request advisory enrichment when reasoning is unknown/supported, levels are missing, and models.dev metadata is absent or older than 24 hours. Discovery and these consumers share one abortable, five-second-bounded request per application; failures are silent, attempts are not retried in that process, offline mode disables fetching, and tests require an explicit metadata-fetch injection. Successful enrichment uses the existing catalog persistence boundary and SDK state notification; open panels show “Loading effort levels…” and update without restarting. Stored enriched models resolve synchronously on subsequent launches, including offline launches. Headless exec awaits the shared refresh only for a requested/stored effort with missing levels; ordinary turns/input never await it. Existing conversations resolve updated model metadata at provider invocation, preserving user/provider precedence and the invariant that advisory metadata never upgrades other capabilities. Local fixtures cover loading/success/failure, freshness, sharing, persistence, offline/test suppression, cancellation, and conditional headless waiting; no new live provider claim is made.
