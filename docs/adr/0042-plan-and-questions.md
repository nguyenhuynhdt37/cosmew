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

## Evidence

`tests/end-to-end/plan.test.ts` (schema and invariants through the dispatcher, Plan mode offers the tool and no writes, durable plan after restart, rendered checklist, windowing and collapse).
