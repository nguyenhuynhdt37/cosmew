# ADR 0068 — User MCP connect

Date: 2026-11-20. Status: accepted. Narrows the "stdio, OAuth, general MCP tools and server management remain W12" limit of [ADR 0044](0044-mcp-and-web-tools.md). No contract bump (stays 1.37), no new dependency, no settings-merge change. `web_search` stays on its own HTTP client.

## Problem

`fyn mcp` and `/mcp` reported that MCP was not implemented. The Streamable HTTP client and the `mcp__server__tool` permission syntax already existed. A user with a stdio or HTTP server in the Claude-style `mcpServers` file could not connect it, and a project file must not be able to start a process.

## Decision

1. **User file only.** The composition root reads `<state directory>/mcp.json` (`FUTRYN_HOME`, else `HANNES_HOME`, else `~/.futryn`). The shape is `mcpServers`: stdio `{command, args, env}` or HTTP `{url, headers}`. `sse` and `websocket` are skipped. At most 16 servers. The command is one executable, not a shell line. Header and env values are registered with the redactor and are not printed. `.futryn/mcp.json` and `.mcp.json` in the working directory are not parsed and not started; `fyn mcp` only lists those paths when they exist.
2. **One hub, two transports.** `@futryn/mcp` `McpHub` starts stdio with the SDK `StdioClientTransport` and HTTP with the existing `McpClient` plus `listTools`. Stdio is unsandboxed, on purpose: the process comes from the user file, needs a normal environment (`getDefaultEnvironment()` plus the file's env, never the full parent environment) and often needs network or a home directory. Client capabilities are `{}` (no sampling, no filesystem roots). A server that fails to start is `failed` with `timed out`, `cancelled` or `failed to start`. The hub does not decide permissions.
3. **Calls go through ToolDispatcher.** Listed tools are offered as `mcp__server__tool` (`mcp.call`, kind `other`, rule tool `Mcp`). Names that are not a safe permission target are dropped. `default` and `acceptEdits` ask. `plan`, an analysis-only workflow and a read-only sandbox deny with no prompt. `bypassPermissions` and allow rules behave as they do for any other ask. An exact `mcp__server__tool` may be saved as Always; `mcp__server`, `mcp__server__*` and `mcp__*` may not. A session answer grants that qualified name. Results stay untrusted, bounded and redacted. Read-only subagent profiles do not see these tools. Worker and general profiles still go through the same approval.
4. **When it connects.** `fyn mcp` and `fyn mcp list` connect and print status (no command, args, env, headers or URL). `/mcp` in the TUI and in headless chat shows that status. Connect is awaited before the TUI, before `fyn exec` turns and at the start of headless chat. `fyn status` and `fyn doctor` do not spawn servers. Shutdown closes the hub. `mcpIntegration` is `partial` when this port is wired, and `not-implemented` when it is not. `generalToolsExecution` stays `not-implemented`.

## What this slice does not do

OAuth, registry install, project-config launch, annotation modes (every call asks), `tool_search`, `mcp_resource`, sampling, roots and plugins. Linux and third-party servers are **Needs verification**. This ADR does not claim Product MVP completion.

## Evidence

`tests/mcp/user-servers.test.ts` parses a config, drives a local newline JSON-RPC stdio fixture through `McpHub` (list, skip a bad tool name, redact a call, prove the parent secret is not inherited, close kills the process) and through `ToolDispatcher` (deny calls nothing, once prompts `mcp.call`, plan / read-only / analysis-only deny with no prompt, a session grant skips the second prompt). The same file spawns the CLI with a temporary `FUTRYN_HOME` and `HANNES_HOME`: `fyn status` does not create the fixture probe and reports `mcpIntegration: partial`; `fyn mcp list` reports the connected server, omits the token, lists the project files as ignored and does not run them. `tests/security/permission-settings.test.ts` checks that only an exact `mcp__server__tool` is a safe Always rule.
