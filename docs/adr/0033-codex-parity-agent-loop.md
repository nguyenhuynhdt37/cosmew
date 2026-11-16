# ADR 0033 — Codex-parity Futryn Agent Loop

Accepted 2026-11-16; completed the same day. Contract **1.15** (additive over 1.13 → 1.14 → 1.15). Extends ADR 0029 (Futryn owns the loop) and ADR 0030 (durable journal). SQLite schema unchanged (new journal event variants/fields only; legacy rows stay valid). Enables no new tool, backend or permission.

## Pinned upstream evidence

Official `openai/codex` at **`0184dfa6a48f0110dd9c6835522492908e5abcf3`** (fetched 2026-11-16). The first iteration used `710bee73a89385aaf2afb41d885edf82473d941f`; `git diff --stat 710bee73..0184dfa6 -- codex-rs/core/src` is empty (the only change between them is one TUI test file), so every core mechanism below is identical at both SHAs. Futryn baselines: `6358efaf` (first iteration), `ec57ecfb` (completion).

Read directly: `tasks/regular.rs` (`RegularTask::run`, `run_turns`), `tasks/mod.rs` (`on_task_finished`), `session/turn.rs` (`run_turn`, `run_sampling_request`, `try_run_sampling_request`, `drain_in_flight`, `SamplingRequestResult`, `ResponseEvent::Completed { end_turn }`), `session/turn_input.rs` (`steer`, `start_or_steer`, `Session::steer_input`), `session/input_queue.rs` (`watch_user_input`, pending input), `session/mod.rs` (step context: `preempt` exists when `Feature::InstantInterrupt`, default enabled), `session/turn_suspension.rs`, `session/rollout_budget.rs` (`tool_start_denial`), `session/rollout_reconstruction.rs`, `stream_events_utils.rs` (`handle_output_item_done`), `responses_retry.rs` (`handle_response_stream_error`, `is_terminal_sampling_outcome`), `tools/parallel.rs` (`ToolCallRuntime`), `tools/router.rs` (`tool_supports_parallel`, `build_tool_call`), `context_manager/normalize.rs` (`ensure_call_outputs_present`, `remove_orphan_outputs`), `features/src/lib.rs` (`InstantInterrupt` default).

Behavior was ported, not Rust syntax. Rows marked *Futryn* are not Codex mechanisms.

## Mechanism mapping

Each row: Codex function → lifecycle behavior → Futryn function → difference fixed → evidence (`L` = `tests/contracts/agent-loop-codex.test.ts`, `C` = `tests/end-to-end/container-agent.test.ts` with `FUTRYN_TEST_CONTAINER=1`).

1. **`try_run_sampling_request` + `handle_output_item_done`** — a call is dispatched when its item is done, while the response streams. → `Conversation.send` stream loop + `dispatch`. Was: calls buffered until `completed`. → L5.
2. **`ToolCallRuntime` RwLock + `tool_supports_parallel`** — explicitly parallel tools share, others exclusive, FIFO-fair; cancellation while waiting = aborted before dispatch. → `ExecutionGate`, `ToolDescriptor.parallel`. Was: parallel inferred from `fs.read`. → gate test, L3, L4, L9, N.
3. **`drain_in_flight`** — outputs recorded in output order, also when the stream failed. → `drain()`. → L8, L23, P.
4. **`responses_retry` / `run_sampling_request` retry** — any retryable stream error re-samples from recorded history; partial output does not block it; `ResponseIncomplete` is terminal. → retry branch; `responseDiscarded{retry}`; `length` → `PROTOCOL`, and its text is never committed (no `model.completed`, so reconstruction labels it `[incomplete response …]`; completed calls/results of that response stay). Was: no retry after visible text; `length` accepted as an answer. → I, J+L, continuation test.
5. **OutputItemDone commit** — only completed items enter history. → `model.requested{protocol:2}` + `model.completed`; reconstruction drops superseded provisional text and labels a turn-ending partial response incomplete. → I, J, U, S+T.
6. **`watch_user_input` + preempt (InstantInterrupt)** — arriving input stops the HTTP stream (`needs_follow_up: true`), keeps completed items, drains in-flight tools, discards unfinished items. → preempt racer in the stream loop; `responseDiscarded{preempted}`. Not done while a budget/context stop is active (would add a request past the stop). → E/10, F, 12/B, U.
7. **`steer_input`** — `NoActiveTurn`, `ExpectedTurnMismatch`, not steerable (Review/Compact), `EmptyInput`; acceptance order kept. → `Conversation.steer` (journals `user.steered` before acceptance). → 10, 12, 24.
8. **`run_turn` pending-input drain** — before every request except the first; `needs_follow_up = model || pending`. → drain + `requests--` recheck. → 10, 11, 12, 19.
9. **`on_task_finished`** — late input cannot reopen a stopped turn; leftover pending input is kept, not lost. → `defer()` → session `pendingInput` (durable), carried into the next turn via `user.accepted.carried`; `inputDeferred` event. Was: appended to history as if processed. → A/19, S+T.
10. **`start_or_steer`** — busy input joins the turn or starts the next one. → SDK `submitWhileBusy` / `takeQueuedMessage`; TUI uses the SDK queue (no TUI-only queue). → C+D, G.
11. **`Completed { end_turn: Some(false) }`** — follow up. → adapter maps AI SDK `rawFinishReason === 'pause_turn'` to `completed.endTurn = false`; loop continues. → H.
12. **`tool_start_denial`** — work budget re-checked when a call is admitted. → `exhaustedWork()` in `run`. → budget re-check test.
13. **`ensure_call_outputs_present` / reconstruction** — missing outputs explicit; no replay. → journal reconstruction (`unknown` / `not executed` / `aborted before dispatch` / `EXECUTION_UNKNOWN`); corrupt sequences, duplicate step ids, orphan `model.completed`, stale carries → `STORAGE`. → 17, 18, K, U, carry test, `durable-execution.test.ts`.
14. **Cancellation** — `TurnAborted` propagates to stream, queued and running tools. → turn signal + gate abort. → 9, 13, 14, N, C (closing live command).
15. **Terminal sessions / nonzero exit** — results are what the tool reports. → unchanged ToolPort path. → 15, 16+22, C (pipe session), C (Q: real failing test → fix → passing rerun).
16. *Futryn* stagnation notice (3) / `STALLED` (6 rounds with no successful, non-identical result) and the one-time artifact continuation are kept: they never fire on rounds with successful results, never retry denied writes, and the artifact check never turns an answer into a failure.

