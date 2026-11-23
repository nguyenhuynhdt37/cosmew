# Cosmew — next fixes and capabilities

> Follow-up implementation is tracked in [audit fixes — 2026-11-23](fix-all-2026-11-23.md). The failures and counts below are the original audit baseline, not the latest status. New feature proposals remain backlog unless explicitly delivered there.

Audit date: 2026-11-22. Baseline: HEAD `1537238` plus the shared dirty working tree, including contract 1.62 and the long-paragraph rendering changes. This is a source/fixture audit; no production changes, commits, paid provider generation, external coding agents or user settings mutations were requested or performed by this audit. Existing review documents describe older snapshots and are not the current backlog.

## Fix first

1. **P0 — Restore a green quality gate.** `bun run typecheck` currently fails at `tests/contracts/provider-reasoning-replay.test.ts:731` (nonexistent adapter `account` member) and `:758` (missing `ModelEvent` import). The replay test also throws at runtime before exercising provider recovery. Repair the fixture through the public account/request interface, then verify the intended encrypted-history failure behavior without silently changing account-bound replay guarantees. Do not expose implementation internals solely to satisfy this test.
2. **P0 — Correct stale memory test setup.** `tests/end-to-end/memories.test.ts` creates state under `home/.futryn`, while the host's memory root resolves to `home/.cosmew`. Five tests in the earlier focused end-to-end run failed because the expected memory entries/context were missing. This is a verified fixture/source mismatch, not proof that ordinary user memory CRUD is broken. Align fixture state/config/memory roots and keep legacy migration as a separately named scenario. Retain the real-state isolation guard.
3. **P1 — Make migration assertions semantic.** `runtime-removal-migration.test.ts` currently expects exactly three startup notices but receives four. Account/credential deletion and API-account preservation assertions pass before that failure. Check which notice is new, assert the required messages and one-time behavior, and avoid making unrelated new notices look like destructive migration failure. Do not weaken credential/data preservation checks.
4. **P1 — Align test expectations with the current configuration/transport contracts.** The broad run additionally fails the project-context environment test because it writes `HANNES_PROJECT_CONTEXT_MAX_BYTES` while production reads `COSMEW_PROJECT_CONTEXT_MAX_BYTES`. Its PTY case times out waiting for the expected UI state before the model assertion; distinguish readiness/rendering mismatch from actual project-context failure. The MCP oversized-response test sends 300,000 characters, which is below the current exported 2 MiB response ceiling; it expects rejection even though a bounded/clipped response is now valid. Test the configured limit and limit+1, including streaming bodies and cancellation, before interpreting this as a missing size guard. The theme precedence test also disagrees with current behavior: the implementation checks COLORFGBG before COSMEW_THEME_MODE, while one fixture expects the reverse. Settle the documented precedence and assert it consistently.
5. **P0/P1 — Finish responsiveness work under sustained load.** The new long-stream regression fails in the full suite despite passing in isolation: initial paint 22 ms and typing 4 ms, but next-delta paint 329 ms (budget 150 ms) and Esc through settled UI 1,070 ms (budget 300 ms). Root cause of the isolated/full-run difference is not established; profile event-loop stalls, retained rendering state and scheduling before changing thresholds. Do not mask it by relaxing the budget. New regressions cover 1,000 history entries, a 1.14M-character stream, next-delta visibility, typing, Esc and completed paragraph scrolling. Existing settled-history coverage uses 3,000 items. Add sustained small-delta streaming, large code fences/tables/tool receipts, growing tool catalogs, search/resize and resume on a real PTY. Measure input latency and event-loop stalls, not only token throughput. Do not declare the maintainer's exact running-session freeze fixed solely from synthetic timings.
6. **P1/P2 — Make command discovery and documentation reflect current capabilities.** `/mcp` and `/rewind` open host panels despite `unavailable` registry handlers; MCP subcommands remain unavailable. `/switch` still describes creating a new session although the current host supports in-place switching. Rename and plain-text export already exist. The historical feature-parity/roadmap tables still say every capability is unimplemented. Reconcile help/autocomplete/SDK metadata and distinguish historical plans from current acceptance.
7. **P1 before distribution — Verify supported host/install combinations.** macOS native checks exist; `BubblewrapSandbox` explicitly remains untested on a Linux host and `--unshare-net` cannot reach the host proxy. CI configuration exists but does not prove those skipped native capabilities. CLI packaging is still a private workspace package pointing at TypeScript source. Add a clean install/upgrade/resume smoke test, artifact version/hash evidence, and actual Linux sandbox checks before advertising support.

## Build next, in this order

### 1. Deferred MCP tool search and schema loading

Highest feature priority for the reported large-context problem. Core currently offers all descriptors from the tool port; it accounts for schema bytes but does not defer them. MCP discovery visibly caps at 64 tools / four pages per server. The removed global model-request tool-count limit allows larger catalogs but does not reduce their context cost.

