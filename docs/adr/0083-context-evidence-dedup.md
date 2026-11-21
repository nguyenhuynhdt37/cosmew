# ADR 0083 — Deduplicate only evidence still visible after context preparation

Date: 2026-11-21. Status: accepted. Contract 1.41 (shared with ADR 0082).
No new package dependency, SQLite migration, permission change or default call limit.

## Evidence

The local 2026-11-21 audit reproduced six distinct reads followed by model
compaction: the original small result disappeared from the outgoing request,
but rereading it returned `[unchanged]` and instructed the model to use absent
evidence. Large reads had the opposite problem: each archive `put` minted a
fresh UUID, so otherwise identical producer bytes never compared equal.
Sources: `docs/audits/tool-calling-reasoning-coding-tools-2026-11-21.md`,
`packages/core/src/agent/turn-tools.ts`, `packages/core/src/agent/turn.ts`,
`packages/tools/src/orchestrator.ts` in the current working tree, inspected
2026-11-21. No new upstream parity claim is made; exact Claude CLI behavior
and real model quality effects remain **Needs verification**.

## Decision

Before every model request, after summary replacement and pressure clipping,
reconcile the current turn's reread map against the exact outgoing tool
messages, including attachments. Remove entries whose original full message
is absent or altered. Summaries, call IDs alone and retained archive markers
do not prove that the original evidence is still visible. An unchanged read
may be suppressed while the original full result remains visible. Otherwise
deliver the freshly authorized/read result again. We deliberately do not trust
old archive availability: retention, current permissions and storage failures
can change independently of visible history.

ToolResult gains optional host-owned `evidenceDigest` (SHA-256 of redacted
producer text, redacted attachments and producer truncation state before host
clipping/retrieval metadata) and `evidenceOutputId` (fresh successful archive
UUID). The dispatcher always computes/overwrites these fields rather than
accepting producer claims. Producer marker-looking text remains part of the
fingerprint; no regex removes text from canonical evidence. Injected ToolPorts
are trusted host adapters and must provide host metadata on the same terms;
ports omitting it retain exact content/media comparison.

Every reread still invokes ToolDispatcher and current policy, revalidation,
producer execution and audit. Digests are comparison hints, never grants or
execution caches. Changed media, changed bytes or changed truncation state
remain new evidence. An unchanged notice includes the current successful
archive handle, so it does not rely exclusively on an older possibly evicted
record. Small results, archive failures and clipping safely fall back to
visible evidence comparison or a full fresh result.

Journal call/result pairing, media side storage, write-denial behavior,
unknown mutation outcomes, receipts and stagnation accounting remain intact.
A restored result counts as evidence; a visible unchanged result retains the
existing stagnation behavior. Provider replay metadata travels with retained
assistant/tool groups; dropping an entire compacted group does not fabricate
replay state (ADR 0082).

The internal parallel-slot override now respects a configured lower limit:
absent/nonfinite values use the default four; finite values are floored and
clamped to at least one. Higher explicit limits still work. This does not
change descriptor shared/exclusive scheduling or permissions.

## Validation and limits

`tests/contracts/context-evidence-dedup.test.ts` records the original failing
small-reread, large-archive UUID and concurrency 1/2 cases, then validates
fresh restored evidence, archive retrieval, changed bytes/media, clipped/removed
history, current producer invocation and explicit slots 1/2/6. Existing model
compaction, archive and progressive exploration suites cover failure/no-gain
fallback, cancellation, pairing, permission revocation and long-task behavior.
These deterministic fixtures establish runtime invariants; no paid/live model
call, full-suite run or optimal latency/token/cost claim is included.
