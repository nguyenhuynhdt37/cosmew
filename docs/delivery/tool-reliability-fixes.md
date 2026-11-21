# Tool reliability fixes — 2026-11-21

User-approved implementation of the five groups discussed after the
[audit](../audits/tool-calling-reasoning-coding-tools-2026-11-21.md).

## Scope and coordination

Five GPT-6.1 Sol medium implementation agents, three concurrent child slots.
Work is on the existing dirty `dev` tree; preserve all pre-existing changes.
No staging, commits, resets, repository settings writes, paid provider calls or
external agent processes. Regression tests precede production fixes. The root
integrates shared contract versions, reviews changes and runs final checks.

| Task | Owner | Scope | Status |
| --- | --- | --- | --- |
| 1 | fix_reasoning | Provider-bound reasoning replay; adapter/contracts/persistence | Implemented; identity-binding follow-up passed |
| 2 | fix_context | Visible/retrievable evidence, dedup, compaction and concurrency override | Implemented; 56 focused tests passed |
| 3 | fix_mcp | Safe MCP scheduling, validation, errors and output retrieval | Implemented; 33 focused tests passed |
| 4 | fix_coding | Read pagination, additional-root Glob, shell/session affordances | Implemented; 51 focused tests passed |
| 5 | fix_verification | Task-appropriate verification and recoverable-error guidance | Implemented; 50 focused tests passed |

## Integration decisions

- Use targeted edits in the shared tree because the authorized parallel work
  must include existing uncommitted changes. Never replace a shared file from an
  old snapshot or run global formatting while workers edit it.
- Task 1 owns contracts/models and persistence. Task 2 initially owns turn.ts;
  coordinate reasoning propagation and later task-5 edits through the root.
- Task 3 owns MCP handlers/client/hub and narrow orchestrator changes; task 4
  must not modify MCP files. Task 5 owns guidance; task 4 supplies any shell
  guidance requirements to it.
- Root owns shared contract version bump and consumer assertions. ADRs 0082,
  0083 and 0084 are allocated to tasks 1–3; 0085 and 0087 to tasks 4–5. Concurrent
  onboarding work owns ADR 0086 and is preserved.
- Preserve permission and sandbox invariants; no blind replay of denied or
  unknown-outcome mutations. Unknown MCP mutations default exclusive.
- Reasoning controls for new providers, cache pricing and comparative live
  benchmarks are outside these five corrective groups.
- Review caught schema keyword checks applying to ordinary MCP argument names;
  task 3 added a regression and schema-position-aware checks.
- Root added regression-tested SDK projections that omit private replay and
  child-context filtering that drops invalidated continuation after removing
  unanswered tool calls. The backend retains canonical state.
- Replay binds the account as well as provider/protocol/model/endpoint. A
  same-provider account-switch regression failed before that follow-up fix.
- Unsupported MCP schemas are absent from model descriptors: one unavailable
  tool must not break the provider's whole function-schema request.
- Failed command obligations are keyed to the attempted command; its later
  terminal success resolves them while historical failures remain visible. A
  different success, plan update or denied poll cannot erase an obligation.

## Verification

Workers supplied red/green evidence and root integration review added consumer
regressions. Final integrated checks passed. Concurrent onboarding/startup changes
were preserved; unrelated tool fixtures were updated to their public startup
interfaces without changing those production flows.
Fixture success does not establish live provider, model-quality or OS parity.

Initial typecheck was green before implementation. Root privacy regression
failed on leaked replay state before the SDK projection fix; the partial-child
regression failed before filtering invalid continuation. Focused checks after
those fixes passed, followed by the integrated runs below.

Integration also updated compaction fixtures to derive their input pressure
instead of relying on host-guidance word count. The 85% threshold, cancellation
and actual restart assertions remain. Tool fixtures use the supported explicit
login/public verification path and provision only first-run appearance steps
when onboarding is not the behavior being tested. Folder trust and actual tool
approvals remain exercised. The native review fixture waits for actual review
completion instead of assuming an asynchronous route is already finished.

Final verification on the integrated working tree:

| Command | Result |
| --- | --- |
| `bun test tests` | **989 pass, 8 skip, 0 fail**; 997 tests / 124 files / 19,890 assertions |
| `bun test apps/tui/src` | **538 pass, 4 skip, 0 fail**; 542 tests / 58 files / 8 snapshots |
| `bun run typecheck` | Passed |
| `bun run lint` | Passed, including unused checks, Prettier and `git diff --check` |

The final full test run includes actual macOS Seatbelt execution, failing test →
source repair → passing test, completed review, native PTY interaction and
continuous-stream responsiveness. Opt-in/native dependency skips remain explicit;
these checks do not certify live provider interoperability or non-macOS parity.

Public contract is 1.41; SQLite remains schema 10. ADRs 0082–0085 and 0087 record
the five decisions. No commits, staging or repository permission-setting writes
were performed. Complex MCP schema features outside the bounded supported subset
remain explicitly unavailable; historical discarded reasoning cannot be rebuilt.
