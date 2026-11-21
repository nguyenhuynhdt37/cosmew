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
