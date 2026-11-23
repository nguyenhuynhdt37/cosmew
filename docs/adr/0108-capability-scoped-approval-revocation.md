# ADR 0108 — Capability-scoped approval revocation

Status: Accepted
Date: 2026-11-22
Introduced in contract 1.55; current shared contract 1.56 includes concurrent GitHub authentication work. SQLite schema unchanged

## Context

The maintainer observed write refusal without seeing an approval prompt, with sandbox disabled. The tool returned “Permissions were revoked while approval was pending”; UI labelled it “User rejected Write” and the turn refused all later writes. The maintainer explicitly requested source fixes without killing/restarting their running Hannes/Cosmew or modifying live user state.

A deterministic reproduction identified an overbroad path: MCP manager mutation/identity broadcasts called SDK invalidation that denied all pending permissions, cleared all dispatcher grants and cancelled pending plan approval. If this ran between enqueuing a file request and the next React render, the write prompt disappeared before presentation. The original historical event's initiator cannot be reconstructed from existing logs; this reproduces the same symptom and is a confirmed independent cause.

## Decision

- MCP invalidation denies only pending `mcp.call` requests, clears only MCP session/prompt-cache grants, and preserves unrelated filesystem/shell approvals and plan proposals.
- `SessionGrants.clear(capability?)` supports scoped revocation. `generationFor(capability)` uses absolute monotonic revisions and a global-clear baseline, avoiding collisions after interleaved scoped/global clears. Existing `.generation` remains monotonic across every revocation for conservative archive invalidation. Parent revocation propagates to child scopes.
- SDK `toolGrants.clear(capability?)` is updated and the CLI composition forwards the scope. Global mode/rule/session/sandbox revocation still clears all relevant authority; no permission is silently granted.
- A stale dispatcher approval returns `status: denied`, diagnostic `APPROVAL_REVOKED`, without mutation. It never executes using an old answer. This diagnostic is not a user denial and does not latch all subsequent file writes. Any new model call repeats complete validation, current policy and fresh approval.
- Genuine user/policy denials retain the existing per-turn write stop. There is no automatic replay or SDK-only reauthorization of a stale multi-file patch: current per-file ask/deny rules must be evaluated by a fresh dispatcher call.
- Transcript labels use “needs a new approval” for system revocation and neutral “denied” otherwise, rather than inventing a user decision for every denied result. Fixed audit reason `approval-revoked` records the stale decision without logging arbitrary exception text or new sensitive payloads.

Contract 1.55 versions the optional capability argument on the SDK host port and scoped grant API. No database migration or new dependency is introduced; current consumers and version assertions are updated. Earlier ADRs retain their historical version numbers.

## Related observed behavior

The permission dialog's accept-edits choice resolves once then changes the mode. The mode change invalidates the epoch before the dispatcher resumes. The old request must not execute; it now reports revocation without locking every later write. Blindly repeating the old SDK approval request could miss newly added per-file ask rules for joined patch targets, so that shortcut is explicitly excluded. Existing read-before-write requirements are preserved.

## Verification and process constraints

Regression tests use temporary workspace/state, real SDK/dispatcher/core loops and actual keyboard rendering. They cover unrelated pending file approvals surviving MCP mutation and cross-client manager broadcast; actual MCP approval/grant revocation; global mode/rule changes; epoch ordering and child propagation; explicit denial versus revocation; fresh authorization without replay; plan restrictions, evidence and usage; and an MCP invalidation before the next frame still showing the write approval dialog.

No live CLI process is killed, restarted, injected or hot-swapped. No user credential/database/settings file is modified by this work. Source changes load in a new process; an existing non-watch Bun process retains already-loaded modules. Tests keep the real-state guard enabled; concurrent live sessions may cause that guard to report unrelated real-state changes, which must not be suppressed or repaired by restoring the database.

## Final targeted acceptance

`bun test` across the two new isolation/latch suites, SDK permission settings, MCP manager/execution, transcript/UI integration and headless contract suites: **132 passed, 2 skipped, 0 failed**, 965 assertions across nine files. The popup regression proves an MCP invalidation before the next React frame leaves the file prompt visible and waits for explicit approval. Typecheck, formatting of every file owned by this fix, and diff checks passed. Repository-wide lint encountered formatting in concurrently edited `bootstrap/commands.ts`, `workspace/agent-definitions.ts` and `workspace/skills.ts`; those unrelated in-progress edits were not reformatted to manufacture a green global gate. An earlier broader worker run detected real user-state metadata changing while live sessions were active; the guard stayed enabled and real state/processes were untouched.
