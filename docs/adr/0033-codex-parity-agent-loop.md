# ADR 0033 — Codex-parity Futryn Agent Loop

Accepted 2026-11-16. Contract **1.14** (additive). Extends ADR 0029 (Futryn owns the loop) and ADR 0030 (durable journal); SQLite schema unchanged (new journal event type only). Enables no new tool, backend or permission.

## Pinned upstream evidence

Official `openai/codex`, commit **`710bee73a89385aaf2afb41d885edf82473d941f`**, fetched 2026-11-16 (shallow fetch of that exact SHA). Futryn baseline `dev` @ `6358efaf88b640c3cb210d2c6b408bb12a223327`. Files and functions read:

- `codex-rs/core/src/tasks/regular.rs` — `RegularTask::run`, `run_turns` (re-runs `run_turn` while `input_queue.has_pending_input`, unless a terminal error or exhausted work budget).
- `codex-rs/core/src/session/turn.rs` — `run_turn` (pending input drained before each request except the first; `needs_follow_up = model_needs_follow_up || has_pending_input`; mid-turn compaction; error routing), `run_sampling_request` (stream retry loop re-clones history), `try_run_sampling_request` (`OutputItemDone` → `handle_output_item_done` → `in_flight.push_back`; `Completed{end_turn: Some(false)}` → follow-up; `drain_in_flight` after the stream, even on error), `drain_in_flight`.
- `codex-rs/core/src/stream_events_utils.rs` — `handle_output_item_done` (directly called: tool call recorded then dispatched; `RespondToModel` errors become outputs; `needs_follow_up = true`).
- `codex-rs/core/src/tools/parallel.rs` — `ToolCallRuntime::handle_tool_call_with_source` (`RwLock` read for `supports_parallel`, write otherwise; cancellation → `aborted by user after Xs`; `aborted_before_dispatch`).
- `codex-rs/core/src/tools/router.rs` — `tool_supports_parallel`, `build_tool_call`, `dispatch_tool_call_with_state`.
- `codex-rs/core/src/session/turn_input.rs` — `steer`, `start_or_steer`, `Session::steer_input` (`NoActiveTurn`, `ExpectedTurnMismatch`, `ActiveTurnNotSteerable` for Review/Compact, `EmptyInput`; input appended to the active turn's pending queue in acceptance order).
- `codex-rs/core/src/session/rollout_budget.rs` — work-budget gate (`tool_start_denial`, `check_rollout_budget`).
- `codex-rs/core/src/context_manager/normalize.rs` — `ensure_call_outputs_present` (synthetic `aborted` output for recovered calls), `remove_orphan_outputs`.
- `codex-rs/core/src/session/rollout_reconstruction.rs` — replay from the newest surviving compaction plus tail; never re-executes.
- `codex-rs/core/src/session/turn_suspension.rs` — flush before cancel; unclaimed input saved; no terminal event for a suspended turn.

Futryn is TypeScript/Bun with multiple providers; behavior was ported, not syntax. Mechanisms marked *Futryn-specific* below are not Codex mechanisms.

## Audit: Codex vs Futryn baseline

| Codex | Codex behavior | Futryn baseline | Discrepancy → change | Test (`tests/contracts/agent-loop-codex.test.ts`) |
|---|---|---|---|---|
| `try_run_sampling_request` / `handle_output_item_done` | A completed call item is dispatched while the response still streams | `engine.ts` buffered `calls` until `completed`, then `executeBatch` | Dispatch on `toolCallComplete` | 5 |
| `ToolCallRuntime` RwLock + `tool_supports_parallel` | Explicitly parallel tools share; others exclusive; FIFO-fair | Parallel inferred from `capability === 'fs.read'`; batch-local | `ToolDescriptor.parallel` + `ExecutionGate` (fair shared/exclusive) across the whole response | gate test, 3, 4 |
| `drain_in_flight` (FuturesOrdered) | Outputs recorded in output order, also after a stream error | Results in order, but stream error before `completed` dropped buffered calls | Ordered drain always runs; results recorded before the error propagates | 8, 23 |
| `run_sampling_request` retry | Retry re-clones history; tools never re-run | Retry only if nothing produced; produced calls aborted the retry | Executed calls go to history, then the request is retried | 8 |
| `aborted_before_dispatch` / `aborted by user` | Explicit outputs for cancelled calls | Queued calls had no outcome until recovery | Queued → `aborted before dispatch` (confirmed not run); running → `EXECUTION_UNKNOWN` with elapsed time (*Futryn keeps unknown: it cannot prove no effect*) | 9, 13, 14 |
| `steer_input` / `run_turn` drain / `regular.rs` loop | Steering joins the active turn, drained before the next request; races resolved by the active-turn lock | `send()` threw `POLICY` while running; TUI silently dropped Enter | `Conversation.steer`, SDK `steerMessage`, TUI routing; `accepting` flag closes atomically at completion | 10, 11, 12, 24 |
| `needs_follow_up` | Calls or pending input continue; otherwise finish | Calls continued; artifact heuristic forced continuation twice then **failed** with `STALLED`, also after a denied write | Pending input continues; artifact check blocks at most once like a Stop hook and never fails the answer | 12, recovery e2e |
| `ensure_call_outputs_present` | Missing outputs become `aborted` | Missing → `[unknown]` / `[not executed]` (ADR 0030) | Kept; steering placement added to reconstruction | 17, 18, 10 |
| `Completed{end_turn:false}` | Provider says the turn is not over → follow up | No equivalent signal in AI SDK finish reasons | **Not ported** (see differences) | — |

## Decision

**Ownership.** `Conversation.send` is the task: it owns one `ActiveTurn` (stable ID = request UUID = journal turn ID), accepts steering for it, and alone decides completion. Each loop iteration is one model request (`requests` counter); `round` counts completed responses for the user step budget; `attempt` counts stream retries. No new state machine or wrapper was added.

**Dispatch.** A `toolCallComplete` is validated (tools offered, ≤ 32 per response, ID unique in the turn), journaled as `tool.call`, dispatched through `ExecutionGate`, then yielded. Every call still goes through the injected `ToolPort` (router → policy → approval → revalidation → audit). Adapters emit only complete calls: the AI SDK adapter now holds calls flagged `invalid` (unparsed arguments, including ones the SDK flushes from a cut stream) until a clean finish, so a partial call is never dispatched while malformed-but-complete calls still reach the router (ADR 0029). Tool output deltas interleave with the model stream; `toolResult` events and history are in model-output order after the response.

**Steering.** `steer(content, expectedTurnId?)` refuses with `no_active_turn`, `turn_mismatch`, `not_steerable` (runtime-owned inline-tool loops; SDK also refuses `review` mode, as Codex refuses Review tasks) or `empty_input`. Accepted input is journaled (`user.steered`) **before** acceptance is returned and is delivered before every request except the turn's first, also when a budget has withdrawn tools. If it arrives during the final answer, the turn continues. Once completion begins (`accepting = false`, synchronous with the last pending check) further input gets `no_active_turn` and the TUI sends it as the next turn. Steering is plain user text: it never changes mode, grants or approvals. Not implemented: Codex's feature-gated sampling preemption and mailbox preemption.

**Termination.** Finish when the response has no calls, no accepted steering is pending (or tools were withdrawn by a budget/context stop), and the one-time artifact continuation is spent or not applicable. The artifact check now applies only without a denial/block and turns into durable `task.state = 'unfinished'` instead of `STALLED`. Kept with tests: the stagnation notice (3) and `STALLED` stop (6 rounds with no successful, non-identical result), per-response bounds, budgets and context handling. No default round/call ceiling exists.

**Recovery.** No second persistence engine. Recovery places `user.steered` exactly where the loop delivered it. Unfinished calls keep ADR 0030 semantics; no grant or terminal session is restored.

## Remaining differences (not parity claims)

- `end_turn: false` is not represented by Futryn's providers; Futryn continues only on calls or pending steering.
- Sampling/mailbox preemption, Stop/after-agent hooks, plan mode, code-mode workers, guardian review and async compaction are not ported (out of scope or absent subsystems).
- A text-producing response that then fails is not re-sampled (Futryn journals text as it streams); Codex discards unfinished items and retries.
- Interrupted running calls are `EXECUTION_UNKNOWN`, not `aborted by user`.
- `parallelTools = 4` bounds shared holders; Codex's RwLock has no reader bound.
- Turn-level input that misses an active turn is queued by the TUI, not by core (Codex keeps it in the session queue and starts a new turn).

## Evidence limits

All loop tests use deterministic in-process models/tools or the local HTTP fixture server and the real SQLite journal. They are fixture evidence: no live provider, real Docker container or real terminal session was exercised for this ADR.
