# MCP management: upstream comparison and Cosmew delivery scope

Date: 2026-11-22. Research/proposal only; not implemented or an approved implementation specification. Based on official documentation fetched this turn and current Cosmew source. No competitor runtime parity, real OAuth acceptance, catalog compatibility or paid-provider generation is claimed.

## Current product

Cosmew has stdio/Streamable HTTP user-configured connections, tool discovery and dispatcher-mediated calls. `cosmew mcp list` connects and displays status. The `/mcp` panel lists names/status/tool counts/source and explicitly reports stdio/OAuth management unsupported. The user config is normally `~/.cosmew/mcp.json`, or the effective state directory selected through COSMEW_HOME/legacy state migration. Repository MCP files are not executed.

Sources: `apps/cli/src/index.ts` MCP_NOTE/connectUserMcp; `apps/cli/src/bootstrap/mcp.ts`; `apps/tui/src/ink/features/panels/index.tsx` McpDialog; `packages/sdk/src/client.ts` mcpServers; `packages/mcp/src/{config,servers,client}.ts`.

Not present: catalog discovery, managed installer, add/remove/edit UI, login/logout/credential refresh, persistent enable/disable controls, explicit reconnect management, resource/prompt management, deferred tool discovery. Manually configuring a command that downloads a package is not equivalent to an application-owned package installation manager.

## Official comparison

### Claude Code

Official MCP/commands documentation describes stdio/HTTP configuration, local/project/user scope, add/list/get/remove, interactive `/mcp` connection and authentication management, enable/disable and reconnect. `/mcp reconnect all` requires2.1.284+ in current docs. OAuth logout clears stored credentials; removing a remote entry clears its local token/registration, but removal does not itself revoke the authorization-server token; docs recommend logout first for supported revocation. Tool search can defer MCP definitions instead of loading everything upfront; exact defaults depend on model and version. Plugins can provide MCP servers.

### Codex

Official MCP documentation describes stdio/Streamable HTTP, user/trusted-project config.toml, CLI and desktop/IDE configuration sharing on the same host, OAuth/bearer authentication, `/mcp`, and CLI OAuth login/logout. Configuration includes enabled, tool allow/deny lists, tool/server approval settings, startup/tool timeouts and required readiness. Installed plugins can supply MCP definitions with user on/off/tool policy overrides. These are reference capabilities; Cosmew must keep its own Claude-style permission semantics.

### OpenCode

Official current docs describe add/list, OAuth auth/logout and UI OAuth flow. V2 groups entries under `mcp.servers`, uses `disabled` rather than V1 `enabled`, splits catalog/execution timeouts, and uses snake_case OAuth fields. Do not import an arbitrary version's config as if all OpenCode schemas were interchangeable. Unverified details of remove/reconnect/update UI must not be inferred merely from another client's support.

### Shared lesson

The strongest common baseline is manage explicit server connections and authentication. None of the sources reviewed establishes a universal, fully audited, one-click installer with version rollback for every registry entry. Connecting a URL or saving an npx command is not proof of package management. Treat the proposed curated automatic installer as Cosmew product work.

## User-visible model

Track separate dimensions rather than one green status:

| Dimension | Examples |
|---|---|
| Configuration | added, disabled, invalid |
| Local installation | absent, installing, ready, incompatible, update-available; not-applicable for remote |
| Authentication | not-required, needs-login, authorized, expired, insufficient-scope; account shown only when provider supplies identity |
| Connection | stopped, connecting, connected, reconnecting, failed |
| Tool policy | exposed/hidden and allow/ask/deny per existing policy |

A configured server is listed immediately, even if installation/auth/connection fails. Discovery results remain in Discover until the user adds them. Authenticated does not mean connected, and connected does not grant tool execution authority. A disabled server stays in the installed/configured list.

Proposed UI: `/mcp` has Configured, Discover and Recommended views. Each configured entry shows canonical identity, display name, provenance (manual/catalog/plugin), transport, effective scope, local pinned version when applicable, auth status, observed connection status, tool count and diagnostic. Selecting it offers only supported actions: connect/reconnect, enable/disable, login/logout, credentials, inspect tools, edit, diagnostics, update local package, remove. Account identity and granted scopes are unavailable rather than invented if the server does not provide them. Configured remote servers do not pretend to have locally installed package versions.

## End-to-end flow

1. Search official-registry metadata or choose a curated recipe; manual URL/command remains supported for missing/private entries.
2. Inspect publisher/source, runtime/OS requirements, transport, auth method, requested access, local package version and compatibility status. Registry publication proves neither source-code review nor compatibility.
3. Add with a stable identity. Resolve/pin supported local artifacts and install in an isolated per-user area using verified integrity. Do not execute arbitrary downloaded install scripts during metadata discovery. Remote servers are configured by URL and are not downloaded.
4. Prompt required nonsecret setup and authentication. Use OAuth browser flow where supported, otherwise secure credential entry/reference. Credential updates are kept separate from shareable configuration.
5. Connect/negotiate/discover with bounded deadlines and visible progress; record installation, auth and connection outcomes separately.
6. Expose tool metadata according to policy/context budget; requests go through dispatcher schema validation, permission, revalidation, audit and redaction. Server annotations and descriptions do not grant authority.
7. If auth expires, refresh when supported; otherwise show Login required. Never substitute model-provider credentials or repeatedly retry indefinitely.
8. Disable removes tools and stops/prevents new calls. Inflight cancellation cannot establish rollback of remote effects; report outcome uncertainty. Re-enable restores configuration, not revoked grants.
9. Logout deletes local credentials and attempts provider revocation only where supported; explicitly report whether remote access was revoked. Config and local package may remain. Static API credentials are cleared as a separate credential action rather than pretending OAuth logout exists.
10. Remove unregisters the entry and cleans up exclusively owned local artifacts. Shared/plugin-owned package references require ownership tracking. Server-side records are never deleted as a side effect of removing a connection.

