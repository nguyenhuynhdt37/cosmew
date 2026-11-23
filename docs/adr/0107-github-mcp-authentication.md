# ADR 0107 — GitHub remote MCP authentication

Accepted 2026-11-22. Shared contract 1.56. SQLite remains schema 13.

GitHub's official remote MCP resource advertises `https://github.com/login/oauth` as its issuer. On 2026-11-22 the authorization metadata endpoint `https://github.com/.well-known/oauth-authorization-server/login/oauth` returned HTTP 200 with PKCE S256 and no dynamic registration endpoint. GitHub requires a host-registered GitHub App or OAuth App for the browser flow. Cosmew uses GitHub's supported personal access token (PAT) flow for the official HTTPS origin and its `/mcp` endpoints.

The MCP snapshot marks GitHub PAT authentication. The TUI presents a masked token field and confirmation. Interactive `cosmew mcp login NAME` prompts for a PAT. Existing credentials commands work with hidden terminal input or explicit stdin for automation. The login action carrying a PAT revalidates the configured target before vault writes and rejects other endpoints. Tokens use the existing endpoint-bound credential store. A 401 leaves the server in a state where sign-in can be retried. Other servers keep their existing browser OAuth support.

Live metadata was verified without credentials. PAT acceptance against GitHub needs verification with an authorized token. [GitHub MCP setup](https://github.com/github/github-mcp-server#remote-github-mcp-server) · [Authorization metadata](https://github.com/.well-known/oauth-authorization-server/login/oauth)
