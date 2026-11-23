# ADR 0098 — Standalone summary billing and known cost bounds

Date: 2026-11-22. Status: accepted. Contract 1.50; SQLite schema 12.

Audit item 2 and independent review sections 3.2/3.3/3.7 found three gaps:
summary billing vanished when a fork/rewind session had no agent receipt;
cancellation could discard an already yielded provider usage event; child budget
checks ignored known charges whenever another request had unknown pricing.

`SessionRecord.additionalUsage` contains billed requests that could not be folded
into an agent receipt. Persistence stores this aggregate in `session_usage`, keyed
by conversation with cascading deletion. `addUsage` runs its receipt lookup and
aggregate update in one immediate transaction, skips user-shell receipts, and
stores a validated/redacted standalone aggregate if no agent receipt exists.
Existing agent-receipt accounting remains unchanged. Standalone usage is never
moved into a later receipt and is never copied with fork/rewind context. Thus
history, message revisions and agent turn counts remain accurate; source sessions
retain their actual charges. Schema 11 upgrades additively; future versions fail
closed. Older binaries reject schema 12 instead of silently dropping its usage.

SDK usage summaries include standalone counters, source costs and quota snapshots
without counting them as turns. Source grouping uses zero turns for standalone
usage. Aggregate unknown counters remain unknown; reported/estimated source costs
remain visible. The optional field is backward compatible for older records and
ports, and headless envelopes now advertise 1.50.

`knownCostUSD` in contracts returns the aggregate cost when known, otherwise the
sum of known breakdown costs (a lower bound, never aggregate plus breakdown).
Core work budgets and child reservation/inheritance/sibling-stop checks share it.
Unknown pricing still stays unknown in persisted telemetry. Cancellation captures
and persists an already yielded usage/completed snapshot before refusing any
further content/tool effects, preserving request snapshot replacement semantics.

Evidence: `tests/contracts/standalone-usage.test.ts` uses actual SQLite reopen,
receiptless fork, shell-only session, later agent/source billing, deletion,
schema migration/rejection, cancellation races and child cap checks. Existing
compaction/checkpoint/attribution suites cover summary failures and no duplicate
snapshot billing. Fixture evidence only; no paid provider calls.
