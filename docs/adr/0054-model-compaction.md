# ADR 0054 — Model-written compaction and `/compact`

Date: 2026-11-17. Status: accepted (Wave 2 step S2 = W8, `docs/delivery/wave-2/plan.md`).

The current runtime and displays share an 85% threshold. See [ADR 0093](0093-request-context-telemetry.md) for the current request estimate and journal.

## Context

A real UAT run sent up to 654k input tokens per request (4.3M in five turns) because the agent read many documents. Futryn only had extractive compaction (ADR 0030): user requests and truncated tool evidence kept verbatim, no model summary, no manual command, and it only touched earlier turns, never the tool rounds of the running turn.

Reference (read-only clones, read 2026-11-17; text is not copied):

- openai/codex @ `090be4df0724cdef5758e6a0934ba557af8b6bbe`: `codex-rs/core/src/compact.rs` (`run_compact_task`, `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`, `build_compacted_history`: recent user messages within the budget, oldest overflowing one truncated, then the summary as a user message); `codex-rs/prompts/templates/compact/prompt.md` (handoff-summary prompt) and `summary_prefix.md`; `codex-rs/protocol/src/openai_models.rs` `ModelInfo::auto_compact_token_limit` (90% of the context window); `codex-rs/core/src/session/context_window.rs` (limit reached → compaction, also mid-turn).
- OpenCode `session/compaction.ts` @ `0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4`: not re-read in detail; only the idea of a dedicated summarizing pass is shared. Needs verification for finer parity.

## Decision

1. **Auto compaction at 90% of the usable window** (`AUTO_COMPACT_FRACTION`, Codex `auto_compact_token_limit`), checked before every request of a turn (including follow-up rounds), so a request that would overflow is compacted first. The measure is the larger of Futryn's conservative estimate and the provider-measured previous round. The old 0.75 excerpt trigger is removed: the excerpt checkpoint is now the fallback.
2. **The current model writes the summary** (`packages/core/src/context/model-compaction.ts`): the model-visible history plus an original-wording checkpoint prompt, no tools. Tool results are truncated for the summarizer (16 KB, then 4 KB, then 1 KB each); if it still does not fit, no call is made and the fallback applies.
3. **Replacement shape (Codex `build_compacted_history`)**: most recent user messages up to 20,000 estimated tokens (oldest overflowing one cut; earlier handoffs are never retained as user text), then one user message `SUMMARY_PREFIX + summary` that says it is historical data, never a new request or permission grant. The host appends facts the model cannot be trusted with: the current plan (`loadPlan`) and a list of file-change receipts (paths, diffs omitted). Tool outputs of the span are dropped. AGENTS/project context is re-injected on every request by the loop, so it survives unchanged; nested AGENTS text read through tools is part of the dropped span (limit).
4. **Two scopes.** Before the first tool round of a turn (and `/compact`): a durable `ContextSnapshot` with `strategy: 'model'` (`retainedUserRequests` + `summary`, `throughRevision`/`sourceHash` as for the deterministic snapshot); recovery after a restart loads it (`useContextSnapshot` renders it), no new summary call. Mid-turn (tool rounds above the window): the running turn's rounds are folded into an **in-memory** handoff for the rest of that turn only. The journal is intact and the next turn compacts durably if still needed. Deviation: Codex persists mid-turn replacement history; Futryn cannot, because a snapshot indexes committed messages and the turn's messages are only committed at its end.
5. **No gain, no compaction.** If the replacement is not smaller than what it replaces, it is discarded (`not_needed` for `/compact`; a failure for auto). One failed or useless attempt disables further model attempts for the rest of the turn.
6. **Fallback, never data loss.** Model error, malformed/empty/length-cut summary or no fitting request → the existing extractive checkpoint (needs three user turns). Cancellation rethrows: the turn ends cancelled, nothing is changed or persisted. The journal/message history is never modified by compaction.
7. **Usage.** Compaction calls are billed: inside a turn they are folded into the turn receipt (so turn usage, budgets and session totals count them); a manual `/compact` adds its usage to the latest agent turn's receipt (`ConversationStore.addUsage`, receipt rows are keyed by message revision, and a compaction has none). Unreported counters stay `null` (`combineUsage`, moved to contracts).
8. **Event.** `ModelEvent` `context.compacted` `{trigger: auto|manual, strategy: model|excerpt, tokensBefore, tokensAfter, fallback?}` (estimates, not provider measurements). Live only; the durable record is the snapshot. It reaches `fyn exec --json` as is; plain exec prints one stderr line. Contract **1.26** (additive: new event, `ContextSnapshot.strategy` accepts `model`, `CompactionOutcome`, optional `ConversationStore.addUsage`).
9. **`/compact [instructions]`**: canonical slash command (handler `compact`), SDK `client.compact(instructions?, {signal})` → `CompactionOutcome`. Idle only: the command router refuses it while a turn runs (as for other session changes) and the SDK/`Conversation.compact` throw `POLICY`. The optional text is appended to the checkpoint prompt as user focus. TUI: banner plus a one-line dim transcript notice; auto compaction adds the same line to the running turn's notices.
10. `ConversationOptions.modelCompaction = false` keeps only the extractive checkpoint (tests and hosts that must not spend tokens).

## Consequences and limits

- A history made mostly of large user messages gains nothing (user messages are retained verbatim up to 20k tokens) and is reported as not needed.
- Token figures are the conservative 3-bytes-per-token estimate. With a very small window the excerpt fallback may be unable to shrink enough; the turn then ends with `context_window` as before.
- Live authenticated behavior against a real provider is not verified; evidence is fixture providers (`tests/contracts/model-compaction.test.ts`). The e2e recovery test lowers its model window to 20k because compaction now starts at 90% instead of 75%.
- Codex features not ported: remote/server-side compaction, pre/post-compact hooks, goal/world-state fragments.
