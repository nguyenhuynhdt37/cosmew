# ADR 0094: Provider usage and quota attribution

Date: 2026-11-22. Status: accepted. Shared contract: 1.48. SQLite schema unchanged.

## Problem

Session usage grouped receipts by model name, so identical model names across
providers were merged. Child usage was folded into a parent receipt without
retaining its provider/account/model identity. The last child response could also
replace the parent's top-level quota snapshot. OAuth authentication was used as
an unsupported proxy for subscription quota in reports.

## Decision

Usage optionally contains flat `breakdown` buckets. Each bucket retains the
known account, provider, model, session and agent identity, counters, cost
provenance and quota snapshots. Adapters bind actual request identity; core adds
session identity; subagent folding adds its agent identity while retaining
nested descendants. Repeated usage/completed snapshots replace the current
request's measurement; completed requests add once. Compaction and late
background usage use the same durable JSON receipt path.

Buckets partition aggregate counters; they are not another set of billable
requests to add to those counters. Missing counters remain unknown. Estimated,
reported and unknown cost classes stay distinct. Legacy aggregates have unknown
source provenance; they are not assigned to the current account or parent model.
At most 4096 buckets are retained; overflow coalesces into an unknown-source
bucket without losing counters and sets `breakdownTruncated`. Quota is not
assigned to that overflow source. Multi-source aggregates omit top-level quota
and pricing labels; source snapshots retain them. An omitted or older quota
response cannot erase a newer observed snapshot.

SDK and TUI reports group source usage by provider/account/model and agent/session.
Reported USD and estimated API list cost are separate; neither is described as a
subscription bill. Unknown sources and partial price/token coverage remain visible.

Quota distinguishes `rate-limit`, `subscription-quota` and `api-credits`.
OpenAI/Anthropic response rate-limit headers remain supported, now with model
scope. Codex primary/secondary used-percent/window-minutes/reset-at headers are
parsed only when actually returned. Existing OpenRouter key-credit refresh stays
on its official endpoint. No private endpoint probing or new authenticated
request is introduced. Unsupported integrations say so; missing is never zero or
unlimited. Account snapshots are selected from source-owned history regardless
of session selection/order; legacy unowned quota cannot be claimed as a parent's
allowance. Refresh failures retain the old value/time and mark it stale; aborted
refreshes do not overwrite evidence. Reports show each item's source, observation age, reported window and reset. Mixed credit/reply
snapshots retain separate timestamps; expired snapshots remain visibly stale
rather than assuming a reset.

## Evidence and boundaries

- Official Codex parser, inspected 2026-11-22, revision
  `586bd4b891fab95ad3abf9ff57e38746c63d7499`:
  https://github.com/openai/codex/blob/586bd4b891fab95ad3abf9ff57e38746c63d7499/codex-rs/codex-api/src/rate_limits.rs
- OpenAI rate-limit headers describe request/token capacity, not subscription
  entitlement or credit balance:
  https://developers.openai.com/api/docs/guides/rate-limits (retrieved 2026-11-22).
- OpenRouter key credits: https://openrouter.ai/docs/api/reference/limits .

Live subscription header availability for a particular account/provider remains
**Needs verification**. Claude subscription authentication is not implemented by
this change. No external agent runtime, dependencies, credentials, sensitive
prompt/output persistence, or settings-trust changes are added.

## Validation

Regression coverage exercises same-name models on different providers, unknown
legacy attribution, mixed costs, repeated stream snapshots, nested/late agent
usage, SQLite reopen, bounded overflow, all four provider protocol adapters,
source-owned quotas, malformed headers, reset/staleness, cancellation, refresh
failure and unsupported providers. Final commands/results are recorded in the
provider-usage delivery note; fixture tests do not establish live entitlement.
