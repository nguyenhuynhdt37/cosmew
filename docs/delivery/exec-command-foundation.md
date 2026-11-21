# Task 03A — exec_command foundation and security gate

**Production gate: CLOSED.** The unfinished Claude work has been brought to a reviewed foundation with executable acceptance evidence. This is not an enabled shell feature or full Codex compatibility. The user's Task 03A explicitly requires stopping before enabling when mandatory sandbox/lifecycle guarantees cannot be met. [ADR 0022](../adr/0022-sandboxed-exec-command-foundation.md) records scope, pinned upstream source audit and contract 1.8 migration.

## Verified blocker

On macOS 15.8.1 (24H32), Bun 1.4.4 and installed ripgrep 15.2.0, real `/usr/bin/sandbox-exec` allowed targeted `rg`/`nl | sed` reads and denied workspace writes. A disposable Perl child that forked, called `POSIX::setsid()` and slept survived the candidate's process-group/ps-descendant cleanup after its parent exited. The acceptance test asserts that failure, kills the disposable child in finally, and verifies production availability remains false. A passing regression test of this negative evidence is **not** a passing mandatory security gate.

`platformCommandRuntime` cannot advertise execution on macOS. Linux and Windows return unsupported runtimes; no Linux OS execution acceptance is claimed on this macOS host. No environment variable enables the candidate. No unsandboxed retry exists. Existing read/glob/grep remain offered after workspace consent. Codex native shell and unified_exec remain disabled; Copilot/ACP tools remain unavailable.

## Implemented foundation

- A strict one-shot command schema: cmd, optional workdir, bounded timeout_ms/max_output_tokens only. No fake session IDs or ignored tty/yield_time_ms/stdin parameters. A nonzero command exit is preserved and shown as Failed, not retried automatically.
- Contracts own CommandRuntime and serializable request/outcome records. Tools owns private process helpers, combined stdout/stderr head/tail capture, terminal cleaning and the experimental Seatbelt candidate. No new dependencies or package edges.
- Dispatcher validates/canonicalizes cwd, evaluates process.execute, asks for an exact command/cwd/sandbox decision, audits and revalidates before launch. File-read grants do not confer execution. SDK scope hashes include the raw effective binding; session revocation clears both SDK and dispatcher caches. Approval expiry/denial/cancellation cannot authorize a launch.
- Explicit child environment, bash --noprofile --norc inside the wrapper, no inherited credentials or project startup scripts. The candidate denies writes/network, state directory, .git and secret filenames. It retains explicit system-runtime read exceptions; tests establish only the listed policy cases, not exhaustive host isolation or safe dependency loading.
- Output capture copies only retained bounded bytes, preventing slices from pinning oversized buffers. Formatting strips terminal sequences before redaction/model delivery. Existing redaction is retained; promotion must also review secret fragments at head/tail truncation boundaries rather than claiming exact secret-flow confinement from these fixtures.
- TUI shows the actual sanitized command, waiting for approval, pending result, Ran/Failed/Stopped and an output preview. A proposal/approved command is not called Running without a process-start event. Live process-start telemetry is not implemented in this gated foundation. Resume reconstructs exit status only from the host-generated initial header, preventing output text from forging success.

## Acceptance matrix

