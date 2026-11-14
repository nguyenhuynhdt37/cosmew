# ADR 0007: Provider Connect registry and canonical commands

Accepted 2026-11-14 for the user-requested PA1/TUI1 Provider Connect rebuild. This extends ADRs [0005](0005-provider-auth-product.md) and [0006](0006-futryn-tui-and-theme-engine.md) without enabling the plugin host, MCP, tool execution or delegated agents.

## Audit and decisions

The working tree already contained an uncommitted TUI/theme implementation. Preserve that renderer, theme system, CLI administration, provider SDK adapters, account/vault/catalog stores and package graph. The renderer is a native ANSI cell compositor, not OpenTUI; no renderer or framework migration is included. No dependency was added or installed.

Composition owns `IntegrationRegistry` and `AuthMethodRegistry` in models, combining presets and durable custom providers; UI obtains method metadata through SDK ports. Reuse AccountManager, security CredentialVault/SecureVault, ProviderAdapter and ModelRouter (also exported as ModelSelector). UI never gets a vault handle, verifier or issued OAuth API key. Extensibility is through scoped metadata/challenge/completion ports; executing externally supplied auth plugins remains **Not implemented**, because the plugin host is outside the authorized slice. MCP auth remains separate.

Only official OpenRouter endpoints receive the OpenRouter headless OAuth PKCE method. Security owns random S256 verifiers, ten-minute/single-use challenges, pinned HTTPS code exchange, bounded responses, cancellation and redaction. The user opens the authorization URL and pastes a hidden one-time code. No callback listener, external process, browser cookie import, borrowed OAuth client identity, refresh token or consumer-subscription entitlement is used. The returned API key is stored via AccountManager in the OS keyring. Other providers expose their actual API-key/env/no-auth methods. Device-code and delegated-CLI drivers remain **Not implemented**. OpenRouter validation uses authenticated `/key`, since its public `/models` does not prove authentication. No key metadata is logged.

`/login`, `/logout`, `/model`, `/status`, `/config`, `/permissions`, `/mcp`, `/plugin`, `/theme`, `/resume`, `/clear`, `/compact`, `/help`, `/doctor`, `/exit` are canonical. Existing names remain aliases; unsupported backends give explicit diagnostics. Shell-mode input is rejected before provider invocation. Permission UI no longer manufactures demo requests. Permission grants hash the full capability/action/target tuple with built-in SHA-256 rather than truncating a target prefix; grants are cleared at conversation boundaries.

A conversation's provider/account/model and durable selection remain pinned. Changing the model starts a fresh conversation, as account switching already did, avoiding the previous mismatch where SDK status changed but the backend invoked the original adapter. Previous sessions remain resumable. Cross-model history transfer is not automatic.

## Contract version and migration

Public scoped contract advances **1.0 → 1.1**, adding auth-method/integration/challenge metadata and optional SDK challenge ports/input fields. All production consumers (composition root, CLI, SDK and TUI) are updated together. Provider/account/credential/selection schemas and SQLite/settings schema **1** remain unchanged. OpenRouter OAuth produces an existing `keyring` credential; no secret-bearing storage migration is needed. Existing settings, model catalogs, accounts, themes and sessions load unchanged. Challenge/verifier and permission-grant state is ephemeral and never migrated or replayed. Older SDK fixture consumers without optional integration ports return an empty integration list; production composition always supplies them. Missing auth-driver ports fail with `UNSUPPORTED`.

Failed or cancelled new SDK logins delete credentials/account state. Reconnect preserves stable account ID but logs the account out on failed validation. If keyring deletion fails, routing is fenced first and the retryable account stays visible for `/logout`; errors never claim successful cleanup. Local logout cannot revoke a remote API key or erase a parent shell's environment.

## Evidence and remaining gates

See [audit, command mapping and acceptance](../delivery/provider-connect-acceptance.md). Deterministic HTTP/PTY/native-keyring results are distinct from vendor evidence. Authenticated live model generation and live OpenRouter authorization are pending user configuration. No Product MVP release acceptance is claimed.
