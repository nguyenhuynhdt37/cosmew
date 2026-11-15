# Bản đồ repository và ownership

Approved patches ([ADR 0025](../adr/0025-apply-patch.md)): tools owns patch parsing, verification and orchestration; workspace `secure-files.ts` owns descriptor-relative source-file writes; security owns `fs.write` policy. Persistence retains interrupted write receipts without replay.

Tool migration ([ADR 0024](../adr/0024-tool-execution-architecture.md)): tools owns registry/router, per-tool handlers, shared orchestrator and filesystem/process backends; dispatcher is a compatible ToolPort facade. Security/workspace/process ownership is unchanged.

Task 03B: tools-private ProcessSupervisor owns run cancellation and bounded collectors; CLI caches runtimes per client and awaits shutdown before database close. Contracts expose optional lifecycle/shutdown; TUI reports descendant termination as unconfirmed. See [ADR 0023](../adr/0023-process-supervision.md). No new package edges.

Task 03A foundation ([ADR 0022](../adr/0022-sandboxed-exec-command-foundation.md), [acceptance](../delivery/exec-command-foundation.md)): `contracts/command-runtime.ts` owns the serializable execution port; `tools/exec/{command,output,process,runtime}.ts` owns strict schema, bounded capture, private process lifecycle and experimental Seatbelt policy. `security/tool-policy.ts` owns exact command approval; CLI composes it; SDK binds/revokes approvals and TUI renders pending/results. Production exec_command is disabled because detached cleanup acceptance failed. No other placeholders are activated.

> Current implementation scope: [Provider/Auth PA1](../delivery/provider-auth-plan.md) and [ADR 0005](../adr/0005-provider-auth-product.md). Remaining Phase 0 descriptions below are historical plans, not feature claims.

**Not implemented.** Mỗi đường dẫn dưới đây là placeholder source 0 byte; mô tả là trách nhiệm dự kiến. `index.ts` là public entry tương lai; mọi file khác private trừ ADR công bố subpath. TUI app.tsx là UI entry, không API dùng cho core. Import allowlist chính xác nằm tại [dependency rules](dependency-rules.md); owner trong bảng không cho phép package khác deep-import.

## Public/private và thay đổi cần ADR

Contracts public chỉ gồm domain records/ports, không third-party SDK/Bun types. sdk public là Hannes client protocol. Models/tools/workspace/mcp/extensions/security/persistence/agents chỉ xuất facades qua index; adapters xuất capability report và registration factory, không mở host internals. Apps không được import bởi packages. testkit chỉ test consumers, không production.

ADR bắt buộc cho: public schema/semantics/version, dependency edge mới, shared ownership, package/process boundaries, plugin host privileges, storage migration strategy, runtime/language/framework swap, sandbox/trust model hoặc compatibility claim mới. Refactor private file không đổi contract không cần ADR mới nhưng cần docs/tests trong phase triển khai.

## apps/cli

**Dữ liệu/trách nhiệm sở hữu:** CLI composition, parsed commands và startup ownership. **Đặc tả:** [subsystems/interfaces.md](../subsystems/interfaces.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../apps/cli/src/index.ts) | CLI entry/composition; không loop riêng |
| [`src/commands/run.ts](../../apps/cli/src/commands/run.ts) | Submit headless run, render outcome và exit policy |
| [`src/commands/serve.ts](../../apps/cli/src/commands/serve.ts) | Khởi động server và lifecycle ownership |
| [`src/commands/resume.ts](../../apps/cli/src/commands/resume.ts) | Chọn session/checkpoint, gửi expected revision |
| [`src/commands/models.ts](../../apps/cli/src/commands/models.ts) | Liệt kê model capabilities và diagnostics |
| [`src/commands/mcp.ts](../../apps/cli/src/commands/mcp.ts) | Server discovery/config/auth/connection commands |
| [`src/commands/plugins.ts](../../apps/cli/src/commands/plugins.ts) | Inspect/install proposals/grants/reload commands |
| [`src/commands/doctor.ts](../../apps/cli/src/commands/doctor.ts) | Read-only sanitized diagnostics |
| [`src/bootstrap/startup.ts](../../apps/cli/src/bootstrap/startup.ts) | Resolve config, policy/store locks, inject ports và shutdown wiring |

