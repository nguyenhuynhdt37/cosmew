# Agent context and evidence validation

Delivered in contract 1.37 / SQLite 8; current contract is 1.38 / SQLite 9 ([P1 delivery](tui-v4/p1-backend.md)).

Implementation: [ADR 0063](../adr/0063-retrievable-tool-evidence-and-context-continuation.md), contract 1.37. No new dependencies. At delivery, SQLite conversation schema stayed 8; output archive is a disposable bounded auxiliary table.

## Behavior available to users

With workspace tools enabled, the model receives `tool_output` alongside the existing read/search/edit tools. Long or producer-truncated captured output carries an opaque retrieval reference. The model can search that capture or request bounded pages; an omitted runtime byte is still explicitly unavailable. No startup flag or repository settings change is required.

Context pressure triggers compaction at 85% before tool withdrawal. A useful summary is remeasured and work continues with tools. Complete producer pages are preserved while the request fits. Recent paired evidence may be retained with a bounded allowance, while actual archive references survive handoffs. Explore and Plan children can retrieve their own evidence; parent/other-session artifacts remain inaccessible.

Archives are historical evidence. Current source rules, explicit tool rules, session/workspace identity and revocation state apply to retrieval. Old handles do not regain authority after host restart; reread the source under current permissions if necessary.

## Deterministic acceptance

- `tests/contracts/model-compaction.test.ts`: 87% pressure compacts before tools disappear, failed/no-gain/cancelled summaries remain bounded, paired recent evidence and archive references survive valid handoffs, UTF-8 clipping preserves complete code points.
- `tests/contracts/tool-output-archive.test.ts`: actual SQLite + dispatcher cover middle evidence, literal search, Unicode paging/progress, redaction, scoping, permission/grant changes, storage/retention bounds, and no source command replay. Regression-first security tests also cover once-approved secret sources replaced by safe symlinks, source deletion and allow-to-ask transitions during asynchronous authorization.
- `tests/end-to-end/progressive-exploration.test.ts`: requests captured at the provider wire boundary preserve the middle import that was previously lost. A subsequent request derives the dependency path from that evidence. A focused edit is read back and the changed function is executed to check whitespace handling and case sensitivity while unrelated files stay unchanged. An additional case searches an actual archive handle and follows its returned import.
- `tests/contracts/subagents.test.ts`: Explore/Plan can retrieve evidence without receiving write or command authority in analysis mode.

These scripted models use actual delivered tool results; they establish transport/runtime behavior, not that a real provider follows the prompt or achieves another agent's quality. Authenticated provider quality and comparative parity: **Needs verification**.

## Comparative evaluation recipe

Use the same provider model, reasoning setting, workspace revision, request and permission configuration. Compare before/after on dependency chains, misleading search matches, middle-of-log evidence, mid-task compaction, denied reads and interruption recovery. Score correct behavior, constraint retention and honest verification; record tokens, tool calls and latency as diagnostic data. Do not enforce artificial call counts or delays.

Final commands/results are recorded with the implementation handoff; intermediate broad failures caused by newly exposed tool lists and an outdated PTY layout assertion were corrected without changing their security expectations.


## Final verification — 2026-11-19

- `bun test tests`: **746 passed, 4 skipped, 0 failed**, 18,388 assertions across 92 files (273.18 s). Skips require installed real TypeScript LSP/native-vault or interactive terminal credentials and are not acceptance evidence.
- `bun run typecheck`: passed.
- `bun run lint`: passed (TypeScript unused checks, repository TypeScript/JavaScript formatting and `git diff --check`).
- Independent core review: spec/quality clean. Final integration review's two Important source-revalidation findings were reproduced, fixed and re-reviewed as addressed; no remaining Critical/Important findings.

No authenticated generation benchmark was run. Captured producer/runtime truncation remains explicit; the archive cannot reconstruct bytes that were never captured. Host restart invalidates prior handles. No user repository settings or credentials were written.
