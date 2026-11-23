# ADR 0109 — MCP OAuth discovery and recovery

Accepted 2026-11-22. Contract 1.57, SQLite schema 13. No new dependency.

When explicit login lacks discovery state, Cosmew sends a bounded, credential-free MCP initialize probe and follows the 401 challenge's protected-resource metadata and scope with the existing pinned fetch and issuer/resource checks. If the server provides no challenge, it still tries the standard metadata URLs. Dynamic registration chooses a supported OAuth token authentication method (public PKCE, client secret Basic, or client secret POST).

Authentication failures expose allowlisted reasons for unavailable or invalid metadata, a missing registration grant, an unsupported flow, registration failure, browser authorization failure and token exchange failure. An unrecognized provider body is never used as a diagnostic. Missing registration capability is detected on connect when the server publishes it and checked again on explicit retry. Reconnect and cancellation keep the existing lifecycle guarantees.

When available, bearer fallback is reachable in the MCP detail panel and documented by the CLI. It uses masked input or explicit stdin, revalidates the shown origin and path before storing, and keeps credentials bound to the exact configured endpoint in the vault. An endpoint that requires a preregistered OAuth client or browser-only policy still requires provider-supplied credentials and an appropriate registration setup. GitHub's existing PAT route remains available.

Verified with real local HTTP OAuth callbacks, injected connection responses, and CLI/TUI tests. Live authenticated third-party acceptance needs verification. Upstream inspected 2026-11-22, installed MCP SDK 1.32.2 `dist/esm/client/auth.js`. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
