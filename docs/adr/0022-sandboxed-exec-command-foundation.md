# ADR 0022 — Task 03A sandboxed exec_command foundation

Accepted 2026-11-15 under the user's Task 03A instruction to Claude and explicit request to finish that work. Supersedes the shell prohibition only for a bounded, permission-mediated, read-only, network-denied command capability after a verified OS security gate. No writes, persistent sessions, PTY, write_stdin, apply_patch, MCP, plugins or code-intel. No new dependencies or package edges.

## Upstream source audit

Inspected official Codex source at `ee344ca9458351a6ea102795fa73110ad3ede5dc`, accessed 2026-11-15 (local source capture from Claude retained during handover). Paths below are relative to [codex-rs at that revision](https://github.com/openai/codex/tree/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs):

| Source | Mechanism inspected and limits adopted |
| --- | --- |
| core/src/tools/registry.rs | Registered tools dispatch by schema and call ID; no second execution channel. |
| core/src/tools/handlers/shell_spec.rs | Explicit argument schema/output budgets; FUTRYN supports only cmd, workdir, timeout_ms, max_output_tokens. |
| core/src/tools/handlers/unified_exec/exec_command.rs | Parse/preparation before resource allocation, injected process manager, cancellation. No fake session IDs in FUTRYN. |
| core/src/unified_exec/mod.rs | Orchestrator owns approval -> sandbox -> execution; completion-only calls terminate on timeout. FUTRYN does not adopt unsandboxed retries or interactive sessions. |
| core/src/unified_exec/process_manager.rs | Bounded output, process ownership and resource lifecycle. Reading this code does not establish FUTRYN cleanup equivalence. |
| core/src/tools/sandboxing.rs | Approval and sandbox are separate gates; cached approval cannot replace OS confinement. |
| sandboxing/src/manager.rs | Platform-specific sandbox transformation, environment and policy inputs. No fallback to SandboxType::None. |
| sandboxing/src/seatbelt.rs | Fixed /usr/bin/sandbox-exec, parameterized path policy, restricted reads/network. FUTRYN's stricter read boundary differs from Codex defaults. |
| linux-sandbox/src/bwrap.rs | Filesystem mount view plus seccomp/no-new-privileges and namespace isolation. Not reproduced by setting cwd or shell:false; Linux remains unsupported. |
| sandboxing/src/seatbelt_base_policy.sbpl, seatbelt_read_only_platform_defaults.sbpl, seatbelt_network_policy.sbpl; sandboxing/src/seatbelt_tests.rs | Deny-default rules and real OS policy tests. FUTRYN must run its own tests; upstream results are not compatibility evidence. |

## FUTRYN audit and ownership

Core orchestrates ToolPort only. Tools dispatcher validates, resolves via workspace, asks security, audits and revalidates before calling an injected CommandRuntime. Contracts own the serializable execution port and additive tool result fields; tools owns the OS candidate and bounded process/output internals. CLI composes them. TUI consumes tool events, displays the exact sanitized command and truthful result; pending approval is not a running process. Native subscription shell remains denied; only Hannes dynamic tools could traverse the same dispatcher. Copilot/ACP stay tool-disabled.

Execution approval uses a distinct process.execute capability, bound to exact command, canonical cwd and effective sandbox ID (fixed one-shot execution mode). SDK prompt caching includes that binding; fs.read never authorizes execution. Session revocation clears both dispatcher and SDK approval stores. Output is control-stripped, redacted and bounded; no raw environment is inherited. Ephemeral command results preserve IDs through existing stored messages; optional structured metadata is additive, not required to read old sessions.

## Contract and migration

Contract 1.8 adds process.execute to tool capabilities, optional exitCode/durationMs on ToolResult and an injected CommandRuntime port. Consumers migrate together; no DB schema changes. Existing tool messages remain valid. Resume reconstructs command exit codes from a host-generated header. Older strict consumers cannot accept the new capability/result fields; downgrade is unsupported. No historical result is invented. Command strings are limited to 1024 characters to fit the existing permission target contract. Unsupported arguments are rejected rather than ignored.

## Mandatory gate result: closed

A real macOS Seatbelt probe allowed rg/pipelines and denied workspace writes. However a disposable /usr/bin/perl subprocess that forked and called POSIX::setsid survived the existing group/tree cleanup after its parent returned. The test cleaned that process explicitly. A fresh session and reparenting can escape process-group kill plus ps ancestry enumeration. That implementation cannot meet Task 03A's mandatory descendant-lifecycle guarantee; do not claim it can.

Therefore production availability is false on macOS as well as unsupported Linux/Windows. No environment switch enables it. Seatbelt is retained as a test-only candidate to verify OS isolation and reproduce the blocker; passing its isolation probe does not authorize model execution. CLI never offers exec_command while the gate is closed. Injected deterministic test runtimes validate permission/provider/TUI plumbing only. A reliable OS supervisor/containment design plus real cleanup acceptance is required before enabling production. No unverified Linux implementation is added.

See [acceptance and limitations](../delivery/exec-command-foundation.md).