| Requirement | Evidence |
| --- | --- |
| rg discovery and nl/sed pipeline | Actual Seatbelt processes, exit 0, exact source marker. |
| Nonzero exit and missing executable | Actual exit 7 and shell exit 127; no invented success. |
| Invalid/outside cwd and symlink escape | Dispatcher resolution failures before launch; actual sandbox denies symlink file read. |
| Denial, cancellation before launch, expiry | Dispatcher/SDK/TUI fixture decisions; execution counter stays zero. |
| Cancellation/timeout during execution | Actual sandboxed sleep child killed with its ordinary process group. Detached cleanup fails separately as documented. |
| Large stdout/stderr | Actual output flood is bounded with a counted omitted middle; head/tail buffer invariants checked. |
| Terminal controls and output metadata | Sanitized command results through actual app/provider fixture and resumed transcript. |
| Workspace write, outside read, sensitive files, state and .git | Real denied OS operations with disposable files. No real credentials used. |
| Network, including localhost | Real curl attempt to a disposable loopback listener fails; listener receives zero requests. |
| Environment leakage | Disposable host-only sentinel absent from child environment. |
| Sandbox initialization failure | Missing wrapper returns spawn-failed/SANDBOX_FAILED; no fallback. |
| Direct-provider and Codex bridge pairing | Injected deterministic command runtimes traverse dispatcher, approval, events, stored history and resume. Native Codex shell remains disabled. |
| Real COSMEW exploratory command | Research-only injection routes approved `rg -n marker source.ts` through the TUI and actual Seatbelt. Returned source marker/exit 0 verified; project contents and directory listing unchanged. This explicitly bypasses only candidate eligibility inside the test harness and does not enable the production tool. |
| Production feature exposure | On all platform selections, exec_command is omitted; unsolicited calls do not launch a process. |
| Existing budgets, permissions, sessions and TUI | Full regression suite, including reviewed golden changes for the permission manager's unavailable-command notice. |

## Executed checks

2026-11-15: `bun run typecheck` and `bun run lint` passed. Focused `bun test tests/security/exec-command.test.ts tests/end-to-end/exec-command.test.ts`: **19 pass, 0 fail**. Full `bun test tests`: **332 pass, 5 skip, 0 fail** across 31 files. The five pre-existing skips require native vault/installed-provider or real login and are not counted as verified. Both changed permission golden frames were reviewed; other overlay frames stayed identical.

A reliable containment/supervision design that survives setsid/reparenting is required before production exposure, together with renewed OS security acceptance and review of the candidate policy/runtime dependencies and truncated-secret handling. Persistent PTY, write_stdin, apply_patch, workspace writes, MCP, plugins and code-intel remain Not implemented. No live provider compatibility or billing/model-understanding claim is made. No new task was started.

## Exact changed files
- `AGENTS.md`
- `CLAUDE.md`
- `apps/cli/src/bootstrap/startup.ts`
- `apps/cli/src/subscriptions/host.ts`
- `apps/cli/src/subscriptions/project-context.ts`
- `apps/tui/src/features/chat/view.ts`
- `apps/tui/src/features/permissions/view.ts`
- `apps/tui/src/features/transcript/index.ts`
- `apps/tui/src/features/transcript/logic.ts`
- `apps/tui/src/features/transcript/view.ts`
- `docs/README.md`
- `docs/adr/0022-sandboxed-exec-command-foundation.md`
- `docs/architecture/dependency-rules.md`
- `docs/architecture/repository-map.md`
- `docs/contracts/model-provider.md`
- `docs/contracts/tools-and-permissions.md`
- `docs/delivery/exec-command-foundation.md`
- `docs/delivery/implementation-roadmap.md`
- `packages/contracts/src/command-runtime.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/models.ts`
- `packages/contracts/src/tools.ts`
- `packages/core/src/agent/guidance.ts`
- `packages/sdk/src/client.ts`
- `packages/security/src/tool-policy.ts`
- `packages/tools/src/dispatcher.ts`
- `packages/tools/src/exec/command.ts`
- `packages/tools/src/exec/output.ts`
- `packages/tools/src/exec/process.ts`
- `packages/tools/src/exec/runtime.ts`
- `packages/tools/src/index.ts`
- `tests/contracts/__golden__/tui-overlays.json`
- `tests/end-to-end/exec-command.test.ts`
- `tests/end-to-end/progressive-exploration.test.ts`
- `tests/end-to-end/project-context.test.ts`
- `tests/end-to-end/read-tools.test.ts`
- `tests/security/exec-command.test.ts`
- `tests/subscription-fixtures/runtime.ts`
