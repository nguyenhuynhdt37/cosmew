# Commands, reasoning, usage and context audit

Date: 2026-11-15. Baseline: `441ea3c`. Scope: analysis and implementation proposal only; no runtime behavior changed by this audit. PA1/TUI1/SUB1 boundaries remain in force. General tools, MCP/plugin hosting and delegated task scheduling remain Not implemented.

## Verified findings

| Priority | Finding | Repository evidence |
|---|---|---|
| P0 | Slash navigation can execute a different command from the highlighted row. Keyboard handling indexes every match; rendering slices the first 5 (or fewer) and takes selection modulo that slice. | `apps/tui/src/app.tsx` composer key handler; `components/editor.tsx` `renderPromptComposerLines`. Reproduction: `/`, selected index 6 → execution `/mcp`, visual highlight `/theme edit`; 19 total matches. |
| P1 | Command metadata/help, TUI dispatch and line-CLI dispatch are separate implementations. Alias arguments differ (`/model <id>` vs `/models <id>`, `/theme` vs `/themes`); streaming availability is another hardcoded list. | `components/editor.tsx` `SLASH_COMMANDS`; `app.tsx` `executeSlashCommand`; `apps/cli/src/index.ts` `chat`. |
| P1 | `/usage`, `/context` and `/cost` are absent. Unsupported capability commands share the menu with implemented ones without structured availability metadata. | `SLASH_COMMANDS`, TUI and line-CLI dispatch. |
| P1 | Reasoning is neither transported nor configurable. A thinking capability flag is not an actual effort setting. SDK emits `thinking: Preparing request`; `started` immediately becomes `streaming`, while the companion changes to replying on the first text delta. These represent inconsistent transport/presentation states. | `packages/contracts/src/models.ts` `ModelEvent`/`ModelRequest`; SDK `sendMessage`; model adapter `fullStream`; runtime host events; TUI `submitPromptInternal`. |
| P1 | Only the last completed turn's input/output/cost exists in SDK memory. Session storage saves messages, not usage receipts. Restart/resume cannot restore historical usage. `resumeSession` also leaves the previously active `lastUsage` intact. | SDK `lastUsage`, `resumeSession`; `packages/persistence/src/session-store.ts`; `ConversationStore` contract. |
| P1 | Unknown token counts are formatted as zero in the completion banner; monetary values in the transcript lose the `costEstimated` qualifier. | TUI `submitPromptInternal`; `components/messages.tsx`. |
| P1 | Context-window and pricing fields exist, but discovery normalizes models to null metadata. Advisory enrichment requires explicit `models sync-metadata`; subscription model conversion drops metadata too. | `packages/models/src/catalog.ts`; CLI metadata command; `apps/cli/src/subscriptions/host.ts`. |
| P1 | Context occupancy is not measured. Core has a message/serialized-size guard, no model-aware tokenizer or context admission budget. Runtime transports add a serialized conversation wrapper, then may add their own hidden context. | Core `Conversation.send`; adapter request validation; subscription `stream`. |
| P2 | `/status` exists but is a static account/config/capability card. It omits usage, context, pricing and reasoning configuration. It has no pagination and can exceed short terminal height. Account validity is historical, not a live connectivity measurement. | `screens/settings.tsx` `renderStatusOverlay`; SDK `status`; CLI `status`. |

## Product behavior to implement

Commands remain Claude-style canonical as originally requested; Codex provides presentation references. Use `/usage` as the primary usage command, `/cost` as its compatibility alias, and `/context` for context composition. `/usege` should suggest `/usage`, not become another advertised command. Current vendor docs are versioned evidence, not a reason to add commands without backend support.