## apps/tui

**Dữ liệu/trách nhiệm sở hữu:** Draft/editor/render/theme và connection cursor; không domain state. **Đặc tả:** [subsystems/interfaces.md](../subsystems/interfaces.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/app.tsx](../../apps/tui/src/app.tsx) | Client bootstrap, connection lifecycle |
| [`src/screens/chat.tsx](../../apps/tui/src/screens/chat.tsx) | Canonical transcript + partial stream view |
| [`src/screens/sessions.tsx](../../apps/tui/src/screens/sessions.tsx) | Session query/select/resume UX |
| [`src/screens/settings.tsx](../../apps/tui/src/screens/settings.tsx) | Preferences và capabilities, không secret bytes |
| [`src/components/editor.tsx](../../apps/tui/src/components/editor.tsx) | Draft input, submit/cancel actions |
| [`src/components/mascot.ts](../../apps/tui/src/components/mascot.ts) | TUI1 Fyn presentation state/clock and terminal sprite; private UI module, no domain commands |
| [`src/components/messages.tsx](../../apps/tui/src/components/messages.tsx) | Message parts/provenance/render |
| [`src/components/tool-output.tsx](../../apps/tui/src/components/tool-output.tsx) | Bounded sanitized tool output/artifact links |
| [`src/components/diff-view.tsx](../../apps/tui/src/components/diff-view.tsx) | Expected/actual workspace diff và conflicts |
| [`src/components/permission-dialog.tsx](../../apps/tui/src/components/permission-dialog.tsx) | Exact action/hash/expiry approve/deny UI |
| [`src/theme/theme.ts](../../apps/tui/src/theme/theme.ts) | UI theme tokens; không plugin core API |

## apps/server

**Dữ liệu/trách nhiệm sở hữu:** Auth/transport connections và routes; runtime compose qua ports. **Đặc tả:** [subsystems/interfaces.md](../subsystems/interfaces.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../apps/server/src/index.ts) | Compose runtime/store/security/providers, ready/shutdown |
| [`src/routes/sessions.ts](../../apps/server/src/routes/sessions.ts) | Session queries/submit/resume/cancel scoped commands |
| [`src/routes/agents.ts](../../apps/server/src/routes/agents.ts) | Delegation/task queries và authorized commands |
| [`src/routes/plugins.ts](../../apps/server/src/routes/plugins.ts) | Extension metadata/grants/lifecycle commands |
| [`src/transports/http.ts](../../apps/server/src/transports/http.ts) | Command/query framing, auth, limits và error mapping |
| [`src/transports/websocket.ts](../../apps/server/src/transports/websocket.ts) | Event follow/replay cursor/backpressure; không MCP transport |

## packages/contracts

**Dữ liệu/trách nhiệm sở hữu:** Public domain records, versioning, ports; không runtime state. **Đặc tả:** [contracts/agent-events.md](../contracts/agent-events.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/contracts/src/index.ts) | Public exports dự kiến của contracts |
| [`src/events.ts](../../packages/contracts/src/events.ts) | Event/command envelope, errors và sequencing |
| [`src/models.ts](../../packages/contracts/src/models.ts) | Model requests/stream/capability/usage port |
| [`src/tools.ts](../../packages/contracts/src/tools.ts) | Descriptors/invocations/results/registry ports |
| [`src/permissions.ts](../../packages/contracts/src/permissions.ts) | Decision/approval/lease/scope records |
| [`src/sessions.ts](../../packages/contracts/src/sessions.ts) | Session/store/checkpoint/event append ports |
| [`src/extensions.ts](../../packages/contracts/src/extensions.ts) | Manifest/context/hooks/services/delegation ports |

## packages/core

**Dữ liệu/trách nhiệm sở hữu:** Run/step/attempt state, sequencing, context và stop conditions. **Đặc tả:** [subsystems/agent-runtime.md](../subsystems/agent-runtime.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/core/src/index.ts) | Public runtime composition API |
| [`src/agent/engine.ts](../../packages/core/src/agent/engine.ts) | State transitions, revision/epoch fencing |
| [`src/agent/loop.ts](../../packages/core/src/agent/loop.ts) | Model-tools iteration và stop/delegation policy |
| [`src/agent/step.ts](../../packages/core/src/agent/step.ts) | Attempt/fragment assembly/tool batch coordination |
| [`src/context/builder.ts](../../packages/core/src/context/builder.ts) | Immutable prompt snapshot và token accounting |
| [`src/context/compaction.ts](../../packages/core/src/context/compaction.ts) | Summary lineage và budget-preserving compaction |
| [`src/lifecycle/bootstrap.ts](../../packages/core/src/lifecycle/bootstrap.ts) | Validate injected ports và runtime readiness |
| [`src/lifecycle/shutdown.ts](../../packages/core/src/lifecycle/shutdown.ts) | Drain/cancel active runs và bounded cleanup |

