# Subagent live assistant text

Implemented 2026-11-22 in `packages/agents/src/subagents.ts`, using the existing
`subagent.progress.steps` contract and injected child-run/event/store ports.
No executor, permission, dependency, public type or persistence schema was added.

Assistant deltas coalesce into one text step per provider response. A pending
update flushes every 100 ms, at the next response or tool-call boundary, and on
successful stream completion. Redaction sees the complete accumulated response
before the visible text is bounded to 4,000 characters. Live transcripts retain
at most 64 steps; unchanged text at the display bound does not broadcast again.
`inspectSubagent` uses the live scheduler projection while a task is registered,
so opening the child viewer during a turn has the same text as progress events.

`responseDiscarded` removes the provisional current response from both final
text and live steps, and emits the corrected projection when text was visible.
Earlier accepted responses remain. Completion keeps these text steps rather than
appending a duplicate aggregate summary. Cancellation/failure clears pending
text timers; a cancelled signal cannot publish a pending text update. Accepted
text already shown remains available in the terminal snapshot.

Consumers must replace their previous live transcript with each progress
`steps` projection. Appending cumulative text to previous content duplicates
prefixes and cannot implement discarded-response rollback. Worktree receipts
remain in the result summary, separate from the assistant response steps.

Validation: `bun test tests/contracts/subagent-live-text.test.ts
 tests/contracts/subagents.test.ts tests/contracts/subagents-s5c.test.ts`
(27 tests across three files after the final failure-cleanup test),
`bun run typecheck` initially passed before concurrent work. The final rerun
reported only concurrent `tests/end-to-end/subagent-live-provider.test.ts`
ModelEvent typing errors (lines 60, 63, 65 and 127), handed to the coordinator.
Prettier on the two changed TypeScript files and `git diff --check` passed.
The scripted child streams cover foreground/background updates, opening a live
snapshot, split-secret redaction within a batch, retry retraction, bounded bursts,
final deduplication, cancellation, failure and tool-boundary ordering.

Limits: this is deterministic manager/port evidence, not authenticated provider
or terminal acceptance. Redaction retains the injected redactor's semantics;
streaming prefixes cannot establish future characters of an unfinished secret.
The final result accumulator retains its existing behavior; only the exposed
live transcript and update frequency are bounded by this change.
