# ADR 0023 — Task 03B process supervision and evidence

Accepted 2026-11-15 by the user's explicit Task 03B request, starting from dev/88ff47e. Scope: process ownership, bounded drainage, lifecycle reporting and adversarial tests only. Production exec_command stays CLOSED. No native helper/dependency, persistent sessions, PTY, write_stdin, writes, MCP or unrelated tools.

## Source-first decision

[Upstream source audit](../delivery/process-supervision-research.md) pins Codex `ee344ca9458351a6ea102795fa73110ad3ede5dc` and traces preparation -> sandbox -> owned child/session -> cancellation -> termination request -> bounded output drain -> identity-checked release. Codex's process-group helpers explicitly say best-effort. Neither killpg nor their macOS member fallback is evidence that a setsid/reparented descendant is contained. Linux bubblewrap's PID namespaces are a distinct kernel boundary; PR_SET_PDEATHSIG protects a configured direct child, not every descendant. No Rust/native helper is copied.

Task 03A's exact failure was reproduced before edits: fork -> setsid -> original parent exits -> child reparented -> original group and ancestry no longer cover it. Existing negative acceptance remains mandatory and is strengthened with independent ps identity/state observations; kill(pid,0) alone is insufficient.

## Threat model and boundaries

The approved command may adversarially fork, detach, reparent, hold pipes, race cancellation or survive an application crash. It cannot receive ambient secrets or lose its inherited sandbox. Host process IDs can be reused after reaping. No unverified PID list, shell filtering, polling or group enumeration is an enforcement boundary. Unrelated processes must not be signalled.

macOS Seatbelt is access confinement, not a demonstrated lifetime container. launchd's documented cleanup is group-based. XNU no longer supports NOTE_TRACK descendant tracking; observation is not containment anyway. Endpoint Security requires a separately granted entitlement and is not a verified kill-on-supervisor-death container for this application. No appropriate unprivileged native boundary has been demonstrated on this host; this is not a claim that all possible macOS deployment architectures are impossible.

Linux PID namespace init death can terminate namespace members across setsid/reparenting. Cgroup v2 provides membership independent of groups plus cgroup.kill and populated events, but requires trustworthy delegation, atomic enrolment before untrusted execution, no ability to migrate out, stable handles, and external crash ownership. A cgroup alone does not automatically die with its userspace owner. No host-native Linux runtime is enabled by documentation or isolated container research.

## Targeted implementation

- Replace global ps descendant enumeration/numeric per-PID killing with signalling of the owned child's original group only while the leader remains unreaped/live in its ChildProcess handle. Never signal a saved numeric PID/group after observed exit. This reduces stale-reference risk, not a containment guarantee; background jobs already orphaned may remain alive.
- A per-runtime ProcessSupervisor tracks active run objects, links cancellation, closes admission on shutdown, requests stop and awaits bounded local cleanup. No global process registry or name matching. Abrupt supervisor crash cannot run JS cleanup and remains a negative case.
- Distinguish observed leader exit, requested stop, output EOF versus collector cutoff, and unconfirmed descendant termination. Separate exit/stop/drain timers; no invented SIGKILL observation. Bound capture and release local pipes/listeners/timers even when an escaped process holds a writer.
- CLI caches one command runtime per approved client and tracks owned runtime shutdown before database closure. Existing dispatcher permission, audit, grants, tool pairing and subscription isolation are preserved. Runtime shutdown is not a successful whole-tree termination receipt.
- Model/TUI messages report timeout and unconfirmed termination, never “the process tree was killed”. Older outcomes with absent lifecycle information are unknown. Exit code 0 describes the leader only.

## Contract and migration

Contract 1.9 adds optional lifecycle observations on CommandOutcome and optional CommandRuntime.shutdown(). Existing injected runtimes remain source-compatible; absent observations are unconfirmed. No ToolResult/request role/schema/DB migration: user/model-visible text carries the observation and survives existing stored tool messages. Consumers in tools/CLI/TUI migrate together. Prior historical timeout text is not rewritten or treated as verified evidence.

## Gate

Closed on every production platform. Research-only injected runtimes, disposal of local resources, observed leader exit, or a passing negative test cannot open it. Enabling requires a demonstrated kernel/container lifetime boundary and all adversarial acceptance under the actual production path, including crash handling, safe identity and unchanged sandbox enforcement. See [acceptance](../delivery/process-supervision-acceptance.md).
