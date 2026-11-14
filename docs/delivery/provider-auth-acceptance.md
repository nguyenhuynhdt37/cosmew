# Provider & Authentication Product MVP acceptance report

**Decision: NOT COMPLETE / not release-accepted.** A usable executable provider/auth/CLI slice is delivered on `feat/provider-auth-product-mvp`, based on `dev` commit `a05e8dc`. The remaining requirements below are explicit; typecheck and fixture success are not substituted for live generation or subscription support.

Evidence date: **2026-11-14**. Host: **macOS 15.8.1 arm64**, Bun **1.4.4**, TypeScript **7.0.2**. No commercial credentials were read from other applications. Presence checks found no OpenAI/Anthropic/Gemini/OpenRouter API keys in the task environment. No provider generation was attempted with fabricated credentials against a commercial service.

## Delivered artifacts

| Deliverable | Evidence |
|---|---|
| Architecture audit/implementation plan | [Audit and coherent increments](provider-auth-plan.md), baseline file inventory: all original TS/TSX zero bytes, no executable application |
| Upstream research/comparison | [Pinned sources and library recommendation](provider-auth-research.md): all mandatory projects, current @opencode/ai and Vercel AI SDK, official Copilot/Claude SDK review |
| Dependency selection | [Catalog](dependency-catalog.md), [57-entry resolved dependency inventory](provider-auth-dependencies.md), exact bun.lock; install hooks disabled |
| Updated contract/decision | [ADR 0005](../adr/0005-provider-auth-product.md), [scoped ModelPort 1.0](../contracts/model-provider.md), schema-1 configuration/session storage |
| Executable product slice | Registry, real HTTP SDK adapters, account-isolated catalog/cache/manual models, OS credentials/env refs, stable account rotation, selection, SQLite and core Conversation through injected ports |
| Functional CLI | [Setup and usage](../subsystems/providers-and-auth.md); all requested command families plus interactive connection/account/model controls and streamed multi-turn chat |
| Provider/auth evidence | [Verification matrix](../compatibility/providers-auth-matrix.md), tests below and explicit live limitations |
| Security review | [Findings/fixes/residual risks](provider-auth-security-review.md); no unrestricted tool/delegated-agent execution |

## Reproducible checks and results

| Command/check | Observed result |
|---|---|
| `bun install --frozen-lockfile --ignore-scripts` | Pass; lock resolves, no install scripts enabled |
| `bun run typecheck` | Pass |
| `HANNES_TEST_KEYRING=1 bun test tests` | **55 pass, 0 fail; 470 assertions; 4 files**, including 16 actual CLI subprocess end-to-end tests. Both native OS credential tests are opt-in and actually ran on this host; terminal Ctrl-C coverage also ran. |
| `bun test tests` without keyring opt-in | Same deterministic suite, two native keyring tests intentionally skipped; do not claim this verifies a CI OS backend |
| `HANNES_VERIFY_KEYRING=1 bun scripts/verify-keyring.ts` | Live local OS keyring: create/read roundtrip true, delete true; uses only a disposable Hannes entry |
| `HANNES_LIVE_PUBLIC=1 bun scripts/smoke-public-catalogs.ts` | Live OpenRouter public catalog and Models.dev advisory enrichment passed through actual Hannes CLI; authenticated generation explicitly not tested |
| `bun run hannes --help` | Starts successfully with documented command and actual command help |
| `bun audit --json` | `{}`; no advisories reported by the registry at the time of check; not an independent supply-chain certification |
| Package/source inspection | Only core/models/security/persistence → contracts edges; no provider SDK in core, no cross-package private deep import, no unrelated nonempty source/package expansion |
| Content/link/diff inspection | Local Markdown links, patch whitespace, remaining placeholders and credential-pattern scan inspected before commit |

The deterministic fixtures run real local HTTP servers and the real provider SDK translation, then spawn the actual CLI. They are not real vendor model generation. Synthetic keys and model IDs appear only in test fixtures. Production exports no fake model implementation.

Coverage includes strict schema/relationship validation; registry/config persistence; auth missing/rejected/rotation/logout states; multiple accounts; catalog pagination/manual/offline/advisory metadata; model selection; typed errors; Retry-After/jitter decisions; Chat/Responses/Messages/Gemini generation and streaming; validated tool-call data; dropped terminal events; abort/timeout; unknown usage; redirects/foreign origins; key isolation/rollback; late auth validation; secret redaction across chunks; core durability/failure state; and CLI account/provider/context switching. The CLI streaming test observes text before terminal completion and then sends SIGINT, verifying exit 130 and one request.

## Acceptance checklist

