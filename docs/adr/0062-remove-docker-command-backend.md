# ADR 0062 — Remove the Docker command backend

Date: 2026-11-18. Status: accepted (user decision: the container backend is unnecessary). Supersedes the Docker option of [ADR 0032](0032-contained-command-sessions.md), [ADR 0034](0034-unified-exec-terminal-parity.md) and [ADR 0035](0035-native-sandbox-default.md). Those ADRs stay as history.

## Decision

`exec_command` and `write_stdin` run only in the OS sandbox: macOS Seatbelt, Linux bubblewrap. There is no container backend.

- Deleted: `DockerCommandRuntime`, the pinned `oven/bun` image, `scripts/build-exec-image.ts`, the container supervisor, and the execution-snapshot copier that only the container path used. `FUTRYN_COMMAND_BACKEND=docker` disables commands and says the backend was removed. `native` (default) and `none` stay.
- Kept: the Seatbelt and bubblewrap sandboxes, the network proxy, and `dangerouslyDisableSandbox`. A runtime that does not list `unsandboxed` still refuses that escape. `docker:*` in `excludedCommands` and `~/.docker/config.json` in the sensitive list stay: those are about the user's own `docker` CLI and its credentials, not a Futryn backend.
- Claude Code's everyday sandbox is Seatbelt or bubblewrap ([sandboxing](https://code.claude.com/docs/en/sandboxing), read 2026-11-18). Docker there is only an optional outer dev container. OpenCode runs shell commands on the host and gates them with allow/ask/deny ([permissions](https://opencode.ai/docs/permissions), read 2026-11-18). Needs verification against a running Claude Code or OpenCode.

## Consequences

`FUTRYN_TEST_CONTAINER` is gone. Linux bubblewrap remains implemented and untested on a Linux host.
