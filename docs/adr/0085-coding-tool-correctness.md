# ADR 0085: Coding-tool pagination, ordering and session transport correctness

- Date: 2026-11-21
- Status: Accepted
- Context: [tool-calling audit](../audits/tool-calling-reasoning-coding-tools-2026-11-21.md), ADRs 0061, 0067 and 0081.

## Decision

Text Read pages stop before a numbered line would exceed the existing 50 KiB
body budget. The continuation offset identifies the next unreturned line.
Per-line truncation remains explicit, including at page boundaries; clipping a
long line avoids leaving an unmatched UTF-16 high surrogate. The existing line,
file, output and media limits remain unchanged. This corrects continuation text,
without adding a cursor or changing the public JSON input/output contract.

Glob resolves modification times using an absolute candidate directly and joins
only relative candidates to the project root. Sorting still precedes the existing
100-result cap; trusted additional directories retain their existing authority
and filtering rules.

Owned stdin transport is offered by a session-capable runtime when its sandbox
is healthy or it supports host execution. Unsupported runtimes remain hidden.
The dispatcher health gate applies to new sandboxed launches, rather than input,
polling or interruption of an existing session. Runtime ownership, canonical
working-root checks, current permission decisions, original launch sandbox,
expiry revalidation and the runtime's original hard deadline remain in force.
There is no new launch fallback and no restoration of sessions after restart.
A host-capable runtime can therefore expose stdin even if new launches are
currently unavailable: an unknown/expired session still fails without execution.

The shell descriptor states the ADR 0081 defaults and conditional protections:
sandbox disabled, autoAllowBashIfSandboxed false, ordinary Bash permission checks;
containment and proxy protection apply only to sandboxed commands. An enabled
sandbox's explicit escape requires justification and separate approval, subject
to allowUnsandboxedCommands; with sandbox disabled the flag adds no escalation.
Login startup may read shell profiles under effective launch permissions; it is
not restricted to a trusted container image. No settings defaults or
authorization behavior change.

## Verification

`tests/security/coding-tool-correctness.test.ts` uses real filesystem fixtures for
ASCII/UTF-8 pagination and line markers, and 121 additional-root Glob candidates
with distinct mtimes, including the newest path beyond the alphabetical cap.
A runtime test double exercises host launch, poll, reviewed input, tightened
sandbox policy, interrupt, expired/unknown handles and a rejected new sandboxed
launch while backend health is false. This is dispatcher coverage, not proof of
native OS containment. Existing session-permission tests retain expiry during
approval, revocation, drift and input-review coverage.

No dependencies, public types or contract version changes. Exact Claude CLI
parity and non-macOS/live-provider behavior remain **Needs verification**.
