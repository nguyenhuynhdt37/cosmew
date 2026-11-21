# ADR 0090 — Anthropic and Gemini reasoning efforts

Accepted 2026-11-22. Additive within contract 1.43. This extends [ADR 0078](0078-user-declared-reasoning-efforts.md) and uses the existing [ADR 0082](0082-provider-reasoning-replay.md) continuation and stream paths.

## Installed SDK evidence

The installed package versions are the source revisions below. Paths are under `packages/models/node_modules/@ai-sdk/`. Inspected 2026-11-22.

| Package revision | Installed sources | Options and limits |
| --- | --- | --- |
| `@ai-sdk/anthropic@4.0.105` | `anthropic/src/anthropic-language-model-options.ts`, `anthropic/dist/index.d.ts`, `anthropic/src/anthropic-language-model.ts`, `anthropic/src/anthropic-model-catalog.ts`, `anthropic/docs/05-anthropic.mdx` (Effort, Reasoning) | `providerOptions.anthropic.thinking = {type: 'enabled', budgetTokens}` becomes `thinking: {type: 'enabled', budget_tokens}`. The SDK adds `budgetTokens` to AI SDK `maxOutputTokens` for wire `max_tokens` and caps the total on known models. It defaults a missing manual budget to 1,024. `effort` accepts `low\|medium\|high\|xhigh\|max` and serializes as `output_config.effort`. The catalog identifies native, adaptive, budget, disable and `xhigh` support. The SDK strips temperature/top-p during thinking unless configured to support them, strips top-k while thinking, and drops sampling parameters for models that reject them. Adaptive thinking supports `display: 'summarized'` for visible reasoning. |
| `@ai-sdk/google@4.0.121` | `google/src/google-language-model-options.ts`, `google/dist/index.d.ts`, `google/src/google-language-model.ts`, `google/src/google-model-catalog.ts`, `google/docs/15-google.mdx` (Language Model Options, Thinking, Long decode) | `providerOptions.google.thinkingConfig = {thinkingLevel, thinkingBudget, includeThoughts}` becomes `generationConfig.thinkingConfig`. Gemini 2.5 uses budget. Gemini 3 and later text models use level. The SDK catalog retains a budget format exception for `gemini-3-pro-image`. Original Gemini 3 Pro takes low/high, 3.1 Pro adds medium, 3 Flash also takes minimal, and Gemini 4 Hydrogen adds xhigh. The SDK catalog sets a 128-token minimum for 2.5 Pro and maxima of 32,768 for 2.5 Pro and the image exception, and 24,576 for the other budget-format models. `includeThoughts: true` requests thought summaries. |

Anthropic's installed thinking options also describe interleaved output through adaptive `display: 'updates'` and the model-specific `between_tools` mode. The serializer attaches `thinking-display-updates-2026-08-18` for updates and accepts generic `anthropicBeta` headers. The installed sources contain no dedicated legacy interleaved-thinking setting or automatic legacy interleaved beta header. Cosmew sends adaptive summarized thinking or the explicit legacy budget and leaves any legacy interleaved beta behavior **Needs verification**.

## Decision

The catalog saves advisory `ModelInfo.reasoningOptions` with recognized models.dev effort values, a toggle flag and a valid nonnegative integer `budget_tokens.min`. Existing user model, provider default and provider-advertised effort precedence applies. Advisory data cannot override explicit unsupported capability. The catalog projects usable `reasoningEfforts` through the same mapping the adapter uses. A toggle by itself can provide `none` on models with a disable control and supplies no positive levels. Chat and Responses continue sending the selected value unchanged.

Native effort metadata selects the provider's native level when the installed SDK can serialize it for that model. Anthropic uses `effort` and adds adaptive thinking with summarized display when supported. Gemini sends only `thinkingLevel` and requests summaries. A budget-only model uses the following **Cosmew-defined** table. These fractions and provider acceptance are **Needs verification** against live providers.

| Level | Fraction of model output limit |
| --- | ---: |
| minimal | 5% |
| low | 20% |
| medium | 35% |
| high | 50% |
| xhigh | 75% |
| max | 90% |

Round down. A per-level override in `[model_providers.<id>.reasoning.models."<model>".budgets]` wins over `[model_providers.<id>.reasoning.budgets]`, then the table. Overrides are positive integers for the six table levels. The effective cap is the smaller of the model output limit (also bounded by a known Anthropic SDK cap) and an explicit request cap. An explicit request cap can supply the ceiling if no model limit is available. Clamp the enabled budget to at least the advisory minimum and the applicable provider floor (1,024 for Anthropic, SDK minimum with a positive floor for Gemini), and at most the effective cap minus one and any applicable SDK budget maximum. Fail before fetch if the range is empty or there is no known ceiling. For Anthropic pass the cap less the budget to the SDK so its final `max_tokens` includes both and exceeds `budget_tokens`. Cosmew sends no sampling options. For Gemini pass the total cap and request summaries.

`none` sends Anthropic `thinking.type = 'disabled'` or Gemini `thinkingBudget = 0` with `includeThoughts = false` when supported. Claude models that must think, Gemini 2.5 Pro and Gemini level-based models reject `none` at the adapter before fetch. The adapter also rejects unknown capability, missing mappings and unworkable budgets with protocol-specific `UNSUPPORTED` diagnostics. SDK defaults and fallback levels cannot silently replace an explicit choice.

Provider-disclosed reasoning still emits `reasoningDelta`. Provider-reported reasoning usage and signed or opaque continuation metadata use the existing usage and private replay paths. The opt-in `replay_reasoning` flag still governs compatible Chat. No new event, storage migration, request field or dependency is required. `/effort` and `/model` use the SDK's resolved list. Budget-based models with positive levels display a token-budget hint.

## Verification

Fetch-recorder fixtures use the real installed serializers for native levels, budgets, clamps, overrides, `none` and pre-fetch errors. Synthetic streams cover reasoning deltas, Gemini reasoning usage, tool calls and private replay metadata. Authenticated acceptance, version-specific limits and live interleaved behavior remain **Needs verification**.
