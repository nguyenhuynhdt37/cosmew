# Provider/Auth audit and implementation plan

Branch: `feat/provider-auth-product-mvp`; baseline: `a05e8dc`; authorization/access date: 2026-11-14.

Audit: inspected the entire file inventory, all contracts, architecture ownership/dependency rules, roadmap, dependency catalog, subsystem and compatibility documentation. All sources are empty; the original Phase 1 includes tools/9Router/TUI prerequisites outside this task. ADR 0005 authorizes a narrower product slice with no package tree expansion. No existing executable API or feature can be preserved by compiling placeholders.

1. Record pinned upstream evidence and evaluate dependencies before install. Compare current @opencode/ai against Vercel SDK and document official subscription restrictions.
2. Add evaluated Bun workspace tooling and version 1 scoped contracts, validate package graph and contract schemas.
3. Implement secure credentials, account isolation and private transactional configuration/catalog/session storage; verify lifecycle and failure behavior.
4. Implement registry, dynamic model discovery/manual models/advisory metadata and adapters; deterministic HTTP tests for native and compatible protocols, errors, tools, streaming, timeout/cancel.
5. Add explicit model/account routing and core multi-turn conversation via injected ports; enforce no implicit transfer/fallback.
6. Build actual CLI configuration/auth/catalog/model/account/doctor/chat workflows and noninteractive alternatives, then subprocess end-to-end tests.
7. Review security, run typecheck/test and available opt-in live probes; publish exact support matrix, setup, troubleshooting and acceptance report. Never substitute fixture success for live evidence.

Each increment requires its relevant checks before proceeding. Final acceptance requires the user's complete checklist; missing credentials, gateway identity, official OAuth registration or unavailable environments are recorded as blockers, not successes.

## Increment outcome

Foundation schemas/storage/security were typechecked and tested before adapter work. Adapters/catalog/accounts passed deterministic protocol tests before CLI integration. Core/CLI passed subprocess end-to-end tests before security review and live probes. Negative review tests found and fixed model alias validation, missing JSON Schema runtime validation, credential-reference reuse and late-validation/logout races. Final scoped implementation is delivered; overall Product MVP remains pending the exact blockers in the [acceptance report](provider-auth-acceptance.md). No unrelated phase was advanced.

## Interactive authentication follow-up

User requested `/login` and `/logout` to avoid long setup commands. CLI now starts signed out, presents a guided provider/gateway/account/model wizard, reuses existing auth/vault/validation ports and keeps the prompt open after logout. No domain contracts, dependencies, package boundaries or provider support claims change. Chat and wizard use one bounded input reader with history disabled and secret echo suppression. Verify actual subprocess login/logout/relogin, cancellation/failure/context isolation, and a real terminal/keyring roundtrip before delivery.


## Provider Connect rebuild

User-requested 2026-11-14. Audited the current dirty PA1/TUI1 implementation and current OpenCode/Claude references before editing. Reused existing adapters, core, stores, theme renderer and CLI; added registry-driven search/auth/account flow, official OpenRouter headless PKCE, custom endpoint setup, command migration/diagnostics, rollback and pinned model/session behavior. Tests include actual HTTP/PTY and disposable native-keyring flows. See [ADR 0007](../adr/0007-provider-connect-and-commands.md) and [current evidence](provider-connect-acceptance.md). No dependencies installed, external agents delegated or unrelated placeholders implemented. Live authenticated provider testing remains pending the user's local credential configuration.


SUB1 is authorized by the follow-up request to support subscriptions, with the subsequent UX correction making vendor grouping and immediate sign-in mandatory. [ADR 0008](../adr/0008-subscription-runtime-auth.md) and [implementation/evidence](subscription-auth.md) record the bounded runtime transports, contract migration and live gates.