## Final verification table

| Codex mechanism | Upstream source/function | Futryn implementation | Parity status | Test evidence |
|---|---|---|---|---|
| Dispatch complete calls mid-stream | `turn.rs::try_run_sampling_request`, `stream_events_utils.rs::handle_output_item_done` | `engine.ts` stream loop → `dispatch` | IMPLEMENTED — NOT LIVE VERIFIED | L5; adapters L24×4 (fixture HTTP) |
| Shared/exclusive scheduling, fair | `parallel.rs::ToolCallRuntime`, `router.rs::tool_supports_parallel` | `ExecutionGate`, `ToolDescriptor.parallel` | PARITY VERIFIED | gate test, L3, L4 (deterministic) |
| Ordered drain incl. after stream error | `turn.rs::drain_in_flight` | `drain()` | PARITY VERIFIED | L8, L23, J |
| Abort before dispatch / during execution | `parallel.rs::aborted_before_dispatch`, cancel branch | gate abort; `EXECUTION_UNKNOWN` | IMPLEMENTED — NOT LIVE VERIFIED | L9, N, L14; C closing live command (real container) — running calls are `unknown`, not "aborted by user" (deliberate) |
| Stream retry from recorded history | `responses_retry.rs::handle_response_stream_error`, `run_sampling_request` | retry branch, `responseDiscarded` | IMPLEMENTED — NOT LIVE VERIFIED | I, J+L, continuation test; no live transport fault injection |
| Incomplete response is terminal | `responses_retry.rs::is_terminal_sampling_outcome` | `finishReason === 'length'` → `PROTOCOL`; no `model.completed`, text stays provisional | IMPLEMENTED — NOT LIVE VERIFIED | I |
| Commit only completed items | `OutputItemDone` recording | `model.completed`, provisional reconstruction | IMPLEMENTED — NOT LIVE VERIFIED | I, J, U, S+T |
| Steering preemption (InstantInterrupt) | `input_queue.rs::watch_user_input`, preempt branch of `try_run_sampling_request` | preempt racer, `responseDiscarded{preempted}` | IMPLEMENTED — NOT LIVE VERIFIED | E/10, F, 12, U; WebSocket `ResponseInterrupt::Drain` / bill settlement have no Futryn transport equivalent |
| Steer admission & reasons | `turn_input.rs::steer_input`, `steer` | `Conversation.steer` | PARITY VERIFIED | 10, 12, 24 |
| Pending input before next request | `turn.rs::run_turn` | drain + recheck | PARITY VERIFIED | 10, 11, 12, 19, G, C(Q) |
| Leftover input after finish | `tasks/mod.rs::on_task_finished` | `defer()`, `pendingInput`, `carried` | IMPLEMENTED — NOT LIVE VERIFIED | A/19, S+T — Futryn carries it into the next turn's input; Codex records it into history directly |
| Busy submission | `turn_input.rs::start_or_steer` | SDK `submitWhileBusy` + TUI | IMPLEMENTED — NOT LIVE VERIFIED | C+D, G — next turn is started by the client, not by core |
| `end_turn: false` follow-up | `turn.rs` `Completed { end_turn }` | `completed.endTurn` from Anthropic `pause_turn` | PROVIDER LIMITATION | H (Anthropic fixture). OpenAI chat/Responses and Gemini via AI SDK expose no such signal; Futryn never invents one |
| Budget at tool admission | `rollout_budget.rs::tool_start_denial` | `exhaustedWork()` in `run` | PARITY VERIFIED | budget re-check test |
| Missing outputs / no replay on recovery | `normalize.rs::ensure_call_outputs_present` | journal reconstruction | PARITY VERIFIED | 17, 18, K, S+T, durable-execution tests |
| Turn suspension (flush, no terminal event) | `turn_suspension.rs::suspend_turn_and_shutdown` | — | NOT IMPLEMENTED | Futryn has no worker hand-off; a dead owner becomes `interrupted` (ADR 0030), evidenced by S+T |
| Stop / after-agent hooks | `turn.rs::TurnCompletionHooks::run_stop` | artifact continuation (once) only | BLOCKED | Needs the hook/plugin framework, out of scope. Lifecycle contract for it: a stop handler may block once with a prompt; it must not fail the answer |
| Mailbox (inter-agent) preemption | `should_preempt_sampling_for_mail` | — | NOT IMPLEMENTED | No subagents/mailbox in Futryn (out of scope) |