## packages/models

**Dữ liệu/trách nhiệm sở hữu:** Provider/capability metadata, stream normalization và usage. **Đặc tả:** [contracts/model-provider.md](../contracts/model-provider.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/models/src/index.ts) | Public model port implementation entry |
| [`src/router.ts](../../packages/models/src/router.ts) | Profile/capability/budget-aware provider selection |
| [`src/capabilities.ts](../../packages/models/src/capabilities.ts) | Verified/unknown capability matrix và metadata sources |
| [`src/streaming.ts](../../packages/models/src/streaming.ts) | Provider deltas/tool assembly normalization |
| [`src/usage.ts](../../packages/models/src/usage.ts) | Token/cost normalization, estimates và price snapshots |
| [`src/providers/router9.ts](../../packages/models/src/providers/router9.ts) | 9Router-specific verified endpoint behavior |
| [`src/providers/openai-compatible.ts](../../packages/models/src/providers/openai-compatible.ts) | Configurable Chat-compatible provider translation |
| [`src/providers/anthropic.ts](../../packages/models/src/providers/anthropic.ts) | Anthropic-specific parts/errors/capability translation |

## packages/tools

**Dữ liệu/trách nhiệm sở hữu:** Tool descriptors, dispatch lifecycle và result validation. **Đặc tả:** [subsystems/tools-and-workspace.md](../subsystems/tools-and-workspace.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/tools/src/index.ts) | Public registry/dispatcher construction |
| [`src/registry.ts](../../packages/tools/src/registry.ts) | Namespaced descriptors, versions/generations |
| [`src/dispatcher.ts](../../packages/tools/src/dispatcher.ts) | Validate/permission/intent/execute/verify/results |
| [`src/builtin/read.ts](../../packages/tools/src/builtin/read.ts) | Scoped read intent và bounded content |
| [`src/builtin/write.ts](../../packages/tools/src/builtin/write.ts) | Expected-revision write và receipt |
| [`src/builtin/edit.ts](../../packages/tools/src/builtin/edit.ts) | Preimage-safe edit/patch intent |
| [`src/builtin/search.ts](../../packages/tools/src/builtin/search.ts) | Scoped lexical/semantic query routing |
| [`src/builtin/shell.ts](../../packages/tools/src/builtin/shell.ts) | Executable/argv/env/cwd intent, bounded processes |
| [`src/builtin/git.ts](../../packages/tools/src/builtin/git.ts) | Git status/diff/worktree/change actions có scope |

## packages/workspace

**Dữ liệu/trách nhiệm sở hữu:** Canonical paths/file revisions/snapshots/worktrees. **Đặc tả:** [subsystems/tools-and-workspace.md](../subsystems/tools-and-workspace.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/workspace/src/index.ts) | Public workspace ports |
| [`src/paths.ts](../../packages/workspace/src/paths.ts) | Root/canonical target/symlink checks |
| [`src/watcher.ts](../../packages/workspace/src/watcher.ts) | Change invalidation và overflow/rescan signals |
| [`src/patch.ts](../../packages/workspace/src/patch.ts) | Expected preimage/apply/conflict receipts |
| [`src/snapshots.ts](../../packages/workspace/src/snapshots.ts) | Workspace snapshot identity và readback references |
| [`src/worktrees.ts](../../packages/workspace/src/worktrees.ts) | Git worktree membership/lifecycle; preserve user edits |

## packages/mcp

