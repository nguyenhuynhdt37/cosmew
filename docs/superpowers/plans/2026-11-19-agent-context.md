# Agent context implementation plan

**Goal:** retain retrievable evidence and continue useful investigation across context pressure.
**Architecture:** contracts ports connect core, dispatcher and persistence; the CLI composes scoped archives. No new dependencies or security bypass.
**Spec:** ../specs/2026-11-19-agent-context-design.md

## Global constraints

All tool calls pass ToolDispatcher; deny/revocation wins. Persistence owns durable writes. No private cross-package imports. Keep unrelated worktree edits. Do not commit or change repository settings. Public changes require contract version and ADR. Live provider parity remains Needs verification.

## Tasks

- [x] Regression-first core: reproduce 87% early tool withdrawal; unify compaction trigger and continuation. Add failure/cancellation coverage and preserve paired history.
- [x] Regression-first archive: implement bounded redacted session-scoped persistence and dispatcher retrieval with policy revalidation, paging/search, no replay or cross-session access. Wire main/child roots and bump contract.
- [x] Preserve producer read pages; strengthen evidence-driven exploration guidance and compaction handoff references. Verify with multi-hop/middle-evidence integration tests.
- [x] Update ADR/contracts/runtime docs and run focused tests, typecheck, lint/checks. Review final changes for security, continuation and honest evaluation limits.

## Review focus

Archive handle is not an authorization grant; session switching and policy changes invalidate old access. Storage failure must not cause a successful write to repeat. Summaries must not drop the only evidence handle. UTF-8 paging must not corrupt content. Failed/no-gain compaction cannot loop forever.

## Review ledger

Core task review: spec compliance and quality clean. Final archive/integration review found two Important source-revalidation issues; both reproduced before fixes and now covered by regression tests. Fix wave 1: canonical source binding, initial policy snapshot and final synchronous revalidation; 10 archive tests / 27 combined security tests pass. Scoped re-review: both findings addressed, no new Critical/Important issues. Final `bun test tests`: 746 pass, 4 skip, 0 fail; typecheck and lint passed. No parked findings.