- [x] Application starts with documented commands.
- [x] Provider configuration persists across processes/restart.
- [x] Multiple accounts, inspect/rename/use/remove and stable-ID reauthentication are implemented and tested.
- [x] Credentials use OS keyring or explicit environment references, with no plaintext fallback; macOS evidence recorded.
- [ ] Multiple commercial providers are **live** integrated and verified: adapter/protocol/CLI fixtures pass, API credentials are unavailable.
- [x] Dynamic catalog discovery, search/filter, manual entries and offline cache are implemented; public OpenRouter catalog is live-tested.
- [x] Model selection works and unknown capabilities remain unknown; metadata is provenance-tagged.
- [ ] Real paid/local model generation is live-verified: no commercial API credentials; Ollama not running; no actual 9Router URL/model supplied.
- [x] Multi-turn conversations, streaming and explicit provider/account switches pass actual CLI HTTP-fixture tests.
- [x] Useful typed diagnostics, cancellation and local logout/removal work with negative tests.
- [x] Unsupported authentication modes are explicit; no unsupported subscription login is advertised as implemented.
- [ ] Official subscription/delegated-agent integrations are implemented: blocked by missing Hannes tool/permission mediation and unverified integration credentials/terms/flows, not mocked.
- [x] Account/endpoint/model bindings, no silent fallback and no implicit cross-account context transfer are enforced/tested.
- [ ] Full exact token-count/hard-budget and model-specific request-option policy are implemented: output/byte limits and an explicitly labeled estimated-cost guard are implemented/tested; hard dollar ceilings/exact token counts/options remain Not implemented.
- [x] Unit, deterministic adapter integration and actual CLI end-to-end tests pass.
- [x] Available native/public live probes pass; untested model services are explicitly recorded.
- [x] Documentation, ADR, dependency catalog, support matrix and setup/troubleshooting are updated.
- [x] No real credentials are placed in source, repository configuration, CLI arguments or verification artifacts; fixtures use marked synthetic values.

## Exact blockers and limitations

1. **Authenticated live generation** needs user-provided provider credentials and model entitlements. Reproduce with `auth login`, `models list/select`, `model doctor --generate`, then a multi-turn `hannes` session. Record provider/model/date/runtime without keys or prompts. No paid provider is marked live-verified here.
2. **Ollama** at `http://127.0.0.1:11434/api/tags` returned connection refused. Start the daemon and install a model before live acceptance. **9Router** was clarified as user-entered URL + protocol + model; that product workflow is implemented, but no actual service details were supplied. Named gateway identity is not invented.
3. **Subscription delegation** needs a separate enforceable security integration. Official Codex/Copilot/Claude/Gemini/Qwen agents may execute tools; the baseline Hannes general permission dispatcher/sandbox is still empty. Launching them as though they were raw models would violate the requested boundary. Official OAuth clients are not impersonated and no external auth cache is imported. Legitimate future SDK support is not declared prohibited; it remains Not implemented pending these prerequisites.
4. **Routing/token budgets and richer model inputs/options**: no exact tokenizer/count endpoint integration, hard dollar ceiling, image/audio/reasoning request UI or model-specific sampling policy. Text output/request/response/history are bounded; unknown costs stay null. `--max-estimated-cost-usd` is implemented and denies unknown/unaffordable estimates before network, but is not advertised as a billing guarantee. User-authorized automatic fallback is not implemented; failover is explicit account/model switching only.
5. **Platform/storage/recovery**: Linux Secret Service and Windows native backends are unverified. SQLite conversation content is local and unencrypted at application level; no resume/recovery/retention UI, full agent event log, remote tenancy or OS sandbox is claimed. Account removal does not delete prior transcripts. Cancellation cannot undo remote billing.
6. **Tier 2/cloud providers** are assessed but have no named verified integrations/presets. Custom protocol configuration is experimental per endpoint. No SDK import or shared protocol is used as their support evidence.

The code can make actual provider requests once configured with valid credentials. This report deliberately distinguishes that implemented ability from a successfully observed live vendor interaction. Product MVP completion must wait for the unchecked items, not just compilation or additional empty abstractions.

## Interactive authentication follow-up

The user requested `/login` and `/logout` to replace long setup commands. Delivered guided provider/gateway URL/protocol/account/model selection inside chat, signed-out startup, saved-credential reuse, stable-ID reauthentication, logout without exiting, account-targeted logout and `/cancel`. No new dependencies or public domain/schema versions were introduced. A shared bounded reader disables history and suppresses secret echo; wizard answers are consumed outside the chat transcript. Subprocess/PTY tests cover failure, cancellation, masked input, logout/relogin and context isolation. Ctrl-C at the hidden prompt explicitly closes the reader and exits 130 instead of leaving an unresolved input promise. The overall Product MVP decision and vendor live-verification limitations above remain unchanged.


## Provider Connect rebuild follow-up

The current [Provider Connect acceptance](provider-connect-acceptance.md) and [ADR 0007](../adr/0007-provider-connect-and-commands.md) supersede older blanket statements about TUI availability, missing session resume UI and absent OAuth drivers: the real TUI/session picker and official OpenRouter headless PKCE are implemented and fixture/PTY-tested. All live authenticated-provider gates remain pending. The user explicitly chose to configure credentials locally later. This historical report's original checks and broader Product MVP limitations are not rewritten as new evidence.
