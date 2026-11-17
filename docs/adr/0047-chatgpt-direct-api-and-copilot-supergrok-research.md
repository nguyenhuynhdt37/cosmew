# ADR 0047 — ChatGPT through the direct API; Copilot and SuperGrok research

Date: 2026-11-17. Status: ChatGPT implemented, **live behavior Needs verification**; Copilot and
SuperGrok not implemented (research below).

## ChatGPT (implemented)

Provider `chatgpt-api` ("Sign in with ChatGPT", method `oauth-browser`, backend `hannes`, base
`https://api.openai.com/v1`, Responses protocol). Flow, following OpenCode main @0ac0d7e
`packages/core/src/plugin/provider/chatgpt.ts`: loopback authorization-code + PKCE (S256) at
`https://auth.openai.com/api/accounts/authorize` with `client_id=dynamic_agent_client` and
`agent_name_hint=Futryn`; OpenAI returns its issued client id on the callback; code exchange at
`/api/accounts/oauth/token` with `resource=https://api.openai.com/v1`; scope must include
`chatgpt.tokens.use.direct`; the RS256 `id_token` is verified (JWKS, iss, aud, exp, sub, nonce).
No OpenCode or Codex client id is used. Access/refresh tokens are the account's keyring secret;
refresh is single-flight and rotates the stored refresh token; a refused refresh or a 401 is
`AUTH` (sign in again). Cancelled or failed sign-ins store nothing and close the listener.
Request bodies over 256 KiB are zstd-compressed (the sign-in rejects larger uncompressed bodies
per OpenCode). The model list is the OpenCode list, editable. The Codex runtime stays as
"Sign in with ChatGPT via Codex CLI (fallback)" until the direct path is verified live.
Needs verification: dynamic client registration for a new agent name, the model list, `/models`,
and the 1 MiB limit were taken from OpenCode source and exercised only against fixtures.

## GitHub Copilot (not implemented)

Official: the Copilot SDK docs (https://docs.github.com/en/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth,
accessed 2026-11-17) let an app register its **own** OAuth/GitHub App and pass `gho_`/`ghu_`/
`github_pat_` user tokens to the SDK (which drives the Copilot CLI). The page does not document
direct calls to `api.githubcopilot.com`. Other tools instead reuse VS Code's public client id and a
private `copilot_internal` token endpoint; that is an unofficial path and Futryn does not use it.
Conclusion: no legitimate direct-API route; the supported route is the CLI-backed SDK, which is a
chat-only runtime and was removed (ADR 0045). Revisit if GitHub documents a direct model API for
third-party OAuth apps.

## xAI SuperGrok (not implemented)

No official xAI page documenting third-party client registration on `auth.x.ai` was found
(docs.x.ai OAuth pages 404; web search 2026-11-17 returned only third-party docs). Community tools
share one hardcoded client id with scope `grok-cli:access api:access`; borrowing it would
impersonate another client and is refused. Grok remains available with an **API key** (preset
`xai`). Revisit if xAI documents client registration; a user-supplied `client_id` in config.toml
was considered but not built because the endpoints/flow cannot be verified from official sources.
