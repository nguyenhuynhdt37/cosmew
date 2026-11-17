# ADR 0045 — Remove `delegated` and the chat-only subscription runtimes

Date: 2026-11-17. Status: implemented (contract 1.20, settings schema v7). Plan: `docs/delivery/auth-rework/plan.md`.

## Decision

Every model Futryn uses runs the **Futryn agent loop with Futryn tools, sandbox and permissions**
(backend `hannes`). Two things that could not do that are removed:

1. **`delegated`** (ADR 0029 delegated part, ADR 0027 permission routing for runtime-native tools):
   `/backend delegated`, `setDelegatedAgent`, runtime-native workspace mode, `classifyRuntimeApproval`
   and the runtime approver are gone. `/backend` only reports ownership and says delegation is
   removed. `ExecutionBackendKind` is now `hannes | codex-bridge | chat-only`.
2. **Chat-only runtimes**: Copilot CLI, Gemini CLI, Qwen Code and Grok Build (their providers
   `github-copilot`, `google-subscription`, `qwen-subscription`, `grok-subscription`, ACP/Copilot
   RPC code and recipes). They never ran project tools and, in UAT 2026-11-17, a `grok-subscription`
   run made 0 tool calls in 5 turns. Only Codex remains as a runtime (`codex-bridge`: Codex loop,
   Futryn tools only), as the explicit fallback of ADR 0047.

## Migration (persistence v7)

On first start after the update, inside the schema transaction and on raw settings JSON (the
narrowed runtime enum would no longer parse them): the removed providers and their accounts are
deleted, as are their catalogs, per-project selections and reasoning preferences. The active
account/selection move to another usable account (its `defaultModel` if known) or are cleared.
Vault keys of the removed accounts are queued in `credential_cleanup` and deleted by the
composition root, which owns the vault; a failed deletion stays queued and is retried on the next
start. A one-time notice is printed to stderr. Other accounts, conversations and tool audit rows
are untouched (a past session that used a removed account can no longer be resumed with it).

## Status/UX fix

`status().toolsEnabled` and `availableTools()` now require folder consent **and** a backend that
runs Futryn tools **and** a model that supports tools; previously consent alone listed tools even
for a chat-only backend.