No row is claimed as live-verified. **Docker**: all container tests ran against a real Docker 29.8.2 daemon with fixture models (not a live provider). **Live providers**: NOT VERIFIED — no authorized credentials were used. The 5 live scenarios (multi-round tools, failing test → fix → retest, steering, cancel during command, interrupted → resumed) are covered only by fixture models, partly with real containers.

## Decisions kept from the first iteration

Ownership: `send` is the task and owns one `ActiveTurn`; each iteration is one model request (`requests`), `round` counts completed responses (step budget), `attempt` counts retries. Steering is plain user text: it never changes mode, grants or approvals. The SDK refuses steering in `review` mode (Codex refuses Review tasks); inline-tool bridge runtimes are not steerable and their streams are never re-sampled once they acted.

## Remaining differences

- `end_turn` exists only where a provider exposes it (Anthropic `pause_turn`).
- Preemption closes the HTTP stream; there is no in-band drain/interrupt or billing settlement as on Codex's Responses WebSocket. Usage of a preempted response is not reported by the provider.
- Text completed before a tool call inside a preempted or retried response is discarded with the rest of the response (Futryn has no per-item completion signal for text); completed tool calls are kept.
- Running calls interrupted by cancellation are `EXECUTION_UNKNOWN` (Codex: `aborted by user after Xs`).
- `parallelTools = 4` bounds shared holders. Live `toolOutputDelta` progress is bounded (64 000 queued bytes, 128 events) and may drop deltas; final results are never dropped.
- Deferred input is carried into the next turn's input instead of being written into history at finish; the observable result (the next request sees it, once) is the same.

## Provider timeout is an idle timeout (2026-11-16)
Found in a real run (xAI `grok-4.7`, preset `timeoutMs: 60000`): the model was streaming a large `apply_patch` (a full HTML file) and the request was aborted exactly 60.02 s after `model.requested`, so the turn failed with `TIMEOUT` mid-file. `timeoutMs` was a whole-request deadline; Codex uses `stream_idle_timeout_ms` (silence between events). Now:
- Direct APIs (`packages/models/src/adapter.ts`): `timeoutMs` bounds waiting for headers and the gap between body chunks; each chunk restarts it. A model response may stream up to 64 MiB (the transport's 4 MiB default would cut large files).
- Subscription runtimes (`apps/cli/src/subscriptions/runtime-turn.ts`): the turn deadline restarts on every runtime message and is paused while Futryn handles an approval or runs a bridge tool; the ACP `session/prompt` request no longer has its own whole-prompt timer.
- Evidence: `tests/security/provider-failures.test.ts` "provider timeout bounds silence…" (fails before the change). Remaining limit: one tool call's arguments are still capped at 64 KiB.

## Code layout (refactor 2026-11-16, no behavior change)
The former 760-line `Conversation.send` is split along Codex's structure (`packages/core/src/agent/`):

| File | Responsibility | Codex counterpart |
|---|---|---|
| `engine.ts` | `Conversation`: history, steering, one turn at a time | `Session` |
| `turn.ts` | `TurnRun`: `begin` → per request `prepareRequest` → `sample` (`readStream`, `handleEvent`) → `prepareRetry` / `nextStep` → `complete`, or `failure`; `cleanup` always | `run_turn`, `run_sampling_request`, `try_run_sampling_request`, `needs_follow_up` |
| `turn-tools.ts` | `TurnTools`: budget refusals, shared/exclusive gate, journaling, reread check, ordered drain | `ToolCallRuntime`, `drain_in_flight` |
| `progress-queue.ts` | bounded live command output between events | — |
| `turn-types.ts` | `SAFETY_LIMITS`, options, shared state and host interfaces | — |

Generator subtlety kept explicit: when the caller closes the stream and closing the model stream fails, that error is the turn's outcome. Nested generators in closing mode would otherwise swallow it, so `readStream` marks `closedByConsumer` and `sample` rethrows (test: "closing the turn stream surfaces a failure…").
