# ADR 0044 — MCP HTTP transport and public web tools

Date: 2026-11-17. Status: implemented in wave 1 (contract 1.19); live services **Needs verification**.

## Decision

W5 adds `@futryn/mcp`, an adapter using the official `@modelcontextprotocol/sdk` 1.32.2
Streamable HTTP client. The CLI composition root injects a search port into tools;
`tools` does not import MCP implementations. The public `web_search` tool is registered
through `ToolDispatcher` (`network.search`): policy/rules and audit run before the
adapter, and results are bounded/redacted source data, never host instructions.
Only application-defined public provider endpoints are used; repository configuration
cannot supply transport code or arbitrary endpoints in this slice. Stdio servers,
OAuth, installation, general MCP tools/resources and server management remain W12.

The SDK initializes once per endpoint and sends `tools/call`, with a 30 second
request/initialization deadline, cancellation, 256 KiB maximum HTTP response and
64 KiB maximum text output. Unsupported server requests are not given host services.
Both JSON and SSE responses are exercised by local HTTP fixtures. Redirects and
ambient cookies are disabled. Credentials remain in memory, are registered with the
application redactor, and are never shown in the permission/audit target. SDK error
messages are not exposed because they may contain credential-bearing endpoint URLs.

Search chooses the first configured source in Exa, Tavily, Firecrawl, Parallel order;
without keys it uses Exa's keyless endpoint. A failed provider does not silently send
the query to another provider. `numResults` is 1–10 (default 8); returned links permit
only HTTP(S), with no embedded credentials. Remote results can be incomplete or
malicious: excerpts and titles remain untrusted even after format validation.

**Correction to the plan's source summary:** the pinned OpenCode main source uses
MCP for Exa, Firecrawl and Parallel, but **REST for Tavily** (`POST /search`, bearer
authentication). Futryn ports that verified contract instead of inventing a Tavily
MCP endpoint. Fixtures verify the request shapes; they do not prove subscription,
quota, provider quality or current live endpoint compatibility.

## Sources and evidence

Inspected 2026-11-17:

- OpenCode `sst/opencode` @ `0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4`,
  `packages/core/src/plugin/websearch/{exa,tavily,firecrawl,parallel,mcp}.ts`:
  https://github.com/sst/opencode/tree/0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4/packages/core/src/plugin/websearch
- MCP TypeScript SDK v1 client/HTTP transport:
  https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md
  (rolling v1 documentation checked through Context7); installed npm artifact pinned
  to 1.32.2 and declarations inspected locally in `node_modules/@modelcontextprotocol/sdk`.
- `tests/end-to-end/web-search.test.ts`: real local HTTP JSON-RPC initialize/call,
  JSON/SSE, byte limits, error, deadline/cancellation, redaction and all four provider
  request formats. No paid or live public search request was made.

## Limits

Exa keyless availability/limits and authenticated provider operation remain **Needs
verification**. No background tasks, sampling, OAuth discovery or remote tool
registration is enabled by connecting the search adapter.

## W6 — Public URL fetching

`web_fetch` is a dispatcher-managed `network.fetch` capability. The orchestrator
injects an authorization callback; the runtime refuses requests without one.
Every redirected URL re-enters policy/approval/audit before DNS and connection.
Grants bind the exact origin, so authorizing one site does not authorize another.
`never` refuses network escalation. `WebFetch(domain:...)` and deny/ask precedence
are handled by the shared permission engine rather than the transport.

Only HTTP(S) without URL credentials is accepted. All DNS answers must be public;
loopback/private/link-local, metadata, multicast, special-use IPv4 and IPv6,
IPv4-embedded/transition IPv6 and alternate numeric loopback spellings are refused.
The selected public address is pinned to Node HTTP(S)'s `lookup` callback for the
actual socket, retaining the original Host/TLS SNI and certificate verification.
No second resolver lookup can turn a checked public host into a private connection.
Ambient proxies, credentials, cookies, automatic redirects and decompression are
not used. Maximum body is 5 MiB, maximum redirects five, total deadline 120 seconds
(default 30), with cancellation across authorization, DNS and body collection.
Compressed and binary response types are explicitly unsupported in this slice.

Markdown/text conversion uses inert Turndown DOM parsing and removes script/style,
frames, objects, embeds and templates. Explicit `format: html` returns raw source
as untrusted data. Output is redacted/bounded by the dispatcher. A regression caught
a custom text-format rule taking precedence over removal rules; the rule now
excludes those active-content elements and both formats have coverage.

`tests/security/web-fetch.test.ts` distinguishes pure policy/redirect fixture
checks from actual local socket tests for pinned address/Host, oversized response
termination and abort. It does not claim real Internet/TLS, Linux or Windows
compatibility. `tests/end-to-end/web-search.test.ts` remains the MCP/REST wire evidence.
