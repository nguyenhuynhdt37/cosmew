# ADR 0121: MCP Prompts, Media Attachments, Dynamic List Notifications, and Managed npm Provenance

- **Status**: Accepted
- **Date**: 2026-11-27
- **Contract version**: `1.66` (additive over `1.65`)

## Context

Following ADR 0102 (MCP manager) and ADR 0119 (deferred `tool_search` and `mcp_resource`), four MCP protocol gaps remained:
1. MCP server prompts (`prompts/list`, `prompts/get`) were not discovered or exposed as slash commands `/mcp__<server>__<prompt>`.
2. Non-text MCP tool outputs (`image` / embedded `resource` blobs) and `mcp_resource` binary blobs were always omitted, preventing vision models from inspecting images or PDFs returned by MCP servers.
3. Dynamic MCP list-changed notifications (`notifications/tools/list_changed`, `prompts/list_changed`, `resources/list_changed`) were ignored, requiring manual reconnects.
4. Managed npm MCP installations had no atomic `update` or `rollback` workflow with SHA-512 provenance history.

## Decisions

### 1. MCP Prompts (`prompts/list`, `prompts/get`)
- `McpClient` and `connectStdio` discover prompts best-effort on connect (up to 64 prompts / 4 pages; JSON-RPC `-32601` returns an empty list cleanly).
- Prompts are exposed as `/mcp__<server>__<prompt>` in `client.mcpPrompts()`, TUI slash autocomplete, and `routeCommand`.
- `client.resolveMcpPrompt()` parses positional and `key=value` quoted arguments, enforces required arguments, refuses execution in `plan`/`review` modes or without workspace consent, honors `Mcp` `deny` permission rules, and labels returned text as untrusted server prompt content (never system authority).

### 2. MCP Media Attachments (`packages/mcp/src/media.ts`)
- Validated PNG, JPEG, GIF, WebP, and PDF payloads from MCP `tools/call` (`image` blocks and embedded `resource` blobs), `resources/read` (`blob`), and `prompts/get` become `Attachment` entries (capped at 5 MiB per attachment and 4 attachments per response).
- Every binary payload undergoes magic-byte sniffing, minimal container structure validation (`IHDR`, JPEG EOI, GIF dimensions, WebP RIFF/VP8, PDF `%%EOF`), and registered-secret scanning via the active `Redactor`. Fake/truncated media, mismatched MIME types, oversized payloads, or media containing registered secrets are rejected and omitted.

### 3. Dynamic MCP Notifications (`list_changed`)
- Both HTTP (`McpClient`) and Stdio (`connectStdio`) register handlers for `ToolListChangedNotificationSchema`, `PromptListChangedNotificationSchema`, and `ResourceListChangedNotificationSchema`.
- `McpHub` coalesces notifications single-flight per server with lifecycle generation guards. When discovered tools change, `entry.toolsEpoch` increments (changing every tool/server identity to invalidate stale in-flight approvals against TOCTOU) and `onToolsChanged` triggers `client.invalidateMcpPermissions()`.

### 4. Managed npm Update & Rollback with Provenance
- `McpManager` records `integrity` and up to 5 `previousInstallations` (each storing `installationId`, `packageName`, `version`, `integrity`, `bin`, `updatedAt`) under `cosmew` metadata in `~/.cosmew/mcp.json`.
- `update` installs the target version into a fresh UUID directory (retaining full SHA-512, lockfile v3, `--ignore-scripts`, no-symlink checks) before atomically switching `mcp.json`, keeping prior directories for instant rollback.
- `rollback` re-verifies the stored directory ownership, manifest integrity, and regular-file executable before restoring `mcp.json` and cleaning up the discarded installation.
- CLI exposes `cosmew mcp update NAME --version EXACT [--integrity SHA512] [--lockfile FILE] [--bin NAME]` and `cosmew mcp rollback NAME`.

## Consequences
- No new package dependency edges are added (`packages/mcp` depends only on `@cosmew/contracts` and `@cosmew/security`).
- `CONTRACT_VERSION` bumps from `1.65` to `1.66`.
