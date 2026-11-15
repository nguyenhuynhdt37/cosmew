# ADR 0030 — Hannes-owned durable conversation recovery

Accepted 2026-11-16. Contract **1.12**, SQLite **4**. Extends ADR 0029; does not enable any additional execution backend.

## Failure and evidence

Baseline branch `dev`, HEAD `196e72069f2450387ae8c01b4ebe6b8e7686cead`. Existing uncommitted Claude work was preserved and integrated. Three deterministic regressions were run before the recovery implementation: **0 pass, 3 fail** (`runtime-recovery.test.ts`: interrupted reads, restart reconstruction, missing outcomes).

At that HEAD, `packages/core/src/agent/engine.ts:138–156` held intermediate steps in memory and on failure saved only applied writes; the original user request also disappeared from in-memory history when no write had completed. `apps/cli/src/bootstrap/startup.ts:210–211` reconstructed only committed messages. `packages/persistence/src/session-store.ts` persisted intermediate calls only on successful completion. Core context builder/compaction and persistence event-store were empty placeholders. Generic exploration guidance could end with a promise instead of a verified artifact. These are independent causes; a continuation-keyword handler alone cannot fix them.

## Pinned upstream inspection

Inspected official OpenAI Codex source on 2026-11-16 at **`5cb38e79842a0e0a6dca5bb97874163e8ee50129`**:

- [context_manager/normalize.rs](https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/codex-rs/core/src/context_manager/normalize.rs): supplies missing aborted outputs and removes orphan outputs to repair protocol history, without replaying tools.
- [session/rollout_reconstruction.rs](https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/codex-rs/core/src/session/rollout_reconstruction.rs): reconstructs from replay checkpoints, replacement compaction history and the subsequent tail; correlates turn completion/abortion.
- [session/turn.rs](https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/codex-rs/core/src/session/turn.rs): preserves input even when pre-turn compaction fails.
- [compact.rs](https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/codex-rs/core/src/compact.rs) and [context_manager/history.rs](https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/codex-rs/core/src/context_manager/history.rs): budget-aware history, token estimates, measured usage, normalization and output truncation.
- [rollout/src/recorder.rs](https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/codex-rs/rollout/src/recorder.rs): ordered recorder/persist/flush operations. Core's rollout module is now a facade, not the recorder implementation.

The SQLite journal, process ownership fence, extractive compactor and progress heuristics below are **Hannes-specific choices**, not copied Codex APIs or a claim of complete Codex parity.

## Ownership and lifecycle

Contracts define durable turns/events, task checkpoints and context snapshots. Core consumes persistence ports and owns reconstruction, model requests, progress and tool dispatch. Persistence alone owns SQLite. CLI injects model metadata, redaction and analysis mode; SDK refreshes canonical history after success or failure. Provider SDK types do not enter core. Existing `hannes`, `codex-bridge`, `chat-only`, `delegated` boundaries remain explicit; a Codex bridge still owns its own foreign loop and is not presented as a Hannes-owned model loop.

Each accepted user request and initial receipt is transactional, before project loading or model invocation. Turn ID is the stable request UUID. Allowed transitions: `pending → running` on a model request, then either `pending|running → completed|failed|cancelled|interrupted`; repeated model requests retain running. Terminal turns cannot accept further events. Dead process owners become interrupted. A new user request is a new turn, never a transition that reopens an old turn.

`user.accepted`, `model.requested`, `assistant.text`, `tool.call`, `tool.intent`, `tool.result`, `turn.finished` have monotonic per-conversation sequence numbers. Text deltas and confirmed results are saved as they arrive, not deferred to the final answer. Provider-private reasoning is not persisted. Intent includes a unique execution ID and is saved before dispatch. Results must match call ID/name/schema. Completed writes carry historical scope hashes also present in audit records; hashes grant no authority.

A live process owner cannot be stolen by another client, including a client in the same process. Dead-owner detection uses PID liveness only (no termination signals). PID reuse fails closed rather than stealing ownership. Explicit iterator closure finalizes cancellation. Concurrent read batches drain before turn termination. Deletion rejects an active turn.

## Storage migration and reconstruction

