# MCP UX gap audit — 2026-11-22

Source audit of the shared working tree based on HEAD `153723896e3ee290136283bd965a777463bc84e2` plus uncommitted changes. This is code-path evidence, not live-service acceptance. Reviewed AGENTS.md, events/dependency contracts, management contract, CLI composition, TUI manager and existing delivery/comparison documents. Runtime fixes and tests are owned by the integrating task; this audit changes documentation only.

## Implemented capabilities and exposure gaps

| Capability | Evidence and remaining UX gap |
| --- | --- |
| Add/edit/remove, enable/disable, reconnect/doctor | `packages/contracts/src/mcp-management.ts` actions and `apps/cli/src/bootstrap/mcp-manager.ts` implement these. TUI basic actions and Advanced settings expose them. Doctor currently reconnects; it is an active connection check, not a passive status read. |
| Independent connection/auth/install state | `McpManager.snapshot()` returns each dimension, provenance, pinned installation version, endpoint and diagnostics. Earlier list rows reduced this to one glyph/tool count. Colored overview/detail components now expose these states; a connected server must still expose auth/install concerns independently. |
| OAuth and bearer credentials | Host login/logout and credential operations exist; `packages/mcp/src/oauth.ts` provides SDK token read/save hooks and refresh-token storage. Automatic refresh is backend behavior, not a missing token subsystem. There is no explicit management `refresh` action; TUI status refresh must not imply refreshing OAuth credentials. Real provider OAuth remains Needs verification. |
| Registry, recommendations, managed installation | Search/pagination, metadata-only browsing, manual recipes and exact-version npm installation exist. Automatic local support is deliberately bounded; dependency-bearing packages need a verified lockfile. This is not universal Registry compatibility. |
| Per-tool execution permissions | Existing rules recognize exact `mcp__server__tool` and server/wildcard patterns (`packages/contracts/src/permissions.ts`); calls remain dispatcher mediated (`packages/tools/src/handlers/mcp.ts`). Permission enforcement is implemented. The manager snapshot exposes only tool name/description, and actions contain no tool-policy update: effective allow/ask/deny inspection and editing in the MCP tools screen are missing UX/API work. Do not treat an added server as an execution grant. |
| Headers and environment | Management config supports HTTP headers and stdio env; TUI add forms expose URL or executable/argv plus separate bearer entry. Nonsecret header/env setup and safe inspection are poorly exposed. Current edits are explicitly full replacement and clear these fields; do not imply they preserve hidden setup. |

## Three concrete usability bugs

1. **P1: Removal confirmation contradicts credential side effects.** TUI `advancedChoices()` originally says “Server-side authorization is not revoked.” Host `manage(remove)` calls `auth.logout(spec.url)` when removing the last alias, and logout may attempt remote revocation. A user can approve a removal on an incorrect premise. Bounded fix: explain that the last endpoint alias clears credentials and attempts supported revocation, then retain the returned separate local/remote outcome. **Fixed in integration; keyboard regressions pass.** This finding does not request changing host logout behavior.

2. **P2: Managed package edit is an impossible advertised flow.** Every stdio entry originally offers “Replace local executable / arguments”; `edit()` even warns that managed ownership “may be removed.” Host `manage(edit)` explicitly throws `UNSUPPORTED` when `cosmew.installationId` exists. The user completes a form and confirmation before discovering the action cannot work. Bounded fix: hide/disable replacement for managed entries and explain the supported remove/reinstall path; preserve backend protection. **Fixed in integration; keyboard regressions pass.**

3. **P2: Configuration diagnostics silently omit issues after the second.** Original TUI renders `snapshot.problems.slice(0, 2)` with no remaining count or inspection action. Host snapshots aggregate config and live hub problems, so a third failing entry may have no visible reason. Bounded fix: show total issues and a navigable, bounded diagnostics view; keep errors redacted and list selection stable. **Fixed in integration; keyboard regressions pass.**

Two further interaction defects found at the start of this audit are also being addressed: configured/tool lists lacked filtering, and the panel read status only on mount or after management actions. The integration adds local filters and a passive `mcpManager()` refresh, which must not reconnect, install or authenticate.

The initial `mcpManager()` rejection handler also synthesized `supported:false`, presenting transient failure as unsupported and selecting the fallback. Integration now preserves a distinct safe load-error message with `f` retry; unsupported is reserved for an authoritative backend snapshot. Its keyboard regression passes.

## Truly missing or deliberately excluded

| Area | Current boundary and bounded next step |
| --- | --- |
| Resources and prompts | MCP client/manager are tool oriented; no manager resource/prompt inventory or model `mcp_resource` tool. Add typed, bounded discovery/read contracts and permission semantics before a UI. |
| Deferred tool search | No model `tool_search`; local list filtering does not implement deferred model discovery. Define budget/epoch/schema handling as a separate feature. |
| Foreign config import | No import management action. A future version-specific preview should map supported fields and credentials explicitly; foreign repository files must not execute automatically. |
| MCP configuration scopes | Only effective user-state `mcp.json` is managed; snapshot has one configPath and no scope selector. Project/local MCP execution is deliberately forbidden by current policy, not a forgotten dropdown. Permission settings have separate user/project/local trust semantics and must not be conflated with server config scopes. |
| Package updates/rollback | Install pins a version; there is no update/rollback action or immutable version-history UI. This is explicitly deferred by ADR 0102. Next scope could be reviewable exact-version replacement with ownership/rollback guarantees. Remote endpoints have no invented local package version. |
| Per-server timeout/readiness controls | Client has internal timeout options; management configuration/action contract does not expose startup/tool timeout or required-readiness settings. This needs validation/contracts and consumers, not only a form field. |

## Evidence limits and upstream references

Current implementation evidence: `packages/contracts/src/mcp-management.ts`; `apps/cli/src/bootstrap/mcp-manager.ts`; `apps/tui/src/ink/features/mcp-manager/{index.tsx,presentation.ts}`; `packages/mcp/src/{client.ts,oauth.ts}`; ADRs 0102/0104 and `docs/delivery/mcp-manager.md`. Function names are used because concurrent changes move line numbers.

The earlier [comparison](mcp-manager-comparison-2026-11-22.md) records official documentation accessed 2026-11-22, including https://code.claude.com/docs/en/mcp, https://learn.chatgpt.com/docs/extend/mcp and https://opencode.ai/docs/mcp-servers.md. Its “Current product” and “Not present” sections predate the manager implementation and are historical, not the present inventory. No upstream runtime revision was verified for this audit: exact competitor UX/parity is **Needs verification**. No network research, package installation, credentials, commits or staging were used for this audit.
