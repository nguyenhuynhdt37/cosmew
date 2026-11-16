# ADR 0037 — Chat, command registry and configuration integration

Date: 2026-11-17. Status: accepted within the user's combined Task 03 + 04 authorization.

## Evidence and scope

Codex source fetched at `090be4df0724cdef5758e6a0934ba557af8b6bbe` on 2026-11-17, https://github.com/openai/codex/tree/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/tui/src . Futryn starting HEAD: `d56e11fabb82f638d6602a6628ee5323e064119b`, dev; pre-existing dirty/staged changes are outside this delivery.

Preserve the current Bun/TypeScript renderer, theme engine, independent agent and dispatcher. Extend existing SDK seams; no new packages or dependencies. Registry metadata is authoritative for canonical commands, aliases, handlers, overlay targets, discovery, busy availability and command shortcuts. Unsupported integrations stay explicit.

## Contract 1.18 and migration

Add optional `Settings.agentPreferences.turnBudget`, validated with the existing turn budget schema. Missing preferences mean no user budget. SQLite SettingsStore validates and commits atomically, without a database schema migration. User preferences never restore permission modes, delegation or grants. Existing workspace appearance overrides continue to outrank user defaults when editing user settings; saving a user preference no longer deletes a workspace override.

Extend diff file metadata with optional layer, original path, binary and truncated flags; report adds optional readiness/error state, message and truncation. Old producers remain readable. Totals describe displayed data; a bounded report must not imply full repository totals. SDK exposes asynchronous refresh while synchronous reads return one cached authoritative report. No Git subprocess runs during frame rendering.

## Git inspection policy

CLI composition owns informational Git collection after folder consent. Always disable external diff, textconv, executable fsmonitor, hooks and clean/process filters (including required filters). Use literal arguments, NUL-separated path lists, fixed no-pager environment, no optional index locks, explicit cwd and scoped relative paths. Never stage/write files. Bound per-command output/time, aggregate time, file count and displayed lines; do not call clean on repository content outside Git's protected diff policy.

## Modes and execution

Plan and Review use the existing independent loop with per-request instructions and read/search-only descriptors. The composed ToolPort rejects non-read execution even if a model invents a hidden call. SDK rejects changing modes during a running turn and analysis modes with delegated ownership. User shell mode shares the current dispatcher and is refused in analysis/delegated contexts. Switching to Chat is an explicit implementation transition; no new engine is added.

## Limits

Provider completion events do not include an authoritative final text payload; a dropped delta cannot be reconstructed from completion alone. Manual compaction remains unavailable: automatic compaction is performed inside the active turn and has no safe public idle operation. Unrelated MCP/plugins/skills/subagents remain unimplemented. Fixture acceptance is distinct from authenticated provider or human visual acceptance.