Schema 3 → 4 transactionally adds `execution_turns`, `conversation_events`, `conversation_checkpoints` and optional `tool_audit.scope_hash`; existing messages/receipts remain intact. Existing schema 0–3 upgrade paths remain supported; versions above 4 are rejected. Private file protections, DELETE journaling and FULL synchronization remain in effect. No downgrade is offered. Back up state before running a newer version if rollback is needed.

Reconstruction uses journaled turns where present and legacy messages outside their revision ranges. Sequence gaps, invalid event shapes, mismatched/duplicate results, invalid lifecycle endings and malformed checkpoints fail explicitly. Legacy stores remain source-compatible through optional port additions; only the SQLite implementation supplies the new crash-recovery guarantees.

Missing output is labeled **unknown** if execution intent exists, or **not executed** if dispatch never started. Core normalizes exact call/result envelopes for provider protocols. Reconstruction calls no tool. A filesystem effect and SQLite result are not atomic: after a crash, a file can exist without a confirmed result. The model receives that uncertainty and must inspect current state. A new mutation must pass current permissions, approval and revalidation; grants are cleared on resume/fork. No exactly-once filesystem guarantee is claimed.

Fork copies evidence and unfinished objective but not execution ownership, approvals or verified-artifact status. It never replays side effects. Redaction applies recursively to both legacy messages and journal/checkpoints before persistence. This uses the existing credential-aware redactor, not a guarantee that arbitrary user prose can be recognized as secret. SQLite content remains unencrypted local data.

## Model-visible context and task continuity

Canonical durable history is separate from the model-visible context. The builder combines applicable guidance, current project instructions, validated recent history, previous results, labeled interrupted-task context and the current request. Checkpoints distinguish objective, artifact targets, actual successful results, pending work and failures. Plans are not execution evidence. The current user request always overrides stale task state. Continuation phrases use surviving history; they do not execute special commands or grant permission.

Model catalog context/output limits, when available, determine the budget. Otherwise conservative defaults apply. UTF-8 estimates and measured provider usage replace the old raw-character gate; the estimate is not an exact tokenizer. At 75% pressure, a provider-neutral compactor can create a snapshot. The default is deterministic extractive compaction: all older user requirements, tool identities/inputs, bounded read evidence with hashes, actual mutation receipts without full diffs, active task and authorization disclaimer survive; the last two user turns remain verbatim. Full durable events are retained. Snapshot prefix count/hash/provenance are checked on reuse. `throughRevision` counts canonical messages in the hashed prefix, not SQLite message revisions.

An injected adapter compactor may provide bounded non-authoritative notes; Hannes retains extractive evidence independently. No provider-native compaction endpoint is currently implemented or advertised. Model-visible oversized read results are explicitly truncated; mutation receipts are not silently truncated by the context builder. If critical requirements cannot fit, return CONTEXT_LIMIT without corrupting durable history. Extractive retention deliberately cannot compress unlimited user constraints indefinitely.

## Guidance and bounded progress

Guidance distinguishes explanation/research, creation, modification, debugging and verification, constrained by available capabilities. Explicit plan/review mode omits write exposure. Filename/continuation heuristics help auxiliary task state but are not execution authority or the model's sole source of intent.

Distinct successful reads count as progress. Three batches containing only repeated/failed/refused results trigger a correction; six stop with STALLED. Artifact requests that end in planning without verification receive at most two corrective rounds, then terminate transparently. This is not an arbitrary deadline to write within N calls. A denied mutation is never automatically invoked again in that turn. User-configured step/tool/token/time/cost budgets are preserved; there is no default 16-round/32-call turn ceiling. Per-response and context safety bounds remain.

## Security and validation limits

All effects still use ToolPort → registry/router/handler/orchestrator/runtime, workspace policy, approval, audit and revalidation. Recovery restores no approval, enables no native foreign tool, and does not open production exec_command. Historical content and summaries cannot authorize execution.

Tests use deterministic provider transports with the real model adapter → core → permission → apply_patch → filesystem → read → model continuation chain. Child-process tests exercise actual process exit and SQLite reopening; uncertain-write fault injection demonstrates the non-atomic gap, not production permission bypass. HTML checks confirm file content, doctype, closing HTML, title/button and standalone styling; they are not a full HTML5 validator. No authenticated real-provider smoke test or interactive UI acceptance is claimed. See [acceptance matrix](../delivery/conversation-recovery.md).
