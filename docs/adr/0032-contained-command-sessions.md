# ADR 0032 — Contained native command execution and pipe sessions

Accepted 2026-11-16 under the user's execution milestone. Baseline Futryn dev `babdd502230166a4420803e24481ac6e003d24fc`, followed by recovery live-acceptance fix `101b8d550d81582caca9aa259a3d3ad3192e470e`. This is a verified experimental Docker backend, not general production readiness or complete Codex parity. Native host Seatbelt, host-native Linux execution and Windows stay closed. No PTY is advertised.

## Current upstream inspected

Official OpenAI Codex, fetched 2026-11-16, exact commit **`ca0bbbdf0c83cb64f2fb48cf0d5ffbc3d4409ab9`**. Paths are relative to [codex-rs at that commit](https://github.com/openai/codex/tree/ca0bbbdf0c83cb64f2fb48cf0d5ffbc3d4409ab9/codex-rs):

| Verified source | Mechanism and difference |
|---|---|
| core/src/tools/handlers/unified_exec/{exec_command,write_stdin}.rs | Registered argument preparation, completion versus retained-session calls, session lookup and model-facing output. Futryn uses JSON function tools through its own registry. |
| core/src/tools/runtimes/unified_exec.rs and unified_exec/launch.rs | Approval/sandbox orchestration before process-manager launch; no alternate foreign agent engine is adopted. |
| core/src/unified_exec/{mod,process_manager,process,output}.rs | Yield waits, retained processes, bounded output, cancellation/interrupt/termination. Codex currently permits 64 retained processes and a default 300s background limit; Futryn bounds sessions to eight per runtime and a nonrenewable 120s maximum lease. |
| core/src/unified_exec/stdin_approval.rs | Host-owned launch permission snapshots and reapproval when permission settings drift. Futryn always binds input to its current session/cwd/runtime policy and exact input; old launch approval does not approve stdin. |
| core/src/unified_exec/{command_sessions,shell_snapshot}.rs | Retained-session observation and shell environment snapshots. Futryn has opaque ephemeral pipe sessions, no persisted shell environment or shell-profile restoration. |
| utils/pty/src/{child,process_group}.rs; sandboxing/src; linux-sandbox/src | Native platform process/sandbox boundaries. Reading upstream process-group cleanup is not proof against setsid/reparenting. Futryn's tested macOS path instead uses a local Linux-container PID namespace. |

These are upstream mechanisms, not claims that Codex has Futryn's exact containment policy. Docker snapshots, the privileged/nonprivileged supervisor split, framed output and fixed-image gate are Futryn-specific decisions.

## Audit findings and architecture

Existing exec_command already traversed ToolPort → registry/router → handler → orchestrator → runtime, with separate process.execute approval, cwd revalidation, output bounds and audit. The existing Seatbelt candidate and ProcessSupervisor could not certify detached descendants or supervisor death; their production availability remains false. No shell shortcut is enabled.

New `exec/container.ts` implements CommandRuntime; `container-supervisor.ts` is a fixed trusted PID1 program inside the approved image. `execution-snapshot.ts` reuses descriptor-relative workspace file access, including binary files and fd-based directory enumeration. `handlers/stdin.ts` registers write_stdin in the same dispatcher. Command result projection is shared by launch and stdin, with no second dispatcher. Core pumps toolOutputDelta events while calls run; CLI forwards the callback; TUI renders output while retaining running/approval status. A running session is pending work, not verified checks. Iterator closure cancels owned execution and preserves the actual bounded result in the journal.

## Gate and fixed policy

Opt in with `FUTRYN_COMMAND_BACKEND=docker fyn`. This selects a backend, not permission or an unsafe override. A fixed local `/var/run/docker.sock` Unix endpoint is used with an empty private Docker configuration and explicit CLI path. DOCKER_HOST, remote contexts, host credentials and arbitrary Docker flags/images are not inherited. No backend invocation pulls an image.

Approved image: **`oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`**, Bun 1.4.4 / Debian 13, checked as linux/arm64 on this host. See dependency catalog; official Bun image provenance: https://bun.com/guides/ecosystem/docker. Docker daemon, image supply chain, VM and kernel are trusted boundaries, not capabilities granted to the model.

Readiness requires descriptor-relative filesystem support, a local Linux Docker engine with cgroup v2 and default seccomp, the exact installed image, and real privilege/filesystem/network/detachment self-tests. Engine identity/version/security options are checked again; successful probe evidence is cached only for that process and policy fingerprint. The created container's actual HostConfig is inspected before start. Missing/failed capabilities deny execution; there is no unconfined retry. Docker's empty PidMode is its private default (this CLI rejects the literal value `private`); require that exact mode and verify PID1 is the trusted Bun process.

Policy: private PID/cgroup/IPC namespaces; network none (private loopback only, no host/external routes); read-only rootfs; 128 PIDs; 512 MiB memory with no extra swap; one CPU; no-new-privileges; bounded ephemeral /tmp; no devices, daemon socket or host home. All capabilities are dropped except SETUID/SETGID/SETPCAP for the trusted supervisor to drop credentials/bounding capabilities. The actual command has uid/gid 65534, cleared supplementary groups and zero effective/ambient/inheritable/bounding capabilities. It receives a fixed minimal environment and bash --noprofile --norc. Executables come from the pinned image or authorized snapshot, never the host PATH. No shell-word denylist substitutes for containment.

The supervisor starts at trusted `/`, explicitly disables project Bun configuration and dotenv loading, and only then launches the nonroot command in the approved virtual `/workspace[/cwd]`. Real negative tests caught project bunfig preload running at supervisor privilege and the installed host CLI loading project code before folder consent. Both fail before and pass after hardening. The installed CLI shebang/source scripts explicitly disable project Bun configuration and dotenv loading; source invocations must use those same flags.

## Workspace and lifetime

After current approval, build a private sealed copy of authorized workspace content. Both original and resolved alias paths must pass policy. Internal symlinks are materialized; cycles, outside links, hardlinks, special files, races, excessive depth/count/bytes and unsupported filesystem facilities fail closed. .git, secrets, Futryn state and private patch temporary names are omitted. Every ancestor/file is accessed without following symlinks through unvalidated descriptors. The only host bind is this detached read-only snapshot, not live project files. Command writes are confined to ephemeral /tmp. Builds that require writable project trees must explicitly copy the snapshot into /tmp first; host changes still require apply_patch. Host-specific native dependencies may not run in the Linux image; no download/install or host fallback occurs automatically.

The trusted PID1 has an independent immutable deadline. Command descendants cannot signal the root supervisor or modify its program/timer. On leader exit, drain output for at most 1s; root exit tears down the entire PID namespace even for detached/reparented descendants. Timeout/signals have a bounded 250ms final transport flush. A Futryn crash cannot remove this deadline: the namespace terminates within its remaining lease, rather than claiming immediate parent-death cleanup. Docker's observed stopped state/Pid 0 is required before certifying descendant termination. Missing supervisor receipts, transport failure or inconsistent observations produce EXECUTION_UNKNOWN, never successful exit or automatic retry.

Stdout/stderr are base64 data frames from the trusted supervisor, with separate bounded head/tail budgets and backpressure. Child text cannot forge control/exit frames. Metadata includes actual child exit/signal and drain status; it is compared with Docker's wrapper exit. TUI deltas are control-stripped and redacted across chunk boundaries; progress queues are bounded. The final bounded result is durable; per-byte transient output is not an append-only log. Truncated/cut-off output is labeled.

## Sessions, approvals and compatibility

exec_command accepts optional yield_time_ms; if the command is still running, its real opaque session UUID is returned. write_stdin accepts owned session_id, at most 512 characters, yield_time_ms and optional explicit SIGINT/SIGTERM. Pipe bytes are not terminal key events; no tty flag, PTY, resize or terminal emulation. Explicit signals target the owned supervisor/namespace, with escalation when needed. Polling retains uncollected exits; stale/foreign IDs and concurrent input are rejected. Eight retained sessions cap memory/resources; collect exits before opening more. Original deadlines cannot be extended by input/polling.

Current validation, workspace normalization, policy, approval, scope hash, audit and revalidation apply to launch and stdin. Scope binds exact command/input, canonical cwd, policy and lease/session identity. Deny wins; revocation and resume clear grants. Session maps are never reconstructed from persisted tool messages. A historical session ID is evidence, not authority. Native Codex tools remain disabled; its bridge may only invoke registered Futryn dynamic tools through this same path. Direct provider SDK types do not enter core.

Contract **1.13** adds toolOutputDelta, optional ToolPort progress callback, command session/output port fields, sessionId on results and confirmed-termination lifecycle states. Consumers migrate together; existing optional-port implementations remain compatible. SQLite remains schema4, old history is not rewritten. Downgrading strict older readers after new result fields is unsupported and may fail closed; no silent data conversion or side-effect replay.

## Verified scope and remaining limits

See [acceptance](../delivery/execution-runtime-acceptance.md) for real-provider/TUI, deterministic and actual-container results. Tested host: Darwin 24.6.0 arm64, OrbStack Linux kernel 7.2.12, Docker Engine 29.8.2/cgroup2/seccomp. Standalone Linux host and Windows acceptance are not established. Native Seatbelt and unsandboxed execution stay closed.

No PTY parity, arbitrary image selection, host writes/network, automatic package installation, persisted shell environments or long-running servers beyond the finite lease. After abrupt owner death, stopped container metadata and private snapshot/control directories can remain; automated crash garbage collection is not implemented. Daemon/VM unavailability yields uncertainty; daemon-restart fault injection was not performed against the user's shared engine. This milestone does not assert production readiness, kernel/CVE immunity, exactly-once command effects or compatibility with every project toolchain.
