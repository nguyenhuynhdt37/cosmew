# ADR 0005: Provider and authentication product slice

Accepted 2026-11-14 for implementation, authorized by the Provider & Authentication Product MVP request. This supersedes Phase 0 restrictions only for the scope below. Product acceptance remains pending evidence.

## Audit and scope

Baseline `a05e8dc` on `dev`: all TS/TSX files are zero bytes; no manifests, executable tests, application, vault or permission engine. Existing contracts are proposals, not a deployed ABI. Preserve package graph and public entries. Implement contracts/models/security/persistence/core/CLI and their tests, leaving every unrelated subsystem untouched. No general tool execution is enabled.

## Decisions

Use Bun/TypeScript, the Vercel AI SDK generation primitives and native OpenAI/Anthropic/Google adapters plus OpenAI-compatible Chat. The current @opencode/ai 2.3.0 is a real Effect-backed protocol library, not the historical Vercel wrapper; its broader runtime/schema/cloud dependency surface is unnecessary for this slice. Hannes owns routing, accounts, catalog, policy, retries and conversations. SDK agent loops and execute callbacks are excluded.

Provider identity, account UUID, credential reference and model ID are distinct. Custom gateways accept explicit URL + protocol (chat, responses, anthropic or gemini) + manual model ID. No assumed 9Router identity; the user's clarification requests this configurable gateway workflow. Credentials are never URL fields or CLI arguments. Use evaluated native OS keyring, with explicit environment-reference mode for headless users. No plaintext fallback. Credential access is injected into models; security owns the implementation. API key logout deletes the local secret; remote revocation requires the provider console.

Persistence owns versioned user configuration and catalog cache in a private user directory, and SQLite conversation writes. Core only imports contracts and receives ModelPort/ConversationStore; apps compose public package entries. No new Hannes dependency edges. Account-bound catalog caches prevent one account's model entitlement leaking to another. Dynamic model listings are authoritative for availability only, not inferred capabilities. Manual records keep capabilities unknown; Models.dev is optional advisory metadata with provenance, not an availability source.

Model invocation requires an explicit account/model binding and network target authorization. Endpoints are HTTPS except explicit loopback HTTP for local services, reject credentials/query/hash, reject redirects, and do not accept executable configuration. No automatic fallback. Switching conversations to another provider/account starts a fresh context; cross-account transfer is not implicit. No shell, filesystem tools or delegated-agent subprocess can bypass future permission enforcement.

## Contract and storage versioning

Implement a scoped `1.0` model/conversation API in contracts, separate from the still proposed full agent event/tool loop. Public messages support text and descriptor-only tool inputs; normalized tool calls are data and are never executed. Unknown usage/cost remain null. Optional estimated-cost admission rejects missing prices or an estimate above the user limit before network, without claiming exact token counting or a hard billing ceiling. Full durable agent event envelopes are not claimed implemented. Consumers in this slice migrate together; there are no preexisting executable consumers or stored data. Config schema 1 and SQLite schema 1 reject newer versions; no downgrade or credential import. Future incompatible changes require a new ADR/migration.

## Reliability and evidence

Use bounded requests/streams, total deadlines, cancellation, normalized safe errors, bounded jittered retry only on safe GET discovery (never automatic generation retry after possible remote acceptance), and Retry-After ceilings. SDK retries disabled. Provider-auth failure does not change endpoint. Raw provider bodies/errors and prompts are excluded from diagnostics/telemetry. Subscription-only authentication is not a raw API entitlement; official agent SDKs require separate security-reviewed delegation and are not enabled by this slice.

Fixtures establish protocol behavior, not live compatibility. OS keyring and available live endpoint evidence are reported separately. Cloud/Tier 2 providers have no support claim without their own verified evidence. Production readiness remains blocked if acceptance requirements are missing.
