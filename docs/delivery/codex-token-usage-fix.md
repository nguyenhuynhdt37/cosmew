# Fix 01 — Accurate Codex token usage

Scope: Codex subscription accounting only, authorized 2026-11-15. No public contract, storage migration, dependency, exploration, tool, cache implementation or TUI layout changes. Existing receipts already distinguish observed counts and terminal outcomes.

## Source-first findings

Official OpenAI documentation: [App Server turn events](https://learn.chatgpt.com/docs/app-server#turn-events). Source inspected 2026-11-15 at Codex commit `ee344ca9458351a6ea102795fa73110ad3ede5dc`:

- [App Server thread types and conversion](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/app-server-protocol/src/protocol/v2/thread.rs): `ThreadTokenUsage` carries `total`, `last`, `modelContextWindow`; the notification identifies thread and turn. Conversion maps core totals/last directly. `TokenUsageBreakdown` includes input, cached input, cache-write input, output, reasoning output and total tokens.
- [Core protocol accounting](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/protocol/src/protocol.rs): `TokenUsageInfo::new_or_append` adds each response into total and replaces last; `TokenUsage::add_assign` sums each metric. `non_cached_input` subtracts cached input from input, so cached input is already included. `tokens_in_context_window` uses last's total tokens; this is separate from thread consumption. `fill_to_context_window` can synthesize context-exhaustion counts; these are not billing evidence.
- [App Server notification emission and tests](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/app-server/src/bespoke_event_handling.rs): `handle_token_count_event` emits usage and rate limits separately. Its fixture explicitly distinguishes total from last.

Root cause: host.ts published `tokenUsage.last` as request usage. Core correctly treats each usage event as a replacement snapshot within one ModelPort request (adding only prior separate request rounds). SDK summarizes stored receipts, and TUI statistics use that SDK projection. Therefore three inline model calls were reduced to the third call at every layer. No changes to core, SDK, TUI or other adapters are needed.

## Accounting decisions and limits

Each current Codex request starts a fresh ephemeral thread and one turn. Its selected `total` snapshot is therefore this request's measured consumption. Replace snapshots; never sum notifications. Cached input and cache write remain input subset metrics; reasoning remains an output subset. None is added again to input/output totals. Subscription USD remains unknown.

Thread and turn IDs fence usage. Notifications arriving before the turn/start response are buffered (maximum 256) and checked against the returned turn ID. Notifications after the terminal event are ignored. Without a notification sequence number, selection conservatively requires a strictly increasing, safe nonnegative integer totalTokens and nondecreasing previously observed component counts. Duplicate, older, conflicting equal-total and regressive snapshots are ignored as a whole; no fieldwise maximum is synthesized. A newer incomplete snapshot exposes missing/invalid components as null rather than carrying stale values or deriving them from last. Missing total/watermark cannot be ordered and is ignored. This can underreport incompatible/corrected runtime snapshots; it cannot establish their chronology. No upstream ordering/replay guarantee is assumed.

Context uses the accepted snapshot's last.totalTokens and modelContextWindow, never its cumulative total. This remains a runtime-reported historical context measurement, not an exact current occupancy/tokenizer. Invalid or missing limits/counts stay unknown. Quota-only notifications preserve measured counts. Cancellation/failure never emits a successful completion; observations delivered before interruption remain partial usage with the interrupted outcome. Data never delivered by the runtime cannot be reconstructed. Synthetic context-exhaustion/compaction corrections and lost notifications cannot be treated as exact billing; no billing reconciliation is claimed.

If threads are reused later, the current fresh-thread assumption must be removed: record a validated cumulative baseline at turn start, subtract it from end totals for each known metric, fence turn identity, and keep context separate. Baselines, resets, compaction, absent fields and corrections require explicit handling; unknown baselines must yield unknown deltas. Do not sum lifetime thread totals across turns. Reuse is not implemented here.

## Deterministic verification

The three-response fixture executes two Hannes read tool exchanges within one Codex turn. Calls report input/output 100/20, 200/30, 300/40. Cumulative snapshots are 100/20, 300/50, 600/90. Before: 300/40 (340 consumption tokens). After: 600/90 (690 consumption tokens), cached input 260, cache write 60, reasoning 35. Context remains 340 / 32000. Duplicates, delayed earlier snapshots, foreign identities, equal-total conflicts, post-terminal notifications and quota-only updates do not inflate the result.

Tests inspect emitted completion, durable receipt, SDK totals, resumed session and existing TUI usage report, plus absent/incomplete measurements and interrupted outcomes. Fixture evidence does not verify authenticated vendor compatibility or exact billing.

## Changed modules and executed checks

- `apps/cli/src/subscriptions/codex-usage.ts`: private cumulative snapshot selector, numeric validation, unknown metrics and separate last-call context.
- `apps/cli/src/subscriptions/host.ts`: Codex-only wiring, identity fencing and bounded early notification buffering. Existing quota merging, core, SDK, TUI and other provider adapters are unchanged.
- `tests/subscription-fixtures/runtime.ts`: scoped Codex accounting scenarios and a corrected existing telemetry fixture containing official total/last/identity fields. Copilot/ACP scenarios retain their behavior.
- `tests/contracts/codex-usage.test.ts`: exact duplicate/regression/partial/invalid/subset checks.
- `tests/end-to-end/subscriptions.test.ts`: three-call wire fixture through receipt/SDK/TUI reports and resume, two independent ephemeral requests, early notifications, incomplete/missing usage, cancellation and failure.
- `docs/adr/0009-command-telemetry-and-account-continuation.md`, `docs/README.md`, and this report: isolated scope, source findings and acceptance evidence. No schema or storage migration; historical receipts are not backfilled because their missing earlier calls cannot be recovered.

Executed 2026-11-15: `bun run typecheck` and `bun run lint` passed. `bun test tests` passed with **313 pass, 5 skip, 0 fail** across 29 files, including exploration/session/permission/TUI regressions. After final numeric-validation and identity-guard refinements, `bun test tests/contracts/codex-usage.test.ts tests/end-to-end/subscriptions.test.ts` passed with **80 pass, 1 skip, 0 fail**; typecheck and lint also passed again. Skipped checks require native vault/installed runtime or real interactive login and are not claimed as verified.