## Recommended MVP

A complete small vertical product is preferable to a large catalogue of partially working servers.

A. Fix existing MCP reliability/redaction issues before introducing installation automation: recover failed startup, correct lifecycle listeners/states, per-tool schema isolation, visible pagination limits, explicit nontext result handling, structurally safe JSON redaction. An audit repro used temporary servers and confirmed64-of70 silent clipping, a single oversized tool causing whole-server failure, image-only empty success, postconnect signal cancellation leaving connected status, failed→failed reconnect, and escaped-secret/bearer-quote JSON issues. Repro `/tmp/cosmew-mcp-audit-followup.ts`; audit evidence only, no production fix in that turn.

B. Implement one manager shared by CLI/TUI/exec composition with add/list/details/edit/remove, persistent enable/disable, reconnect/diagnostics, and correct states. User-scoped management first; repository configuration remains nonexecuting under current AGENTS trust rules.

C. Support remote OAuth and secure static credentials, login/logout/refresh, issuer/resource binding and strict callback verification. Show required setup before tools are offered, with cancellation and no secret-bearing logs.

D. Add registry search plus a small set of tested recipes. For local servers, initially support a deliberately limited runtime/package format with pinned versions, integrity, cancellation, atomic installation and uninstall. Unsupported registry entries show why and allow explicit manual setup; no universal compatibility claim.

E. Verify complete user flows for at least one auth-free remote, one OAuth remote and one managed local server. Offline restart, bad credentials, missing runtime, failed/cancelled install, reconnect after server recovery, disabled tool calls and duplicate identity must be tested. Fixture success is not a real service compatibility badge.

Suggested user commands (proposed, not all implemented): `cosmew mcp search|add|install|list|get|login|logout|enable|disable|reconnect|doctor|remove`. The TUI is the main beginner-friendly entry; CLI is its automation surface. Exact names should be finalized in the public contract/ADR before implementation.

## Pro / expansion

- Local package updates with immutable version history and rollback; remote deployments cannot be rolled back by Cosmew unless the provider explicitly offers versioned endpoints.
- Lazy tool search/catalog caching and tools/list_changed refresh with epoch-bound validation; do not silently drop late pages or accept stale approvals after schema changes.
- Supported images/resources/prompts with bounded conversion and explicit unsupported feedback. Resource URIs are not ambient permission to fetch.
- Health/latency/timeout diagnostics, redacted logs, failure recovery, offline catalogue cache and per-server settings. Never replay mutating tool calls merely to reconnect.
- Optional recommendations using user-approved project metadata (e.g. package.json, selected workflows); never upload code/secrets or auto-install from repository suggestions.
- Plugin bundle manifest may reference MCP+skills+commands; record owner/version/source. All manual and plugin servers share the same lifecycle/auth/tool manager. Plugin disable removes its provided tools. Name collisions and shared artifacts need explicit ownership, not silent overrides.
- Hooks require a separately mediated execution lifecycle. Import adapters for other clients should preview credentials/provenance and version-specific differences, not execute foreign repository config.
- Organization policy/private catalogues and platform certification later. In-process arbitrary plugin JS is not sandboxed merely by API wrappers.

## Initial recommendations

Recommend by user workflow, not install count. Candidates for future validated recipes: Context7 for current library docs; GitHub for issue/PR workflows; one of Playwright or Chrome DevTools for browser testing; Figma when design work is requested; Sentry when incident debugging is requested; OpenAI Docs for OpenAI API work. These are candidates, not certified integrations for current Cosmew. Avoid automatically adding filesystem/shell MCP where built-in tools already solve the job.

Eligibility for Recommended requires source identity, pinned tested recipe where local, supported transport/auth/OS, useful task coverage, bounded output, explicit permissions and recorded compatibility evidence/date. Show Registry-listed, Publisher-verified and Cosmew-tested as different labels; none implies the others.

## Sources (accessed 2026-11-22)

- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/commands
- https://code.claude.com/docs/en/cli-reference
- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/developer-commands#codex-mcp
- https://opencode.ai/docs/mcp-servers.md
- https://opencode.ai/docs/cli/commands.md
- https://opencode.ai/docs/migrate-v1.md
- https://modelcontextprotocol.org/registry/about (fetched earlier in this conversation)

Documentation describes current capabilities and may change. No installed upstream versions were executed for this comparison. Broad historical docs in this repository can label already-delivered skills/MCP as Not implemented; current implementation and specific ADRs take precedence.
