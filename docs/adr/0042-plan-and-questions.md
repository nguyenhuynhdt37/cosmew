# ADR 0042 — `update_plan` and `request_user_input`

Date: 2026-11-17. Status: accepted (wave 1 plan W2, W3).

## Context

The model had no structured way to show its plan or to ask the user a question. References (read 2026-11-17, behavior only, no code copied): Codex openai/codex @ `090be4df0724cdef5758e6a0934ba557af8b6bbe` `core/src/tools/handlers/plan_spec.rs`, `plan.rs`, `request_user_input_spec.rs`, `tools/src/tool_config.rs`; OpenCode `sst/opencode` @ `0ac0d7ee` `packages/core/src/tool/plugin/todo.ts`, `question.ts`, `plugin/agent.ts`; Claude Code's public TodoWrite / AskUserQuestion behavior.

## Decision — `update_plan` (W2)

- Schema (Codex): `{explanation?, plan: [{step, status}]}`, at most one `in_progress`; plus `cancelled` (OpenCode) and `activeForm` (Claude Code); at most 50 steps. Invalid input never changes the plan. The result is a count summary (OpenCode) after Codex's "Plan updated": `Plan updated: 1/4 completed, 1 in progress, 1 pending, 1 cancelled.`
- New capability `agent.state` (contract 1.19), `parallel: false`. It goes through the dispatcher (validate → audit `agent-state` allow → execute); there is no approval because nothing outside the session changes. The tool is offered only when the composition root wires session state.
- The plan is durable per session (`session_plan`, schema 6), replaced as a whole, restored with the session; the SDK exposes `client.plan()` and a `plan.updated` notification that does not replace the activity state.
- The task checkpoint's pending list follows the plan (`core/agent/progress.ts`) instead of the heuristic.
- Plan and Review modes now offer `fs.read`, `code.intel`, `agent.state`, `user.input`, `network.search` and `network.fetch` tools (`ANALYSIS_CAPABILITIES`), never writes or commands.
- TUI (`features/plan`): a checklist pinned above the composer (`✓` completed, `▸` running, `○` pending, `✗` cancelled; at most 8 rows keeping the running step visible; one summary line once everything is settled); the running step's `activeForm` replaces the spinner label; transcript `⏺ Plan(1/4 completed)`.

## Decision — `request_user_input` (W3)

- Schema (Codex): `{questions: [{id (snake_case), header (≤ 12 chars), question, options: [{label, description}]}]}`, 1–3 questions, non-empty options, the client adds a free-form "Other" (an "Other" option from the model is refused); plus `multiple` (OpenCode). Recommended options first with "(Recommended)" (Codex/OpenCode wording in the description).
- Capability `user.input`, `parallel: false`; through the dispatcher (audit `user-input` allow), no approval. Offered in Chat and Plan mode (Codex enables it in Plan mode by default and in Default mode behind a flag; the plan asks for both). It is offered only while an interactive UI is attached (`client.setUserInputAvailable`, set by the TUI); a non-interactive run never offers it, and a call without a UI returns `UNAVAILABLE`. There are no subagents in wave 1; when they arrive (W9) they will not get this tool.
- Result: Codex `{"answers": {id: {"answers": [...]}}}` (labels or the user's text). Esc dismisses (OpenCode): the model gets "The user dismissed this question…" and continues. Answers are text only and never grant a permission. Aborting the turn removes the question and cancels the call. The answer is the tool result in the durable journal, so a resumed session never asks an answered question again.
- SDK: `listPendingQuestions`, `answerQuestion`, `dismissQuestion`, notifications `question.asked` / `question.answered`.
- TUI (`features/question`, `Modal`): one tab per header (←/→), options with descriptions, number keys or ↑/↓ + Space, `[x]` toggles for multiple choice, an "Other" row that takes typed text, Enter submits once every question is answered, Esc dismisses; transcript `⏺ Ask(Database, Checks)`.

## Evidence

`tests/end-to-end/plan.test.ts` (schema and invariants through the dispatcher, Plan mode offers the tool and no writes, durable plan after restart, rendered checklist, windowing and collapse); `tests/end-to-end/question.test.ts` (single/multiple/Other answers as Codex JSON, dismissal, cancellation, non-interactive, invalid input, restart).

Continuation review (2026-11-17): plan explanation/step/activeForm are redacted
before the durable-state callback, and pending question header/question/option
label/description are sanitized before SDK/UI exposure. IDs retain their stable
mapping; selected labels and model-visible answers consistently use the displayed
sanitized label. Rule additions/removals revoke both dispatcher and prompt grants,
so a previously approved network search cannot bypass a newly added deny. Rule
restrictions (adding deny/ask or removing allow) also deny and settle every
unresolved prompt; an old dialog cannot approve an operation after policy
tightened. Adding allow preserves the normal “don’t ask again” flow and unrelated
pending requests. The session mode/delegation are not reset.
