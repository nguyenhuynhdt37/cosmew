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

`web_fetch` accepts `{url, format?: "markdown"|"text"|"html", timeout?: seconds}`.
It asks through network permission policy for each new origin; redirects never
inherit another origin's grant. It refuses local/private/metadata destinations,
URL credentials, binary files, encoded/compressed responses, bodies over 5 MiB
and more than five redirects. The total timeout defaults to 30 seconds and caps
at 120 seconds. If a site needs compression or browser rendering, this tool
reports an explicit limitation. Raw HTML is inert source data; markdown/text
omit active-content elements. It does not send browser cookies or ambient auth.

W6 verification before integration on 2026-11-17:
`bun test tests/security/web-fetch.test.ts`, exit 0, 7 pass / 0 skip / 0 fail;
`bun run typecheck`, exit 0. Cases cover private/mixed DNS, numeric/IPv6 URL
spellings, policy denial on cross-domain redirects, redirect/byte/deadline limits,
markdown/text conversion, and real local sockets for pinned address/Host and
stream termination. The fixtures inject a trusted app-owned transport for public
DNS success cases; no claim of live Internet service is made. Parent integration
runs record final totals separately in [acceptance](acceptance.md).