Add a model `tool_search` that searches bounded catalog metadata and loads only selected schemas. Support on-demand pagination, context budgets, registration identities and stale-schema rejection. Every selected call still enters ToolDispatcher and the existing permission/schema/audit chain. Acceptance: a 200+ tool fixture remains searchable without front-loading all schemas, removal/reconnect invalidates old identities, and large catalogs do not monopolize typing or context preparation. This is distinct from the existing manager's local text filter.

### 2. Executable hooks and completion checks

`HooksSnapshot.supported` is literally `false`; `client.hooks()` returns no executor. Start with PreToolUse/PostToolUse/Stop, bounded timeouts/cancellation and explicit trusted configuration. Use this to run project verification after edits and prevent an unverified completion claim. Repository input must not become automatic host execution or a permission grant. Acceptance includes hook failure, cancellation and revalidation, not only successful formatting.

### 3. MCP resources/prompts, then supported media

MCP manager/OAuth/reconnect/install already exist. Model resource discovery/read and prompt discovery/get do not. Current non-text results explicitly report unsupported content rather than returning empty success, which is already a correctness improvement. Add bounded resource discovery/read with permissions and URI/identity binding; support useful image/resource attachments afterward. Keep update/rollback of managed packages as separate work with exact-version provenance.

### 4. IDE/ACP bridge

Existing LSP is code intelligence, not an editor integration. Add one small protocol-backed workflow for current file/selection/diagnostics, conversation streaming, cancellation and approvals, reusing the Cosmew loop and dispatcher. Build one editor integration before a full web/desktop product. This is a later capability, not a prerequisite for the current CLI fixes.

Complete the high-load responsiveness investigation before these feature additions. Auto-memory with candidate review, a dependency-aware shared agent task graph and a general plugin host remain later work. Do not prioritize them over green checks, context efficiency and reliable completion.

## Already implemented — do not rewrite as missing features

Workspace-scoped session ownership; compaction/cancellation usage retention; standalone summary billing; memory lock/journal recovery; Git worktree handoff with preimage validation; queue/steer/background subagents; LSP; MCP manager with OAuth/bearer and managed npm installation; session rename/plain-text export; skill visibility management. Their presence does not certify every provider/OS or resolve unrelated fixture failures.

## References and evidence limits

Current source: `packages/sdk/src/client.ts`, `packages/sdk/src/commands.ts`, `apps/tui/src/ink/features/commands.ts`, `apps/cli/src/bootstrap/startup.ts`, `packages/core/src/agent/request-context.ts`, `packages/mcp/src/{client,servers}.ts`, `packages/contracts/src/hooks.ts`, `packages/tools/src/exec/bubblewrap.ts`, `apps/cli/package.json`. Prior delivery evidence: `product-stability-fixes-2026-11-22.md`, `mcp-ux-gap-audit-2026-11-22.md`, `tui-v4/performance-transcript.md`.

Official upstream documents opened on 2026-11-22 (documentation snapshots, no installed upstream runtime revision verified):

- [Claude Code hooks](https://code.claude.com/docs/en/hooks): lifecycle events and completion/tool checks.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): tool discovery, reconnection, OAuth and resource workflows.
- [OpenCode ACP](https://opencode.ai/docs/cli/acp/): a concrete editor/client integration pattern.

These inform recommendations; they do not establish complete compatibility. Linux/live-provider/installed-artifact claims remain Needs verification where no dedicated acceptance exists.

## Fresh verification from this audit

`bun run typecheck`: exit 1, two errors in `provider-reasoning-replay.test.ts` as described above.

`bun run test`: exit 1, **2,045 pass / 13 skip / 12 fail**, 2,070 tests across 227 files, 8 snapshots, 52,823 assertions, 482.17 seconds on this macOS source tree. Grouped failing cases:

| Group | Failing tests | Interpretation |
| --- | ---: | --- |
| Provider replay | 1 | Fixture accesses nonexistent account member and never reaches the intended recovery behavior |
| Runtime removal migration | 1 | Startup notice count 4 versus expected 3; prior account/credential preservation checks passed |
| MCP response size | 1 | Fixture payload is below the current response ceiling |
| Project context | 2 | Legacy environment-variable assertion and a PTY UI-state wait timeout |
| Memory | 5 | Entries/context absent; fixture points to legacy state while host uses canonical memory root |
| Theme | 1 | Environment precedence expectation differs from implementation |
| Long streaming paragraph | 1 | Full-suite delta paint 329 ms and settled cancellation 1,070 ms; isolated performance does not establish stability |

The typecheck errors overlap the provider fixture failure; do not add them to the test-failure total as distinct production defects. Individual failures above require fixes or contract-aligned tests, not weakening data/permission assertions to force a green total. This audit did not repair them.

The same aggregate run passed the new native headless bypass/external-cwd/ask/deny test. The continuous 2,000-line native PTY stream test also passed, measuring input-to-output 37–54 ms. These cover different stress patterns from the failing giant-paragraph test. No aggregate "all fixed" or live user-session acceptance is claimed.

Recommended implementation sequence: **repair quality fixtures/typecheck → profile/fix high-load long-paragraph responsiveness → deferred tool search → executable hooks → MCP resources and verified release/install → IDE bridge**. Existing installed/live-user acceptance remains separate.
