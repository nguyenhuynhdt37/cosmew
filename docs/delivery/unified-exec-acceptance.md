# Unified exec terminal acceptance (Task 02) — 2026-11-16

Architecture, Codex mechanism comparison and limits: [ADR 0034](../adr/0034-unified-exec-terminal-parity.md). Codex pinned at `75fc67e8f4284a669eebd90ab6bc9ef7697e876e`. Baseline Futryn `dev` `9477700fd0f391ad5b0d30d4d38fe7dd84a6b542` + the preserved Task 01 truncation fix.

**Tested host:** Darwin 24.6.0 arm64, Bun 1.4.4, OrbStack Docker Engine 29.8.2 (linux/arm64, cgroup v2, default seccomp). Images: pinned `oven/bun@sha256:1d22548f…548f1d` and the locally built `futryn-exec:git-a4afd6a272866fcc` (git 1:2.47.3-0+deb13u1). No other host was available: standalone Linux, Windows and amd64 were **not** run.

**Model evidence:** deterministic fixture models only (Chat Completions transport through the real SDK/CLI/permission engine). No real GPT/Claude/Gemini run was performed for Task 02; nothing here claims real-model capability.

## Platform matrix (real evidence only)

| Feature | macOS native (Seatbelt) | Linux native | Windows | Docker backend (tested on macOS/OrbStack) |
|---|---|---|---|---|
| Read-only sandbox | BLOCKED (isolation probe passes; descendant containment fails — ADR 0022) | UNSUPPORTED | UNSUPPORTED | VERIFIED |
| Workspace-write | BLOCKED | UNSUPPORTED | UNSUPPORTED | VERIFIED |
| Exec approval | VERIFIED (dispatcher, injected runtimes) — runtime closed | UNSUPPORTED | UNSUPPORTED | VERIFIED |
| Process cleanup | SECURITY FAILURE (setsid descendant survives; hence closed) | UNSUPPORTED | UNSUPPORTED | VERIFIED |
| PTY / ConPTY | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | VERIFIED |
| write_stdin | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | VERIFIED |
| Network restrictions | BLOCKED | UNSUPPORTED | UNSUPPORTED | VERIFIED (none by default; approved escalation = bridge) |
| Workspace isolation | BLOCKED | UNSUPPORTED | UNSUPPORTED | VERIFIED |

"Docker backend on a Linux host" is IMPLEMENTED — NOT TESTED (same code path; uid/gid ownership semantics differ from OrbStack's permissive mapping and need a real Linux run).

## Task 02 test matrix → evidence

All rows run against the real engine (`FUTRYN_TEST_CONTAINER=1`) unless marked dispatcher.

| # | Requirement | Test |
|---|---|---|
| 1–6 | Bash create/modify, read tool, apply_patch, git diff, removal on the real host | `tests/security/unified-exec.test.ts` A |
| 7–11 | outside write, symlink (absolute and `..`), hardlink, Futryn state, secrets, engine socket | unified-exec B 7-12 |
| 12–14 | network denied by default; separate approval; refusal / `require_escalated` / `never` run nothing | unified-exec B 12-14 |
| 15, 32–35 | once vs session, stale grant under changed mode, change while pending, revoke | unified-exec B 15 / E 32-35 |
| 16–25 | exit 0/1, timeout, cancel, detached children, session ID, polling, stdin, SIGINT, no leftover containers | unified-exec C; container-execution suite |
| 26–31 | real PTY, input, interactive shell + Ctrl-C, resize, SIGTERM and lease cleanup | unified-exec D |
| 36–37 | restart never reclaims a session; old namespace ends at its lease | unified-exec E 36-37; container-execution owner-SIGKILL test |
| 38–39 | unknown outcome, no replay of uncertain mutations | existing `agent-loop-codex.test.ts` K/18, container-execution |
| 40–46 | model writes source with Bash → failing test → Bash fix → passing rerun → verified report | `tests/end-to-end/container-agent.test.ts` "Task 02 F" |
| server | background dev server as an owned session, stopped through it | unified-exec "F (server)" |
| stdin review | Codex stdin_approval semantics, long input | `tests/security/execution-session-permissions.test.ts` (dispatcher) |
| shell mode | `!command` through the same approval; denial runs nothing; not sent to the model | `tests/end-to-end/exec-command.test.ts` (dispatcher + TUI) |

## Performance (measured on the tested host)

| Measurement | Result |
|---|---|
| Availability self-tests, cold (3 probe containers) | 2.5–2.8 s |
| Availability, in-process cached / persisted proof | 0 ms / ~0.3 s |
| First command (`true`, workspace-write) | 0.55–0.83 s |
| Repeated commands | 0.45–1.5 s (container create + start dominates) |
| Time to first streamed output | ~0.37 s |
| Snapshot copy | removed (live bind mount); mask scan ~80 ms for 6.3 k entries |
| Host RSS with 4 retained sessions | 25 MB (each session is a container limited to 512 MiB) |
| Cleanup of 4 retained sessions | ~0.9 s |

The previous milestone's e2e latency bound (`< 7000 ms`, observed 7036 ms at baseline) now passes. Codex native spawns are not comparable in absolute latency; Futryn trades latency for kernel-namespace containment.

## Validation commands

Recorded in the final report of this task and in the commit message (exact exit codes).
