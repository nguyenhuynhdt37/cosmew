# ADR 0035 — Native OS sandbox by default (Codex model); Docker optional

Accepted 2026-11-16 on the user's explicit decision ("làm native support all hệ điều hành", confirmed after the trade-off below was stated). Amends [ADR 0034](0034-unified-exec-terminal-parity.md) and reverses the closed macOS gate of [ADR 0022](0022-sandboxed-exec-command-foundation.md)/[0032](0032-contained-command-sessions.md). Codex reference pinned at `75fc67e8f4284a669eebd90ab6bc9ef7697e876e` (`sandboxing/src/seatbelt.rs`, `bwrap.rs`).

## Decision
- `FUTRYN_COMMAND_BACKEND` = `native` (default; `auto` is an alias) | `docker` | `none`. Docker (ADR 0034) stays as an explicit option.
- **macOS:** `NativeCommandRuntime` runs the shell under `/usr/bin/sandbox-exec` with a generated profile: system and toolchains readable; `/Users`, `/Volumes` and the home directory denied except the workspace (and PATH toolchain roots under home, e.g. `~/.bun`, `~/.nvm/...`); writes only to the workspace (workspace-write), `/private/tmp` and a private temp/home; `.git` never writable; `.futryn`/`.hannes`/patch temporaries and Futryn's state directory denied; `network*` denied unless the command's network escalation was approved. Environment: Codex `UNIFIED_EXEC_ENV`, the host PATH, private `HOME`/`TMPDIR`; nothing else inherited.
- **Linux:** bubblewrap (`--unshare-pid --die-with-parent --new-session`, read-only root, home on tmpfs, writable workspace bind, read-only `.git`, masked state, `--unshare-net` unless approved). **Implemented — not tested** (no Linux host). Without `bwrap` commands are refused.
- **Windows:** not implemented; commands are refused (no unsandboxed fallback).
- Sessions, PTY (Bun `terminal` on the host), `write_stdin`, approvals, stdin review, revalidation and `!command` are unchanged from ADR 0034 and shared by both backends.
- **Secret files:** readable by commands by default, as in Codex, because toolchains load `.env` themselves (measured: `bun test` fails with EPERM when `.env` is denied). `FUTRYN_SANDBOX_HIDE_SECRETS=1` denies them (inside the project only; `/etc/ssl/cert.pem` etc. stay readable) at the cost of breaking such tools.

## Accepted trade-offs (stated to the user before acceptance)
- **macOS descendants:** the process group is killed on timeout/cancel (SIGTERM, then SIGKILL), but a process that calls `setsid` can outlive the command — same as Codex. Results therefore always report `Descendant termination: unconfirmed` on macOS; bubblewrap's PID namespace reports `terminated`.
- Reads outside `/Users` are broad (system, `/private/var/folders`, other tool caches), as in Codex.
- Secrets readable by default (see above); network still off unless approved, and the model only sees what commands print.

## Evidence (Darwin 24.6.0 arm64)
`tests/security/native-exec.test.ts` (8 tests, real Seatbelt) and `tests/end-to-end/native-agent.test.ts` (fixture model → Bash write → failing test → Bash fix → passing rerun). Measured: self-test 73 ms, write command ~105 ms, repeated commands ~25 ms (Docker: 0.45–1.5 s). See [acceptance](../delivery/unified-exec-acceptance.md).
