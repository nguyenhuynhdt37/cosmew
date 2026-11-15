# ADR 0024 — Tool execution architecture

Accepted 2026-11-15 for the user's requested migration of all four existing tools. No contract/schema/version, package edge or dependency change. `ToolPort` and `ToolDispatcher` public APIs remain compatible.

## Decision

- `ToolRegistry` owns unique exact names, descriptor/schema snapshots, exposure and dynamic availability. `ToolRouter` resolves only registered, exposed, available handlers; unknown names and native aliases have no fallback.
- Handlers validate tool-specific input and prepare canonical workspace targets and runtime requests. All four built-ins are registered; unavailable exec remains registered but unexposed and unexecutable.
- `ToolOrchestrator` owns request/decision/completion audit, shared approval and grants, cancellation, launch-time path/policy/grant/runtime revalidation, redaction and bounded results. Deny wins over grants. It rejects concurrent duplicate invocation IDs without executing twice; settled results are never cached as authority. Existing core duplicate-ID and budget rules remain unchanged; this is not durable exactly-once execution.
- `FileSystemRuntime` executes bounded reads/listing and cancellable grep workers on authorized targets. Search still filters protected paths and independently checks each file. The process backend uses the existing injected `CommandRuntime` and formats outcomes; Seatbelt/process supervision remain unchanged with the production gate closed.
- `ToolDispatcher` only composes these objects and delegates the existing API. Automatic instruction reads are not a model tool; their reader shares orchestrator authorization and filesystem backend without prompting for new access.

Core, provider adapters, Codex dynamic bridge, SDK consent/grants, usage and persisted call/result schemas are unchanged. No native runtime tool or exposure setting grants authority. No sandbox escalation or unsandboxed retry is added. The six responsibilities are used by actual built-ins; no general plugin/runtime framework is introduced.

## Reference and verification

Source accessed 2026-11-15, Codex revision `ee344ca9458351a6ea102795fa73110ad3ede5dc`: [registry](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/tools/registry.rs), [router](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/tools/router.rs), [orchestrator](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/tools/orchestrator.rs), [handler](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/tools/handlers/unified_exec.rs), [runtime](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/tools/runtimes/unified_exec.rs). Architectural reference only: Hannes does not copy Codex hooks, PTY, escalation, MCP or runtime authority.

Focused security tests cover registry identity/snapshots, hidden/unavailable routing, policy despite exposure, duplicate calls, grants, cancellation and launch-time sandbox changes. Existing direct-provider/Codex end-to-end fixtures cover exposure, permissions and persisted pairing. Final checks: `bun test tests` — 355 pass, 5 skip, 0 fail across 33 files; `bun run typecheck` and `bun run lint` passed. The five skips require native-vault/installed-runtime/live-login conditions. Fixtures do not establish live-provider compatibility or detached-process containment.
