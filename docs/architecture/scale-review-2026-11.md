# Scale review — 2026-11-21

This review covered the production import graph, the CLI/TUI composition roots, the permission/configuration paths, the MCP lifecycle, and the current startup/input path.

## Findings

- No production dependency edge or cycle violates `docs/architecture/dependency-rules.md`. `apps/cli` remains the composition root; `apps/tui` consumes `@cosmew/sdk` and `@cosmew/contracts`; `packages/tools` is the dispatcher boundary around security, workspace and code intelligence.
- The largest expansion risks are concentrated in a few files: `packages/sdk/src/client.ts` (~3,035 lines), `apps/cli/src/bootstrap/startup.ts` (~1,830), `packages/agents/src/subagents.ts` (~1,437), `apps/cli/src/index.ts` (~1,029), `apps/tui/src/ink/integrated-shell.tsx` (~1,090), `packages/core/src/agent/turn.ts` (~1,026), and `packages/tools/src/orchestrator.ts` (~937).
- The TUI directly owns editor and clipboard process bridges. These are intentional host capabilities, but they should not grow inside the render/controller module.
- The MCP server manager retains a failed initial connection snapshot without an explicit reconnect lifecycle. A future `/mcp reconnect` feature needs a deliberate retry/close/replace state machine.
- The settings status view now reports the permission settings files that actually exist and surfaces diagnostics. The current upstream Claude Code model also includes managed settings and a per-session `--settings` overlay; Cosmew keeps those as separate contract work.
- Startup input is gated until workspace trust, account/model selection and verification complete. A ready TUI session was reproduced with typing and Enter; the locked input during `checking`/`login` is expected state, not a focus failure.

## Staged reorganization

1. **Host boundary first.** Add an injected TUI host adapter for editor, clipboard, terminal setup and notifications. Keep `IntegratedShell` responsible for routing and rendering only. Preserve existing behavior through the adapter and add PTY tests at the boundary.
2. **SDK domain facades.** Extract auth/account, catalog/model, sessions, permissions/settings, usage and MCP lifecycle services from `CosmewClient`. Keep `CosmewClient` as the stable public facade and move one domain at a time with contract tests.
3. **CLI composition split.** Move provider/auth, permission settings, MCP, persistence and runtime assembly from `bootstrap/startup.ts` into focused composition services. Keep policy decisions in `security` and durable state in `persistence`.
4. **Agent loop split.** Separate turn request preparation/context accounting, tool-round execution, compaction, and recovery from `packages/core/src/agent/turn.ts`. Keep the existing `TurnHost` and event contracts unchanged.
5. **MCP lifecycle.** Add explicit reconnect, bounded retry and close semantics to `packages/mcp`, then expose them through the SDK and TUI panel.

Each phase should preserve the existing public ports, add a focused regression test before moving code, and run the contract, security, PTY and TUI suites before the next extraction.