**Dữ liệu/trách nhiệm sở hữu:** Connection epochs, negotiated registry và server identities. **Đặc tả:** [subsystems/mcp-integration.md](../subsystems/mcp-integration.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/mcp/src/index.ts) | Public manager/config interface |
| [`src/manager.ts](../../packages/mcp/src/manager.ts) | Per-server clients, lifecycle/reconnect/drain |
| [`src/discovery.ts](../../packages/mcp/src/discovery.ts) | Server inventory và stable tool/resource namespaces |
| [`src/permissions.ts](../../packages/mcp/src/permissions.ts) | MCP identity/tool/resource/prompt → policy scopes |
| [`src/connection.ts](../../packages/mcp/src/connection.ts) | SDK client handshake/capability/result validation |
| [`src/transports/stdio.ts](../../packages/mcp/src/transports/stdio.ts) | Managed stdio spawn/env/stderr/lifecycle |
| [`src/transports/http.ts](../../packages/mcp/src/transports/http.ts) | SDK Streamable HTTP/OAuth/session handling |

## packages/extensions

**Dữ liệu/trách nhiệm sở hữu:** Manifest/config/generation/registration ledger, skill provenance. **Đặc tả:** [subsystems/plugins-and-skills.md](../subsystems/plugins-and-skills.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/extensions/src/index.ts) | Public host/registration API |
| [`src/host.ts](../../packages/extensions/src/host.ts) | Host kinds, scoped service proxies và plugin loading |
| [`src/lifecycle.ts](../../packages/extensions/src/lifecycle.ts) | Init/drain/dispose/reload rollback generations |
| [`src/manifest.ts](../../packages/extensions/src/manifest.ts) | Manifest/contract/host/config validation |
| [`src/installer.ts](../../packages/extensions/src/installer.ts) | Reviewed package proposal/integrity/provenance, không auto grant |
| [`src/hooks.ts](../../packages/extensions/src/hooks.ts) | Stable order/timing/transform/veto rules |
| [`src/skills.ts](../../packages/extensions/src/skills.ts) | Text discovery/selection/provenance, không execute |
| [`src/commands.ts](../../packages/extensions/src/commands.ts) | Namespaced authorized command registration |

## packages/compat-opencode

**Dữ liệu/trách nhiệm sở hữu:** Translation metadata/host capability inventory; không domain ownership. **Đặc tả:** [compatibility/opencode-v1-v2.md](../compatibility/opencode-v1-v2.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/compat-opencode/src/index.ts) | Public compatibility capability report |
| [`src/v1/adapter.ts](../../packages/compat-opencode/src/v1/adapter.ts) | Pinned V1 context/tool/hook translation |
| [`src/v2/server.ts](../../packages/compat-opencode/src/v2/server.ts) | V2 setup/context/registration semantics |
| [`src/v2/tui.ts](../../packages/compat-opencode/src/v2/tui.ts) | TUI commands/routes/slots/dialog/theme host mapping |
| [`src/v2/gui.ts](../../packages/compat-opencode/src/v2/gui.ts) | Future desktop window/main mapping; unsupported without host |
| [`src/v2/rpc.ts](../../packages/compat-opencode/src/v2/rpc.ts) | Pinned RPC codecs/method/error/cancel mapping |
| [`src/v2/sdk-bridge.ts](../../packages/compat-opencode/src/v2/sdk-bridge.ts) | OpenCode client methods → Hannes ports/protocol |

## packages/compat-deepseek

**Dữ liệu/trách nhiệm sở hữu:** Cordis/Harness translation, strategy selection metadata. **Đặc tả:** [compatibility/deepseek-cordis.md](../compatibility/deepseek-cordis.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/compat-deepseek/src/index.ts) | Public capability/strategy inventory |
| [`src/cordis-adapter.ts](../../packages/compat-deepseek/src/cordis-adapter.ts) | Context/Service/Fiber integration, A option chưa chốt |
| [`src/service-bridge.ts](../../packages/compat-deepseek/src/service-bridge.ts) | Versioned scoped services và event-mode mapping |
| [`src/lifecycle.ts](../../packages/compat-deepseek/src/lifecycle.ts) | Fiber/effect cleanup and generation bridge |
| [`src/profile-loader.ts](../../packages/compat-deepseek/src/profile-loader.ts) | Ordered profiles/bundles/patch provenance translation |
| [`src/sidecar.ts](../../packages/compat-deepseek/src/sidecar.ts) | B option supported-IPC boundary, chưa xác minh protocol |

