# Conversation recovery — implementation and acceptance

2026-11-16. Baseline `dev` at `196e72069f2450387ae8c01b4ebe6b8e7686cead`; [ADR 0030](../adr/0030-durable-conversation-recovery.md) contains the pinned Codex references, root causes, migration and security design. This report concerns runtime recovery; it does not assert new interactive Claude-style UI acceptance.

## Reproduction before and after

Deterministic model fixtures first read README, emit a partial plan for `Create helo.html, a beautiful standalone sales landing page.`, then time out or are cancelled. Before implementation, three focused tests failed: the next request lost original intent/read evidence, committed-only restart discarded the read, and missing write results were not made explicitly unknown.

After implementation, the accepted objective, partial plan and paired read survive in SQLite. After `tiếp` (or five other follow-ups), the next fixture request receives that evidence. A real Hannes fs.write prompt must be approved before the target exists. apply_patch creates the actual scratch-workspace file; read verifies exact content and HTML structure; only then does the fixture complete. Restart and compaction preserve the same behavior. A confirmed patch followed by transport failure yields one mutation audit total; continuation inspects the existing file. An intent followed by process exit without result remains unknown even when a file actually exists.

## Deterministic matrix

| Requirement | Executable evidence |
|---|---|
| A successful multi-turn | existing provider-adapters, progressive-exploration, Hannes agent matrix suites |
| B read → timeout → continue | contracts/runtime-recovery.test.ts |
| C read → plan → cancel | end-to-end/conversation-recovery.test.ts, Chat/router and Anthropic × six follow-ups |
| D patch → timeout, no duplicate write | confirmed-patch/transport-failure test, one mutation audit |
| E cancel awaiting approval | no file, no resumed grant |
| F transport failure then new turn | runtime-recovery + end-to-end continuation |
| G restart | actual child-process journal test + reopened SDK/database continuation |
| H compaction then continuation | context snapshot reuse after restart; real HTML outcome |
| I long constraints | all eight original constraints preserved and asserted in provider request |
| J changed goal | replacement.html created, helo.html absent; also explicit filename change after “continue” |
| K planning/read stalls | bounded STALLED, no promised file treated as completed |
| L invalid/missing results | wrong ID rejected, unknown synthesis, duplicate calls fenced before dispatch |
| M providers | Chat Completions/router-compatible and Anthropic end-to-end; existing Responses/Gemini/subscription fixture suites |
| N concurrent operations | second client denied while approval pending; active deletion denied |
| O corrupt/incomplete storage | sequence gaps, mismatched terminal state rejected; missing results explicitly unknown/not-executed |
| P fork | evidence copied, no effects replayed or grants restored, artifact verification reset |
| Q actual helo.html | exact file content, doctype/html/title/button/standalone CSS assertions |
| R “tiếp” preserves objective | checks model-visible original sales-page request, prior plan and tool evidence |
| S security | full suite includes existing apply_patch, permissions, workspace and subscription negative cases |

New suites: tests/contracts/runtime-recovery.test.ts, tests/contracts/durable-execution.test.ts, tests/end-to-end/conversation-recovery.test.ts. Preexisting uncommitted agent-continuation.test.ts was preserved and integrated, not discarded.

Focused acceptance: **39 pass, 0 fail**, 703 assertions across these three suites. Final validation: `bun run typecheck` passed; `bun run lint` passed; `bun test tests` completed with **493 pass, 5 skip, 0 fail**, 83,652 assertions across 43 files (65.97s). The five skips require native-vault/installed-runtime host configuration. Live authenticated providers and native-vault tests requiring explicit host configuration were not enabled. Process-exit tests are real Bun subprocess/SQLite tests; the uncertain-write case is fault injection, not a demonstration of exactly-once writes or production crash containment.

## Change map and migration

- Contracts: recovery.ts, sessions.ts, models.ts, events.ts, telemetry.ts, tools.ts, index.ts — contract 1.12, lifecycle/checkpoints, STALLED/budgets, historical scope binding.
- Core: agent/engine.ts, guidance.ts, progress.ts, context/builder.ts, compaction.ts, index.ts — owned loop, evidence capture, reconstruction, budget/compaction, task/progress controls.
- Persistence: database.ts, event-store.ts, session-store.ts, tool-audit.ts — schema4, ordered events, owner fencing, redaction, legacy merge, safe fork/delete.
- Composition/consumers: CLI bootstrap/startup.ts, subscriptions/host.ts; SDK client.ts; tools context.ts/orchestrator.ts — metadata/mode injection, canonical resume, unchanged mediation with scope-hash evidence.
- Tests: new recovery suites and focused compatibility updates to provider-failures, usage-context, agent-continuation, progressive-exploration, Hannes agent matrix, subscriptions and subscription fixtures.
- Docs: ADR0030, AGENTS, README, docs navigation, event/model/session contracts, ownership map and roadmap.

Schema 4 adds three journal/checkpoint tables and tool_audit.scope_hash; existing message/receipt rows remain readable. Newer unsupported schemas are rejected. Public contracts change additively; optional persistence methods keep legacy test ports source-compatible, but they do not gain crash durability automatically. No dependencies/packages added.

## Limits and next milestone

No filesystem/SQLite atomicity or exactly-once guarantee. Unknown effects need inspection; a new call requires fresh policy/revalidation. Credentials are redacted using existing known-secret machinery, not arbitrary secret discovery. SQLite remains local unencrypted data. PID reuse/ambiguous liveness fails closed. Extractive compaction retains all user requirements and may eventually hit CONTEXT_LIMIT; token estimates are conservative, not provider tokenizers. Native provider compaction is an extension point, not an implemented capability. HTML validation here is structural, not a full HTML5 validator. Full history is durable but journal retention/archival is not implemented.

Next milestone: explicitly authorized live-provider and interactive TUI acceptance for cancellation → restart → continuation, followed by broader crash fault injection (disk-full, power loss and approval/result-boundary failures). Production exec_command remains CLOSED until its separate containment requirements are met.
