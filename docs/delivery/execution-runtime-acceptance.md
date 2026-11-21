# Execution runtime acceptance — 2026-11-16

Started from Cosmew dev babdd502230166a4420803e24481ac6e003d24fc, not a historical Hannes checkout. Preserved untracked hello.html. First stage committed as 101b8d550d81582caca9aa259a3d3ad3192e470e. Architecture, exact upstream/image pins, platform support and limits: [ADR0032](../adr/0032-contained-command-sessions.md).

## Live acceptance

Previous milestone first: [real recovery/TUI acceptance](recovery-live-acceptance.md), xAI grok-4.7, native backend `hannes`. Actual create request, durable read, cancellation before creation, TUI restart/resume, “tiếp”, current fs.write approval, actual HTML file and read-back, final completed turn. A real partial-read verification guidance regression was found, reproduced and fixed. Harness SQLite/approval-label problems are distinguished from that product defect in the report.

New execution path also exercised through the actual Cosmew TUI and configured xAI API, not an injected runtime: final hardened-code session 069c773d-6a0d-4639-bc05-74a15a61ef76, exact command `bun run test && bun run build && bun run lint`, one current process.execute approval through the permission dialog, actual exitCode 0, test output and LINT_PASS, confirmed namespace teardown and completed model continuation. A disposable project used standalone Bun test/build/lint scripts; build output was confined to /tmp. No credentials were copied to logs/fixtures and no Codex loop was used.

## Executable matrix

| Area | Tests/evidence |
|---|---|
| Snapshot confinement | execution-snapshot.test.ts: internal aliases materialized; .env/.git omitted; external links/hardlinks/cycles/limits/cancellation denied |
| OS isolation | container-execution.test.ts: actual nonroot command, no host/state/socket/secret exposure, workspace/rootfs writes denied, external network denied |
| Ownership/lifetime | timeout, cancellation, leader exit with detached double-forked writers; fork burst bounded by PID limit; actual Cosmew subprocess SIGKILL followed by independent lease exit/Pid0, unrelated host process survives |
| Output | bounded stdout/stderr flood, preservation of stderr, small chunks delivered before exit, explicit cutoff, forged supervisor-frame text remains ordinary output |
| Supervisor privilege | malicious project Bun preload regression, protected root process environment/fds, actual zero-capability uid, trusted startup cwd/config |
| Sessions | real pipe input; separate approval; explicit SIGINT; uncollected deadline result remains pollable; stale/foreign runtime ID rejected; concurrent ownership guards |
| Permissions | execution-session-permissions.test.ts: lease-bound session grants, revocation, expiry during input approval, chunk-split secret/control redaction, unsupported Windows closed |
| Agent/TUI | container-agent.test.ts: Chat Completions and Anthropic fixtures → real permission engine → real container test/build/lint → streaming → tool result → model continuation; iterator close cancels and preserves actual result |
| Recovery/progress | running command is pending work, not successful verification; no execution replay from durable session IDs; existing recovery/security suites retained |

Real Docker tests are explicit: `COSMEW_TEST_CONTAINER=1 bun test tests`. Without that flag they skip; tests never silently pull an image. Fixture providers are deterministic transport evidence, not live-provider evidence. Real process/container tests use the production backend and pinned image. Native-vault/installed-runtime opt-ins remain separate.

Initial combined acceptance after plumbing: 29 pass, 0 fail across five focused suites. Full suite before the final preload hardening: 520 pass, 5 skip, 0 fail, 83,808 assertions / 48 files; typecheck/lint passed. The preload negative was then added, observed failing, fixed with trusted startup cwd/explicit config, and passed. Final hardened-code validation: **522 pass, 5 skip, 0 fail**, 83,816 assertions across 48 files (115.82s), with actual-container tests enabled. `bun run typecheck` and `bun run lint` passed. The five skips are the existing native-vault/installed-runtime opt-ins. Final native TUI/API acceptance was rerun successfully after supervisor and CLI bootstrap hardening. No production-readiness claim follows from a fixture or an isolation-only probe.

## Files and limits

Contracts: command-runtime.ts, tools.ts, models.ts (1.13). Tools: container runtime/supervisor, command/stdin handlers, shared result projection, orchestrator and registry composition. Workspace: execution snapshot plus descriptor-relative binary/directory facilities. Core: output pumping, cancellation ownership, task pending state/guidance. CLI: native runtime selection/callback forwarding and mediated bridge whitelist. TUI: bounded live output and accurate running/failed/session status. Four new execution/security suites plus recovery regressions; no SQLite migration or npm dependency added.

Unsupported: PTY/resize, arbitrary/custom images, host filesystem mutation/network, native unsandboxed shells, restored shell sessions/approvals, arbitrary long-lived background servers, automatic dependency installation. Linux standalone host/Windows live compatibility and shared Docker daemon restart fault injection remain unverified. Abrupt crash can leave stopped container metadata and private staging directories; the independent namespace lease bounds command lifetime, not immediate host filesystem garbage collection. Kernel/VM/daemon/image are trusted dependencies. See ADR0032 for differences from Codex and operational commands.

Final review also reproduced installed-CLI project preload before folder consent (harmless fixture exit 77). The global entrypoint and source scripts now disable project config/dotenv loading explicitly; the negative regression passes. This is executable-bootstrap hardening within the execution boundary, not a provider change.
