# Wave 1 web tools — usage and evidence

Decision: [ADR 0044](../../adr/0044-mcp-and-web-tools.md).

`web_search` accepts `{query, numResults?}` (1–10, default 8). It sends the query to
one fixed public search provider. `EXA_API_KEY`, `TAVILY_API_KEY`,
`FIRECRAWL_API_KEY`, `PARALLEL_API_KEY` select that provider in this order; without
keys, Exa keyless is used. Keys are read from the host environment by the CLI,
never from repository configuration, persisted in settings or included in audit
URLs. Search result links/titles/excerpts are untrusted data. Service/quota/auth
failures report an error with key-configuration guidance; no silent provider fallback.

W5 verification on 2026-11-17: `bun test tests/end-to-end/web-search.test.ts`, exit 0,
6 pass / 0 skip / 0 fail. This exercises real local HTTP against the production MCP
SDK and Tavily REST adapter: initialization reuse, exact argument/auth shape,
JSON/SSE, registered-secret redaction, output/wire limits, deadline/cancellation and
upstream error. It establishes fixture interoperability only. No live search,
provider account or result quality benchmark was run. Those remain **Needs verification**.

No Postman installation/workspace was present or needed: repository-owned Bun
HTTP fixtures are the executable protocol evidence. No remote workspace, mock
publication or unrelated API setup was created.
