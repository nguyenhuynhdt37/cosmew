# ADR 0046 — Host provider configuration (`~/.futryn/config.toml`)

Date: 2026-11-17. Status: implemented (contract 1.20). Evidence: Codex @090be4d
`model-provider-info/src/lib.rs` (field names, caps, auth command).

## Decision

Any OpenAI/Anthropic/Gemini-compatible endpoint is added by configuration, like Codex
`model_providers`. The file is `<state directory>/config.toml` (`FUTRYN_HOME`, default `~/.futryn`),
**user-level only**: a workspace never contributes providers, so a cloned repository cannot send
prompts to its own host or make Futryn run its commands (tested). The file must be a regular file
owned by the user and not group/world-writable. Bun's built-in TOML parser is used (no dependency).

```toml
[model_providers.router9]
name = "9Router"
base_url = "https://router.example.com/api/openai/v1"   # path prefix kept; http only for localhost
wire_api = "chat"                  # chat | responses | anthropic | gemini
env_key = "ROUTER9_API_KEY"        # optional hint; keys live in the keyring or an env reference
models = ["anthropic/claude-sonnet-4", "openai/gpt-5"]   # or omit: GET {base_url}/models
requires_auth = false              # Futryn extension; default true
stream_idle_timeout_ms = 900000
request_max_retries = 4            # Codex caps: 100
stream_max_retries = 5
[model_providers.router9.http_headers]       # never credentials
X-Title = "Futryn"
[model_providers.router9.env_http_headers]   # header = environment variable NAME; skipped if unset
X-Org = "ROUTER9_ORG"
[model_providers.router9.query_params]
api-version = "2025-01-01"
[model_providers.router9.auth]               # token command, executed directly, never via a shell
command = "/usr/local/bin/print-token"
args = ["--json"]
timeout_ms = 5000                            # max 60000
refresh_interval_ms = 300000
```

Rules: unknown fields are errors; `experimental_bearer_token`, `gateway_oauth`, `aws`, … are refused
(plaintext tokens never live in files); credential-like header names (`Authorization`, `*-key`,
`*token*`, cookies) and token-looking static values are rejected, secrets come from `env_key`, the
keyring, `env_http_headers` or the auth command; `model_catalog_url` must be on the same origin
and below `base_url`; ids of built-in sign-in providers are reserved. A bad provider is reported in
`/doctor` and `fyn providers list` and skipped; it never blocks startup.

Loading: providers are synced into settings with `source: 'config'` at startup (the file is the
source of truth; a removed entry that still has accounts is kept). The token command stays in
memory only. Its cached token is bound to a hash of `{id, base_url, command, args, env_key}` and
invalidated when the provider is replaced or removed, so a token is never sent to another host
after a config change. Headers, query and env headers are applied in `ProviderTransport.request`, the
single egress for model streams and catalog calls. `fyn providers add` and the `/login` "Custom
provider" form write the same file and validate with the same rules. The empty `router9` preset
file was removed: gateways are configuration.