## packages/code-intel

**Dữ liệu/trách nhiệm sở hữu:** LSP versions, AST/index generations và freshness. **Đặc tả:** [subsystems/code-intelligence.md](../subsystems/code-intelligence.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/code-intel/src/index.ts) | Public read-only query port |
| [`src/lsp.ts](../../packages/code-intel/src/lsp.ts) | Server capabilities/document sync/requests/cancel |
| [`src/symbols.ts](../../packages/code-intel/src/symbols.ts) | Normalized symbols/ranges/source provenance |
| [`src/parser.ts](../../packages/code-intel/src/parser.ts) | Tree-sitter grammar/parser lifecycle |
| [`src/indexer.ts](../../packages/code-intel/src/indexer.ts) | Revision-aware generation updates/rescan |
| [`src/search.ts](../../packages/code-intel/src/search.ts) | Lexical/index query merge với stale diagnostics |

## packages/security

**Dữ liệu/trách nhiệm sở hữu:** Policy revisions, decisions, grants, credential references/audit policy. **Đặc tả:** [subsystems/security.md](../subsystems/security.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/security/src/index.ts) | Public decision/enforcement/secret ports |
| [`src/policies.ts](../../packages/security/src/policies.ts) | Deny ceilings và scoped Allow/Ask evaluation |
| [`src/approvals.ts](../../packages/security/src/approvals.ts) | Persisted request/hash/expiry/revoke/CAS leases |
| [`src/sandbox.ts](../../packages/security/src/sandbox.ts) | Backend constraints/capability verification; no fake fallback |
| [`src/secrets.ts](../../packages/security/src/secrets.ts) | Credential refs/vault resolution/redaction |
| [`src/audit.ts](../../packages/security/src/audit.ts) | Redacted decision/execution records và required sink policy |

## packages/persistence

**Dữ liệu/trách nhiệm sở hữu:** SQLite durable records/migrations/transactions và references. **Đặc tả:** [subsystems/persistence.md](../subsystems/persistence.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/persistence/src/index.ts) | Public stores construction/close API |
| [`src/database.ts](../../packages/persistence/src/database.ts) | SQLite lifecycle/migration/locks/transaction boundary |
| [`src/session-store.ts](../../packages/persistence/src/session-store.ts) | Sessions/messages/runs/revisions/materialized views |
| [`src/event-store.ts](../../packages/persistence/src/event-store.ts) | Append/replay/sequence constraints/dedup |
| [`src/checkpoints.ts](../../packages/persistence/src/checkpoints.ts) | Durable prefix/workspace/config references/recovery reads |

## packages/agents

**Dữ liệu/trách nhiệm sở hữu:** Task DAG/queue/leases/budget reservations và child metadata. **Đặc tả:** [subsystems/subagents.md](../subsystems/subagents.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/agents/src/index.ts) | Public scheduler/delegation port |
| [`src/profiles.ts](../../packages/agents/src/profiles.ts) | Child role/config/grant derivation |
| [`src/subagents.ts](../../packages/agents/src/subagents.ts) | Launcher orchestration/context/result isolation |
| [`src/scheduler.ts](../../packages/agents/src/scheduler.ts) | Queue/DAG/worker lease/fairness/cancel cascade |
| [`src/budgets.ts](../../packages/agents/src/budgets.ts) | Atomic parent-child reserve/settle/refund accounting |

## packages/sdk

**Dữ liệu/trách nhiệm sở hữu:** Protocol serialization/reconnect cursor; không core state. **Đặc tả:** [subsystems/interfaces.md](../subsystems/interfaces.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/sdk/src/index.ts) | Public Hannes client exports |
| [`src/client.ts](../../packages/sdk/src/client.ts) | Authenticated commands/queries/events/reconnect/errors |

## packages/testkit

**Dữ liệu/trách nhiệm sở hữu:** Fixture scripts/fake clock/model/tool receipts cho tests tương lai. **Đặc tả:** [delivery/test-strategy.md](../delivery/test-strategy.md). Import policy: [allowlist](dependency-rules.md).

| File dự kiến | Vai trò và ranh giới |
|---|---|
| [`src/index.ts](../../packages/testkit/src/index.ts) | Public testing-only fixture utilities |
| [`src/fake-model.ts](../../packages/testkit/src/fake-model.ts) | Deterministic scripted stream/error/usage fixture port |
| [`src/fake-tools.ts](../../packages/testkit/src/fake-tools.ts) | Effect/receipt/cancel/failure fixture port |

