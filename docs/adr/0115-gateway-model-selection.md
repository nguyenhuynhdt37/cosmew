# ADR 0115 — Gateway model selection before login

Date: 2026-11-22. Status: Accepted. Contract: 1.60 (additive).

The gateway login asks for a base URL and a hidden API key, then displays a searchable list of chat models with advertised context and output limits. An explicit model ID skips the picker. Gateways without a model list accept a manual ID. An origin-only URL can discover a same-origin `/v1/models` after the root catalog returns 404 or 405. The advanced form remains available from the URL step.

The optional `QuickConnectProviderInput.chooseModel` SDK callback receives the discovered models before generation and storage. The CLI and TUI use that callback to choose which model is tested. Non-interactive callers can supply a model ID or use the existing automatic selection. Discovery uses the usual bounded pagination rules. The saved account gets the same catalog that fed the chooser. Advisory metadata from a matching endpoint fills gaps while provider limits take precedence. Unknown context uses the existing conservative runtime estimate. The selected model uses its own capabilities, pricing and reasoning metadata.

Quick login verifies the actual streaming path. Chat gateways that reject the optional usage extension can be verified with the extension disabled, and the host config persists that result as `stream_usage = false`. Existing configs that omit the setting retain their default. The API key stays in the vault. Cancelling the chooser leaves the provider and account unsaved. No event fields or durable schema change.

Verification covers exact limits from a later page, a gateway that rejects the usage extension, a cancelled manual-model chooser, streaming fallback from Chat to Responses, and the TUI model picker.

The live 9Router probe discovered 24 entries and streamed from the explicitly selected `gemini` model. Its catalog reported 1,048,576 context tokens and 64,000 output tokens.
