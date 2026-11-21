# Provider usage and quota attribution

Requested 2026-11-22: fix provider/account usage, subscription quota presentation,
and subagent accounting; verify and commit the scoped change to dev.

- Store bounded source-attributed usage buckets with real account, provider,
  model and session/agent identity. Preserve sums and unknown counters across
  sampling, compaction, nested/background child turns and recovery.
- Group reports by provider/account/model/agent; never assign a child's cost or
  quota to its parent's provider. Legacy aggregate provenance remains unknown.
- Distinguish API credit, request/token rate limits and subscription windows.
  Parse quota only from reported provider data; unsupported integrations remain
  explicit. Show reset, observed/stale source and refresh failures truthfully.
- Separate estimated API list cost from provider-reported amounts and actual
  subscription bills. Missing data is not zero or unlimited.
- No external agent process, credentials, private endpoint probing or paid API
  request. No new dependencies. Public contract and ADR updated at integration.
- Agents own attribution, quota and reporting separately; root integrates,
  reviews, verifies a clean scoped commit and pushes to dev. Existing dirty
  workspace changes remain outside this commit.

## Delivered and verified (2026-11-22)

Contract 1.48; design and upstream evidence are in ADR 0094. Three agents owned
source attribution, quota and SDK/TUI reports; root reviewed and integrated.

- Source buckets preserve provider/account/model/session/agent ownership, unknown
  legacy provenance, cost classes and bounded overflow. Quota selection is based
  on actual timestamps, including ISO strings with different fractional precision.
- Reports distinguish API estimates, reported USD, rate limits, API credits and
  subscription windows. Every quota item retains its own observation/source;
  unavailable data is not a zero balance or unlimited plan.
- Codex windows are parsed when returned in ordinary response headers; live
  subscription entitlement remains Needs verification. No account request or
  external agent process was used to establish this evidence.

Verification:

- Usage-only integration from committed base f5f8892: `bun test tests` —
  **1028 passed, 8 skipped, 0 failed**; `bun run lint` passed. The full-suite run
  also corrected the old subagent-view test's obsolete label/Enter navigation to
  the existing full conversation viewer and its stop action.
- The shared tree was published concurrently as f15a197 and b622ba2, including
  these usage changes. History was preserved; finalization uses b622ba2 as its
  base rather than replaying the same feature changes.
- On that current dev base: the eight focused usage/adapter/quota/agent suites
  pass **79 tests / 413 assertions**; usage/settings/status TUI checks pass
  **13 tests / 72 assertions**; `bun run lint` passes. This focused acceptance does
  not claim whole-project acceptance for other concurrent core/context changes.
- The timestamp-precision regression failed before the final fix and passes
  afterward. Unsupported provider integrations remain explicit.