1. One command registry/parser: canonical ID, aliases, argument schema, category, availability, reason when unavailable, permissions and streaming policy. Help/autocomplete/palette/dispatch use the same resolved definition. Normalize aliases before parsing arguments; do not silently execute fuzzy matches when explicit arguments or unknown subcommands are present. CLI/TUI share semantics while retaining appropriate interaction hosts.
2. One selection model for the slash list: full result set, selected absolute index, visible offset and available row count. The highlighted item, Tab insertion and Enter execution must always reference the same ID. Scroll the viewport to selection; preserve the draft on Esc; expose supported/unsupported status and empty results.
3. Distinguish preparing, waiting for provider, provider-reported reasoning summary, receiving answer, completed, cancelled and failed. Only display summaries/reasoning text explicitly supplied by a supported provider API/runtime; never fabricate the model's private internal reasoning. Keep answer and optional collapsible reasoning-summary panels separate. Effort controls are provider/model-specific and appear only when the official transport supports them. Chat/Plan/Review view modes do not enable reasoning or tool permissions.
4. Durable usage receipts per turn: session/request/account/model IDs, outcome, timestamps, input/output, cache/reasoning breakdown when reported, provenance, and price version/source. Commit usage and turn outcome consistently; retain reported partial usage for cancellation/failure without replaying a request. Old sessions must say historical usage unavailable, not zero. Account/session changes must not show another account's totals.
5. `/usage`: last turn, session totals and per-model breakdown; provider-reported counts vs estimates; observed coverage (including turns with missing usage); locally estimated API cost with price provenance. Account-plan quotas/reset times are a separate section only if an official endpoint/runtime supplies them. Subscription usage is neither `$0` nor API list-price billing. Never infer provider account-wide spend from FUTRYN's local session totals.
6. `/context`: model context/output limits with source/freshness, current request composition and output reserve. Prefer runtime-reported context; otherwise use a reviewed model-specific tokenizer or an explicitly labelled estimate. Cumulative session tokens are not context occupancy. Last-turn prompt tokens are a historical measurement, not the next request's current total. If runtime-added instructions/context cannot be measured, report that coverage limitation. Never show a precise percentage when either numerator or limit is unknown.
7. `/status`: account/provider/model, actual auth mode/runtime, active session, last observed connectivity and check time, effective reasoning setting, usage summary and context summary. Link to `/doctor`, `/usage`, `/context` and `/model`. Place detailed runtime/backend capabilities on a secondary page; support small-terminal scrolling.
8. Compact chat footer: model, meaningful request phase, context used/limit and estimated cost only when supported by evidence. Unknowns remain unknown; interrupted requests must not appear complete. Preserve existing authentication, themes, sessions and permission enforcement.

## Architecture and migration

- `contracts`: additive versioned reasoning/progress/usage/metadata types and a usage-receipt port; update ADR and consumers together. Exact schema should be finalized before implementation.
- `models`: provider-specific official option/event mapping, model metadata normalization, pricing provenance and context/token-count support. No generic capability-to-effort assumptions.
- `security`: redact summaries and usage diagnostics before UI/storage; enforce existing endpoint/account boundaries. No new vault access for UI or plugins.
- `persistence`: additive migration for usage receipts/metadata, atomic turn completion, nullable historical coverage, restart/resume reconstruction. Reject unknown newer storage versions.
- `core`: request/context assembly, actual output reserve and context admission before sending; cancellation/failure accounting. No auto-compaction claim until a real compaction backend exists.
- `sdk`: command-independent status/usage/context projections and session/account scoping; transport truth stays distinct from presentation labels.
- CLI/TUI: shared parser/projections, scrollable views, summaries and accessible keyboard behavior. No direct UI imports of persistence/provider implementations.

No dependency is approved by this document. Any tokenizer/library needs the repository's license/provenance/version/Bun/platform/threat review first. No public contract or durable schema changes were made during this audit.

## Implementation order and acceptance

1. Repair command selection, parsing, aliases and availability; fix stale `lastUsage`, unknown-to-zero display and missing estimate labels.
2. Add durable usage receipts and provider/runtime event normalization with cancellation/failure coverage.
3. Normalize authoritative model limits/pricing; add context measurement/admission with explicit uncertainty.
4. Deliver `/usage`, `/cost`, `/context`, rebuilt `/status`, reasoning summary/effort UI and footer; preserve current command conventions.
5. Verify unit/contract, provider protocol integration, migration/restart, secret redaction and actual terminal E2E. Report authenticated live-provider coverage separately.

Required regression cases: select beyond the first five slash results; tiny terminal; every alias with valid/invalid arguments; argument completion vs execution; Esc draft preservation; commands while streaming; missing metadata/usage/pricing; zero vs unknown; cache/reasoning token overlap and no double counting; estimates vs reported billing; cancellation with/without reported usage; account/model switch; old sessions; resume/restart; storage failure; context near/over limit; runtime-hidden context; provider not exposing reasoning/quota; summary redaction.

## Upstream references and limits

Accessed 2026-11-15 via Context7 current documentation indexes:

- [Claude commands](https://code.claude.com/docs/en/commands), [cost tracking](https://code.claude.com/docs/en/costs), [model configuration](https://code.claude.com/docs/en/model-config): current index describes `/usage` and `/cost` alias, locally estimated session costs and separate subscription usage. Website docs have no immutable revision in this evidence; verify again when implementing.
- [Codex status controls](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/status_controls.rs), `status/card.rs`, `slash_command.rs`: `/status` uses token/rate-limit snapshots and effective effort; `/usage` is account usage. Dynamic index is not guaranteed to match the repository HEAD recorded in the previous presentation audit. These are behavior references, not proof of FUTRYN support.

Only the slash-selection mismatch was executed as a focused reproduction in this audit. Other findings come from direct source/contract/storage inspection. Existing test success does not establish coverage of these missing behaviors. No authenticated request, token lookup or provider charge was made.

## Implementation follow-up

The user authorized implementation on 2026-11-15, including account continuation and a named-account logout confirmation. The findings above describe the pre-change baseline. See [ADR 0009](../adr/0009-command-telemetry-and-account-continuation.md) and [usage/evidence](commands-usage-context-acceptance.md) for the delivered behavior, migration and remaining provider-specific limits.
