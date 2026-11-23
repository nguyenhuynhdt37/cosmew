# MCP Manager Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. User explicitly authorized execution with subagents; no further plan approval gate.

**Goal:** Deliver the MCP MVP described in docs/delivery/mcp-manager-comparison-2026-11-22.md: reliable connection management, installed/configured list, OAuth/static credentials, curated/registry discovery, safe supported local installation, CLI and TUI parity. Plugin execution, enterprise policy and general runtime compatibility remain the expansion scope.

**Architecture:** Shared contracts define manager views/actions, injected SDK ports and presentation-only TUI. MCP owns protocol/auth/discovery; persistence owns durable config/token/install metadata writes; CLI composes host services and managed local installation. Existing dispatcher remains the only model-tool execution path. Future plugin ownership is metadata, not executable plugin loading.

**Tech Stack:** Bun1.4.4, TypeScript, existing MCP SDK1.32.2, existing keyring/vault ports, Ink. No new external dependency without catalog update.

**Spec:** docs/delivery/mcp-manager-comparison-2026-11-22.md (user accepted MVP flow).

## Global constraints

- Preserve shared dirty tree. No commit/stage/reset/stash or production-state mutations. Tests use disposable roots/fixtures. No paid-provider calls.
- User-scoped MCP config only; repository files cannot start processes. Metadata discovery never runs installers.
- Installed/configured, auth, connection and tool-policy states remain separate. Remote has no fake installed version.
- Mutating calls are not replayed to repair a connection. Disabling removes live tools, aborts owned local calls and revokes cached grants.
- Tokens/verifiers do not enter public views/logs. OAuth state/issuer/resource binding, cancellation and wrong callback tests mandatory.
- Registry badges are not a compatibility/security certificate. Unknown or unsupported package formats remain explicit manual setup.
- Shared contract advances from concurrent skill-manager1.53 to1.54 with consumers/ADR. Root owns contract/version unless assigned otherwise.

## Review focus

- Config/server identity changes while approval or OAuth pending: stale work cannot grant new identity access.
- Failed/cancelled installations never advertise ready; remove cleans only owned artifacts and cannot escape private directory.
- Logout clears local state even if remote revocation fails and reports that limitation.
- Disable/reconnect concurrent with tool calls neither leaks processes nor repeats side effects.
- Imported/manual config remains usable after restart, protected against symlink and lost-update writes.

### Task1: Protocol reliability (worker transport)
Files packages/mcp/src/{client,servers}.ts + focused tests.
- [x] Reproduce reconnect, lifetime signal,64+pagination, per-tool schema and image-only/JSON redaction failures.
- [x] Add per-server reconnect/setEnabled/replaceSpecs, truthful states and cancel-safe generation fencing.
- [x] Preserve bounded discovery with explicit truncation, isolate bad tools, support bounded image attachment or explicit unsupported result.
- [x] Verify actual stdio/HTTP fixtures and shutdown; no mutation retries.

### Task2: Authentication (worker auth)
New packages/mcp/src/oauth.ts and persistence auth storage modules/tests.
- [x] Implement SDK OAuth provider with explicit browser login, loopback callback strict state and issuer/resource binding, refresh, logout/revocation report.
- [x] Inject credential storage and fetch/browser ports; no API keys assumed from model provider.
- [x] Integrate provider into HTTP client via transport worker coordination.
- [x] Verify real loopback HTTP flows, denied/cancelled callbacks, restart refresh and redaction.

### Task3: Registry and managed install (worker catalog)
New catalog client/recipes + CLI install adapter + persistence install metadata.
- [x] Query bounded official registry JSON and curate documented candidates with explicit untested status.
- [x] Expose recipes/manual fallback; initially supported pinned npm artifacts only, no implicit arbitrary lifecycle scripts.
- [x] Install in private owned area with integrity, atomic metadata, cancellation and safe removal; remote configuration requires no download.
- [x] Test local fake registry/artifact/runner, malicious names/paths and interrupted installs; no package downloads in tests.

### Task4: Manager/contracts/persistence composition (root)
New contracts/mcp-management.ts; persistence/mcp-settings.ts; CLI/bootstrap/mcp-manager.ts; SDK ports.
- [x] Define views/actions and manager operations; retain old mcpStatus/mcpServers compatibility.
- [x] Validate atomic user settings writes, locking/CAS, identity metadata and secrets references.
- [x] Wire hub/auth/catalog/installer; ensure mutation invalidates dispatcher permissions and pending prompts.
- [x] Real manager integration tests for add/list/auth/connect/disable/reconnect/remove/restart.

### Task5: CLI and TUI (workers after interfaces settle)
CLI index helper and panels/mcp UI modules, SDK port forwarding.
- [x] Add CLI search/add/install/list/get/login/logout/enable/disable/reconnect/doctor/remove.
- [x] TUI Configured/Discover/Recommended lists and per-entry supported actions, progress/cancel/errors.
- [x] Secure credential input never in transcript; confirmation shows concrete operation.
- [x] Verify keyboard/mouse and fixture CLI flows without account/model requirement.

### Task6: Acceptance (root and independent review)
- [x] Update docs/ADR/dependency catalog if needed; describe supported formats/live limits accurately.
- [x] Review security and integration independently, fix regressions.
- [x] Final bun run quality passed:1961pass/13skip/0fail; see docs/delivery/mcp-manager.md.
