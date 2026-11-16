# TUI V2 implementation plan

Spec: user master task; design: ADR 0039. Execute in this session without approval
pauses or subagents (repository constraint). Preserve untracked HTML and existing
Agent Loop/security/session contracts. No dependency additions.

- [x] Audit latest Task 03+04; record baseline before product changes and pin references.
- [x] Add exact indexed TranscriptLayout, bounded cache and dirty-ID integration;
  verify equality with full renderer, scrolling, expansion, resize and eviction.
- [x] Migrate selection to lazy frozen document access; verify cross-screen copy.
- [x] Add coalescing frame scheduler, async UI invalidation and output backpressure;
  verify idle suppression, input priority, focus and cleanup.
- [x] Cache context readout; improve composer history/word editing and session drafts;
  retain real tool states and integrate wide diff panel without changing collection.
- [x] Run full suite, typecheck, lint, baseline-equivalent and stress benchmarks;
  exercise actual native PTY lifecycle on available host; review diff and commit.

Review focus: mutable streamed items must invalidate; frozen selection must survive
streaming; append must preserve anchors; narrow diff must preserve usable input;
async completion must paint without an idle redraw timer. Cold width measurement,
very large single-message layout and unverified platforms must remain visible in report.

Execution record: baseline recorded before product changes; failing no-reformat, durable-read,
keyboard selection and >1,000-row output tests were reproduced and fixed. Full suite caught
and then verified the asynchronous subscription-auth repaint fix. Final review was an author
self-review; independent/subagent review was not used. Scope gaps and partial performance
acceptance are explicitly recorded in report.md. No push.
