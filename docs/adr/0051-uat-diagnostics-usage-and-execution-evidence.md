# ADR 0051 — UAT diagnostics, usage and execution evidence

Date: 2026-11-17. Status: implemented; verification scope below.

## Evidence and decisions

The ledger UAT exposed three independent issues and an evidence gap:

1. The root TypeScript project's explicit `include` excludes standalone `uat-*` files. The real
   TypeScript 7 LSP therefore reported missing Bun/Node types in an inferred project, while an
   explicit compiler invocation with Bun types succeeded. Add a local UAT `tsconfig.json` extending
   the root config and including the two source files. Preserve genuine diagnostics; do not
   suppress errors or broaden the root project to every disposable file.
2. Turn totals already added input/output across requests without counting usage snapshots twice,
   but cache/reasoning/premium counters and the estimated-cost flag retained only the last request.
   Add those counters conservatively: an unreported part makes the total unknown. Preserve reported
   zero, including in provider adapters; absent usage is not zero. Label input/output separately in
   the footer and wrap it at narrow widths. `/usage` explains repeated input and distinguishes
   session totals, cache/reasoning subsets, billing and `/context` occupancy.
3. A retained native shell could exit and close its pipes before SIGKILL escalation, cancelling
   the escalation while an ordinary TERM-ignoring child survived. Complete requested group cleanup
   at the first owned leader-exit notification and fence subsequent signals using that observation.
   Report leader exit only when observed. This is POSIX best effort, not a kernel-stable process
   identity or a guarantee about arbitrary descendants. Keep macOS `descendants: unconfirmed`:
   `setsid` can escape the group. Do not add process enumeration or kill unrelated host processes.
4. A model's own report cannot independently establish the dispatcher path. Extend the headless
   UAT report with content-free evidence correlated from durable conversation events and the
   separate tool audit. Match call IDs/names, intent/result ordering, audit phases, outcomes and
   scope hashes. A matched scope hash is correlation, **not approval**; record the actual decision.
   Missing/duplicate records, unavailable storage or truncation do not verify the dispatcher.

## Contracts and ownership

Contract **1.23**: headless UAT JSON adds `contractVersion`, each observed tool call adds `callId`,
and each turn may add `evidence` (`scripts/uat/evidence.ts`). Evidence includes the session/turn IDs,
model-request count, journal/dispatcher verification, per-call checks/decision, and truncation or
unavailability indicators. The existing `ok`/exit-code meaning remains completion of requested turns;
consumers must inspect evidence separately. Older readers can ignore the added JSON fields.

The evidence projection exports no inputs, paths, file content or raw audit payloads. It limits the
audit read to 10,001 rows and the projection to 1,000 calls, and fails verification on overflow.
Final JSON passes through the existing credential-aware redactor, including the formerly raw
`prompt` field. Redaction cannot identify every arbitrary secret in human prose.

No SQLite migration, dependency, process boundary or sandbox/approval relaxation. Persistence owns
durable writes. The external UAT harness reads existing journal/audit evidence and invokes no tool
while verifying it. Shared usage/event shapes are unchanged; the counter changes correct their
existing semantics.

## Verification and limits

- Installed TypeScript 7.0.2 under real macOS Seatbelt: UAT diagnostics went from 7 errors per file
  to zero. A genuine TS2322 is still detected and clears on correction. UAT compiler check passes.
- Native retained cancellation: independently observe leader/ordinary-child exit and an unrelated
  host process remaining alive; reproduce the TERM-ignoring-child bug before the fix. A real
  escaped `setsid` child remains alive and is explicitly unconfirmed, then cleaned up by the test.
- Usage tests exercise duplicate snapshots, multi-request aggregation, unknowns, reported zero,
  local HTTP provider conversion and narrow TUI rendering.
- Headless driver tests use real core/dispatcher/policy/SQLite/filesystem with a local HTTP model
  fixture, both approval and denial. Denial creates no output file. Removing an audit record makes
  evidence incomplete despite the model's successful final prose. Known-secret report redaction
  is verified with a disposable marker.

These are local runtime and deterministic provider-transport checks. They do not authenticate the
previous UAT transcript retroactively, certify all possible bypasses, prove live model capability,
or change the documented macOS detached-descendant limit. Linux/Windows live behavior is
**Needs verification**. See the [delivery report](../delivery/uat-followup.md) for final command results.
