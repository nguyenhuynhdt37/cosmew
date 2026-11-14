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