## Thư mục không source và artifacts tài liệu

| Thư mục/file | Ownership và tài liệu |
|---|---|
| README.md / AGENTS.md | Product introduction và rules cho agents; không runtime configuration |
| apps/web/.gitkeep, apps/desktop/.gitkeep | Future hosts; [interfaces](../subsystems/interfaces.md), [GUI host](../compatibility/opencode-tui-gui-rpc.md) |
| docs/README.md | Điều hướng toàn bộ specs và source evidence |
| docs/product/ | Vision, parity backlog và glossary; không acceptance evidence đã chạy |
| docs/architecture/ | System, file map, import graph, event/process/config boundaries |
| docs/contracts/ | Schema/fields/invariants/versioning cho events/models/tools/sessions/extensions |
| docs/subsystems/ | 11 lifecycle/ownership/security/error/concurrency/acceptance specs |
| docs/compatibility/ | Matrix và MCP/OpenCode/DeepSeek evidence, supported-target caveats |
| docs/delivery/ | Catalog, roadmap, tests dự kiến và threat model |
| docs/adr/ | 4 quyết định có alternatives/risks/revisit conditions |
| tests/contracts/.gitkeep | Contract/version/property suites tương lai; [strategy](../delivery/test-strategy.md) |
| tests/compatibility/.gitkeep | Pinned upstream differential/conformance corpus tương lai |
| tests/security/.gitkeep | Negative permission/sandbox/race fixtures tương lai |
| tests/end-to-end/.gitkeep | CLI/TUI/server/GUI acceptance tương lai |
| examples/mcp/.gitkeep | MCP fixture/example sau Phase 4; [MCP](../compatibility/mcp.md) |
| examples/opencode-plugin/.gitkeep | OpenCode examples sau API pin; [OpenCode](../compatibility/opencode-v1-v2.md) |
| examples/deepseek-plugin/.gitkeep | Cordis examples sau A/B gate; [DeepSeek](../compatibility/deepseek-cordis.md) |
| examples/hannes-plugin/.gitkeep | Hannes extension examples sau Phase 5; [hooks](../contracts/plugins-and-hooks.md) |
| native/.gitkeep | Rust/native tối ưu optional; [ADR 0001](../adr/0001-typescript-bun.md) |
| scripts/.gitkeep | Future maintenance tools, chưa có scripts thực thi |
| .github/workflows/.gitkeep | Chỉ placeholder, chưa có CI workflow/deployment |

Không có package.json, tsconfig, lockfile, dependencies hoặc build artifacts. Cây baseline được giữ nguyên; audit/observability/event bus không tạo package mới: ports ở contracts, implementation ownership theo [system overview](system-overview.md). Context có đặc tả riêng tại [context and memory](../subsystems/context-and-memory.md); telemetry tại [observability](../subsystems/observability.md).


## PA1 implemented ownership overlay

The Phase 0 file table above is retained as the original roadmap. Actual nonempty source in this slice is limited to the following owners; other placeholders remain empty.

| Owner | Implemented files / responsibility |
|---|---|
| contracts | index/models/events/sessions: public schemas, safe errors, model/vault/policy/config/conversation ports |
| models | index/registry/accounts/catalog/http/adapter/router: registry, account lifecycle through injected ports, discovery/cache/manual/advisory metadata, gated transport, SDK normalization and explicit selection |
| security | index/secrets/policies: OS keyring and environment resolution, redaction before transcript/UI, endpoint/account policy |
| persistence | index/database/session-store: private SQLite schema 1, transactional settings/cache and transcript revision writes |
| core | index and agent/engine: injected model-only Conversation, pending/complete/interrupted state; no SDK imports or tools |
| apps/cli | index/input/auth-wizard/bootstrap/startup: command parsing, shared chat/wizard input, hidden secret input, guided login/logout and root wiring |
| tests/scripts | contract/security/CLI HTTP fixtures and opt-in OS/public catalog probes; no production fake provider is exported |

