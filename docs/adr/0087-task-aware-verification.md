# ADR 0087 — Task-appropriate artifact evidence and recovery guidance

Date: 2026-11-21. Status: Accepted.

## Context

The local audit (`docs/audits/tool-calling-reasoning-coding-tools-2026-11-21.md`,
2026-11-21 working-tree inspection) found a universal HTML/full-file-read correction
applied to source edits, while a nontruncated read could count as completing an
unperformed modification. Guidance also declared every failure final and described
sandboxing as always enabled. These are Cosmew heuristics; exact upstream parity
and live model-quality comparisons remain **Needs verification**.

## Decision

Core tracks successful per-target mutation receipts separately as `changed:<path>`.
They prove an observed artifact action, not that its behavior passed a test. A plain
source read cannot satisfy a requested modification, and a successful command
cannot stand in for a missing target receipt. Deleted targets lose prior evidence.
Successful source changes do not trigger a universal full-file reread. Guidance
still requires appropriate behavioral checks and preserves explicit verification
requests, actual final exit status, and honest reporting of unexecuted checks.

New HTML document creation additionally retains complete-document content evidence
(`verified:<path>` after the change). Incomplete HTML gets one corrective continuation
that asks for missing document ranges and an authorized repair where needed; it
does not prescribe a fixed offset/limit for every target. Focused modifications to
existing HTML fragments do not require converting them into standalone documents.
Explanation/review/verification-only objectives do not enter this mutation workflow.

Observed unresolved command checks and running sessions keep the task unfinished
even after an artifact receipt. Check obligations use a SHA-256 identity of command,
working directory and shell; only a successful final exit for the same identity
resolves a failure. A later unrelated command cannot clear it. Session obligations
retain that identity through polling and disappear only after actual final status;
a denied or failed poll does not attest completion. Historical failures remain in
the checkpoint. Obligations survive plan updates and are bounded to 64 entries,
with a conservative unresolved overflow marker if detail is lost. Historical lookup/cancellation failures remain visible during
recovery; confirmed changes and inspection can complete the recovered artifact
without erasing the failure history. Checkpoint `verified` remains a task-progress
state, not an assertion of OS compatibility or successful behavioral testing.

Correctable validation/path/read failures may be corrected from evidence. A denial
must never be bypassed via another tool/path/command; unknown mutation outcomes
require inspection and must not be blindly replayed. Dispatcher permission and
mutation guards remain authoritative and unchanged.

Guidance reflects ADR 0081: sandbox disabled by default, normal permissions always,
containment only when enabled, `autoAllowBashIfSandboxed` false unless configured,
and deny/ask rules still win. Explicit escape of an enabled sandbox always prompts;
the ordinary sandbox-disabled command path is not an escape.

No new dependencies, public fields, events, schema or contract version are added.
The auxiliary checkpoint already stores free-form bounded action statuses.

## Verification and limits

Focused deterministic tests cover TS/Go changes with finished checks and no forced
read, unchanged source reads, missing target receipts despite a successful command,
failed/running checks, read-only objectives, and correctable invalid lookups. The
HTML regression now creates a real incomplete file, observes partial content,
repairs it, and inspects the complete result. Existing recovery tests retain denial,
unknown-outcome, cancellation, restart and no-write-replay coverage. These fixtures
verify host behavior, not live provider interoperability or comprehensive HTML
semantics. No generic command-to-artifact behavioral proof is inferred.