New package-internal files are private; all cross-package imports use `@hannes/<package>`. No Hannes package was added, and there are no new package graph edges. The scope does not implement server/TUI/tools or the original full Phase 1 exit gate. [ADR 0005](../adr/0005-provider-auth-product.md).


## PA1/TUI1 Provider Connect rebuild (ADR 0007)

- `packages/models/src/registry.ts`: IntegrationRegistry/AuthMethodRegistry metadata; ModelRouter is also exported as ModelSelector through the public models entry.
- `packages/security/src/provider-oauth.ts`: official OpenRouter headless PKCE lifecycle, bounded/pinned exchange, cancellation/redaction; no vault handle or plugin host.
- `packages/sdk/src/client.ts`: integration/challenge ports, rollback, explicit account/model session boundaries and session-scoped permission grants.
- `apps/tui/src/screens/connect.ts`: bounded searchable registry-driven provider/auth/account dialog, custom endpoints and secret masking.
- `apps/cli/src/bootstrap/startup.ts`: composition-owned auth services and shared validation, including OpenRouter authenticated key probe.
- `tests/security/provider-oauth.test.ts`, `tests/end-to-end/provider-connect.test.ts`: OAuth security, full connection/account/model lifecycle and actual PTY acceptance fixtures.

No package ownership/dependency edge changed. See [ADR 0007](../adr/0007-provider-connect-and-commands.md) and [evidence](../delivery/provider-connect-acceptance.md).


SUB1 files: `apps/cli/src/subscriptions/{host,rpc,login}.ts` own composition-side official runtime lifecycle and line UX; `packages/security/src/subscription-policy.ts` owns fixed recipes and denied capabilities; `packages/persistence/src/runtime-profile.ts` owns private temporary/profile writes; `packages/models/src/subscription.ts` adapts the injected transport to ModelPort. No new package edge. [ADR 0008](../adr/0008-subscription-runtime-auth.md).

## Task 01 Project Context Loader (ADR 0019)

- `contracts/project-context.ts`: injectable context/read ports and content-free provenance reports (contract 1.7).
- `workspace/project-context.ts`: root-to-cwd discovery, overrides, aggregate UTF-8 budget, hashes and refresh. Reads only through the injected authorized reader.
- `tools/dispatcher.ts`: bounded automatic instruction reader sharing canonical paths, security policy, redaction and audit; never automatically prompts for a newly required grant.
- `core/agent/engine.ts`: one transient user-context message per model request, loaded once per turn; no direct filesystem or SDK access.
- CLI composition wires approval-gated loader instances per workspace; SDK and TUI `/context` expose metadata/diagnostics and include loaded bytes in local estimates. No persistence schema or package graph changes.

## Task 02 Progressive Code Exploration (ADR 0020)

- `core/agent/guidance.ts`: provider-neutral exploration guidance and the budget-exhausted notice.
- `core/agent/engine.ts`: per-turn call budget shared by round-based and inline paths, paired `TOOL_BUDGET` refusals, `[unchanged]` reread notice; guidance sent via `ModelRequest.instructions`.
- `models/adapter.ts`: `instructions` → AI-SDK `system`. `cli/subscriptions/{host,project-context}.ts`: guidance appended to Codex developer instructions; inline attempt cap from core.
- Tests: `tests/end-to-end/progressive-exploration.test.ts`, Codex cases in `tests/end-to-end/subscriptions.test.ts`, scripted fixture models in `tests/fixtures.ts` and `tests/subscription-fixtures/runtime.ts`.

## TUI activity presentation (ADR 0021)

- `features/transcript/{types,logic,view}.ts`: ordered `parts`, `explorationRows` grouping, `renderExplorationGroup`, inline reasoning, stored-session rebuild.
- `features/chat/{controller,view}.ts`: parts appended per event, `turnStartedAt`, `turnStatusSpans` status row.
- `ui/types.ts`, `ui/canvas.ts`, `render/ansi-diff.ts`, `types.ts`: optional italic cells.
