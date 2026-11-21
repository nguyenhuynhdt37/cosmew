# Tools và permission contracts

Contract **1.43** adds `agent.spawn` to permission-prompt capabilities for
explicit `agent_message` control. The public SDK action routes through the
existing ToolDispatcher, with `Tool(agent_message)` rules and approval scope
bound to parent session, workspace, child and exact instruction. Plan/Review and
read-only modes refuse it; cancellation, revoked grants, changed parent and
tightened rules are rechecked before execution. Other agent operations retain
their existing checks. No UI or SDK path directly invokes the manager. See
[ADR 0089](../adr/0089-subagent-task-management.md).

Contract **1.43** also has optional `PermissionPromptRequest.commandSandbox`
for shell launches, including in SDK interaction events. `disabled` means
effective settings turn the sandbox off. `escape` means the model requested
`dangerouslyDisableSandbox` with the sandbox enabled. `excluded` means the
launch matched `sandbox.excludedCommands`. `sandboxed` means the runtime
applies containment. The field is display metadata. Permission decisions,
approval scopes, and saved rules follow the existing policy. Legacy prompts
and terminal input can omit the field and keep their existing presentation.
[ADR 0081](../adr/0081-sandbox-defaults-like-claude-code.md)

Contract **1.41** adds host-owned optional `ToolResult.evidenceDigest` and
`evidenceOutputId` for canonical redacted evidence and its current archive handle
([ADR 0083](../adr/0083-context-evidence-dedup.md)). They never grant permission or
skip producer execution. Output archive sources also support `mcp`; retrieval
reauthorizes MCP access under the current session/workspace/policy/grants without
replaying remote calls ([ADR 0084](../adr/0084-mcp-tool-execution-correctness.md)).
The MCP validator supports the explicitly bounded subset documented in that ADR;
unsupported tools are hidden from model descriptors and direct calls explain the
refusal. Coding-tool fixes are in [ADR 0085](../adr/0085-coding-tool-correctness.md);
task-appropriate verification is in [ADR 0087](../adr/0087-task-aware-verification.md).

Contract **1.10** adds approval-gated `apply_patch` with `fs.write`, JSON `{patch:string}` input and actual-change/partial-failure text receipts. ToolPort, ToolResult and persisted schemas remain compatible. [ADR 0025](../adr/0025-apply-patch.md) defines exact-plan grants, workspace-owned writes and transport/OS limits.

Task 03B contract **1.9** ([ADR 0023](../adr/0023-process-supervision.md)) adds optional CommandOutcome.lifecycle observations and optional CommandRuntime.shutdown(). Absent lifecycle fields mean unconfirmed. Existing injected runtimes remain source-compatible. No request, ToolResult or database schema migration; stored model-facing text preserves lifecycle observations. Exit code 0 certifies only the leader exit status.

Task 03A contract **1.8** ([ADR 0022](../adr/0022-sandboxed-exec-command-foundation.md)): additive process.execute tool capability, optional exitCode/durationMs on ToolResult, and CommandRuntime/CommandRequest/CommandOutcome ports. Core still sees only ToolPort. `exec_command` arguments are strictly cmd (1–1024 characters), optional workspace-relative workdir, timeout_ms (1000–120000), max_output_tokens (100–14000, four bytes per approximate token). No tty/yield/session/write_stdin arguments; unknown fields are errors. Result status describes execution delivery; a nonzero exit is returned truthfully and rendered Failed. No storage migration; prior read-only messages remain valid; older strict consumers cannot consume the expanded contract. **Production gate is closed on all platforms**; prototype support is not enabled command execution.

Execution approval is bound to command + canonical cwd + effective sandbox ID (one-shot mode). SDK prompt scope hashing includes that raw binding in addition to display fields; target redaction cannot merge distinct grants. No fs.read grant authorizes a command. Revocation clears both the dispatcher and SDK prompt cache. The existing approval TTL/cancellation rules apply. macOS candidate isolation tests are separate from mandatory lifecycle acceptance; Linux/Windows explicitly fail closed. [Evidence and blocker](../delivery/exec-command-foundation.md).

**Đề xuất v1. TOOLS1 đã triển khai một phần con chỉ đọc (`read`/`glob`/`grep`, quyết định allow/ask/deny, approval once/session/deny, audit) theo [ADR 0017](../adr/0017-read-only-tools-and-permission-engine.md); general write/edit, shell, lease, revision và artifact vẫn Not implemented; apply_patch được cho phép riêng theo ADR 0025.** Allow/Ask/Deny là quyết định policy, không là nhãn do tool/plugin tự khai. Dispatcher là enforcement point, security là decision owner; executor không nhận raw bypass path.

| Record | Fields | Invariants |
|---|---|---|
| ToolDescriptor | namespace, name, version, inputSchema, outputSchema?, effects, concurrencyClass, supportsCancel, timeoutClass | Registry generation cố định cho invocation |
| ToolInvocation | invocationId, sessionId, runId, toolRef, args, inputHash, target, expectedRevision, deadline | Schema validation trước permission; IDs không tái sử dụng payload khác |
| PermissionRequest | principal, capability, canonicalTargets, networkOrigin?, commandDigest?, inputHash, policyRevision | Targets được normalize, không chỉ raw strings |
| Decision | allow/ask/deny, reasonCode, constraints, approvalId?, expiresAt? | Deny thắng; ask không chạy tool |
| Lease | leaseId, principal, scopeHash, targetRevision, policyRevision, expiresAt, remainingUses | Không transferable; revoke áp dụng tại execution |
| ToolResult | invocationId, status, contentParts, artifactRefs, effectsReceipt, verified, error? | Output validated và bounded; model text không xác minh effects |

Capability scopes: fs.read/write theo canonical root/path; process.execute theo executable/args/env/cwd; network.connect theo origin; mcp.call theo server identity/tool/schema version; extension.service theo method. Shell string phức tạp không được allow bằng prefix mơ hồ; pipeline/redirection/substitution có thể phát sinh effects vượt parser, cần Ask hoặc sandbox ceiling.

Approval states: pending → approved/denied/expired/revoked; resolved chỉ một lần. Approval gắn exact args hash + target + policy revision + principal + descriptor version; thay bất kỳ thành phần nhạy cảm nào phải đánh giá lại. Persist trước hiển thị UI; expired/revoked không revive qua replay. Session-wide grants chỉ khi scope rõ và người dùng chủ động chọn; không lưu blanket shell allow ngầm.

Execution states: proposed → validated → awaiting_permission → runnable → started → succeeded/failed/cancelled/outcome_unknown. Persist started intent trước execution, result sau verification. Write kiểm expected file version; atomic replace khi khả thi; symlink và cwd recheck sát syscall. Check-then-use bằng string path không đủ chống race; OS handle-based controls/sandbox cần feasibility test.

Concurrency: reads trên snapshot có thể song song, conflicting writes khóa theo canonical target và session workspace lease; approval wait không giữ filesystem lock vô hạn. Timeout/cancel có partial effects: receipt ghi file revisions/process IDs/remote request IDs khi có. Không auto-retry non-idempotent tools nếu outcome unknown.

Output vượt giới hạn chuyển artifact reference sau redaction; binary không nhét vào prompt. Untrusted content được gắn nguồn; không cho output tool tự cấp permission. Error codes tối thiểu: INVALID_INPUT, DENIED, APPROVAL_EXPIRED, TARGET_CHANGED, TIMEOUT, CANCELLED, EXECUTION_FAILED, OUTCOME_UNKNOWN.

Acceptance: symlink swap, traversal, duplicate invocation, revoke giữa approve/execute, two writers, shell escape, forged MCP result, output flooding. Contract changes cần major/ADR khi đổi scope hoặc decision semantics. [Security](../subsystems/security.md) xác định enforcement chi tiết.

Task 01 automatic instructions ([ADR 0019](../adr/0019-project-context-loader.md)) use a fixed-filename, bounded raw reader behind the existing dispatcher policy/audit/redaction. It is not a new model tool. Missing candidates only require metadata probes; successful/denied/unreadable content attempts are audited. Ask-required targets are skipped unless an existing session grant permits them; automatic discovery cannot create a grant or prompt silently. State-directory deny and grant revocation still win. Workspace directory/symlink containment is checked before constructing the root-to-cwd chain.

## Contained exec/stdin (contract 1.13)

[ADR0032](../adr/0032-contained-command-sessions.md) adds an opt-in fixed-image local Docker runtime, optional exec_command yield_time_ms and owned-session write_stdin. Both use the existing registry/orchestrator process.execute lifecycle. Exact input/command, canonical cwd, lease/session and policy bind approval; expiry/revocation/resume cannot restore authority. Snapshot filesystem, PID namespace, no-new-privileges, zero-capability nonroot child and immutable lease are separate OS gates. No PTY, host writes/network or unsandboxed fallback.

## Integrated wave 1 (contract 1.19)

The current implementation supersedes historical closed-gate descriptions above
only for the capabilities described in ADRs 0040–0044. `ApprovalPolicy` is
`untrusted | on-request | never`; the default is `on-request` inside the configured
workspace sandbox. Hard denies precede project rules, user answers and grants.
All project-rule changes revoke dispatcher/prompt session grant caches. Adding
deny/ask or removing allow additionally denies and settles unresolved prompts;
old dialogs cannot revive approval after a restriction. Adding allow preserves
the legitimate “don’t ask again” prompt and unrelated pending requests.
Nonempty terminal input follows the approval policy like a command (ADR 0053):
`untrusted` asks, `on-request`/`never` let it through, because the session keeps its
launch sandbox; polling/interrupt remain transport operations. `exec_command` may
send `sandbox_permissions: "require_escalated"` with a justification: the user is
asked (`never` refuses) and an approved command runs once without the sandbox.

`agent.state` (`update_plan`) and `user.input` (`request_user_input`) touch no
workspace/process/network and are audited without an execution approval. Plan and
question schemas are bounded; invalid inputs do not update state. Questions need
an attached interactive UI and answers never grant permissions. Plan/question
view text and all tool result targets/attachment names are redacted before sinks.

`code.intel` requests authorize source reads before contacting a sandboxed helper.
`lsp_rename` is `fs.write`, resolves a validated WorkspaceEdit to the normal patch
plan and presents the combined diff for existing write policy. Returned source
snippets obey current project Read rules and builtin secret/protected-path policy.
No protocol message may execute a server-supplied command or applyEdit request.

`network.search` sends a query only to the fixed configured provider and is audited
without an unsolicited execution prompt unless project rules ask/deny.
`network.fetch` requires network policy per origin. Redirects re-enter the same
policy/audit callback; denied/absent callbacks make no connection. All DNS answers
must be public, and the selected address is pinned to the actual socket. See
[ADR 0044](../adr/0044-mcp-and-web-tools.md) for byte/deadline/media restrictions.

The pure `readPolicy` composition port adds current project Read deny/ask decisions
at every returned file-data sink. A project allow cannot override `.git`/state hard
denies or directly bypass secret approval. Search/listing/suggestions do not quote
ask-required content; automatic instructions do not prompt or create grants.
Trusted ripgrep can scan before output filtering; the fallback worker also filters
before reading. This distinction is an implementation limit, not proof of a
per-file OS sandbox for arbitrary third-party language servers.

## Claude Code permission model (contract 1.36)

[ADR 0061](../adr/0061-claude-code-permissions-and-sandbox.md) replaces the Codex approval policy, presets and `request_permissions`.

- `PermissionMode = default | acceptEdits | plan | bypassPermissions` (`auto` removed); `permissionModeDecision(mode, kind)` is the mode table over `PermissionKind = read | secret | edit | sandboxed-command | command | escalation | network | other`. Order: deny rule > `plan` refusal of edit/command/escalation/network > ask rule > allow rule > mode. `bypassPermissions` is launch-only (`--dangerously-skip-permissions`).
- Rules: `Bash`, `Bash(prefix:*)`, `Read(path-glob)`, `Edit(path-glob)` (`Write` alias), `WebFetch(domain:host)`, `WebSearch`, `mcp__server[__tool|__*]`, `Tool(name)`; `Network(...)` and `Unsandboxed(...)` are gone.
- Settings: `PermissionSettingsPort` / `PermissionSettingsSnapshot` (merged and trust-filtered rules, `defaultMode`, `additionalDirectories`, `sandbox.{enabled, autoAllowBashIfSandboxed, excludedCommands, allowUnsandboxedCommands, allowedDomains}`, per-file info, `pendingTrust`). Repository files loosen nothing until their content hash is approved (`capability: settings.trust`, decisions `session | always`).
- `exec_command` input: `cmd, workdir, tty, shell, login, yield_time_ms, max_output_tokens, timeout_ms, dangerouslyDisableSandbox, justification` (strict; `sandbox_permissions`, `additional_permissions`, `prefix_rule` rejected). `CommandSandbox` adds `proxyUrl`, `writableRoots`, `denyRead`, `denyWrite`; `network: true` now only marks an unsandboxed command.
- Sandbox health gates only sandboxed launches, after the effective launch policy is resolved. Approved `dangerouslyDisableSandbox`, excluded commands and trusted `sandbox.enabled: false` can run even when the native backend is missing or its self-test fails. Sandboxed launches still fail closed with `SANDBOX_UNAVAILABLE`; no automatic host fallback. Stdin retains the terminal's existing launch-sandbox rules. A failed network-proxy bind is retried on the next startup call.
- Network gate: `CosmewClient.authorizeNetwork(host, port)` decides each proxy connection (`network.connect` prompt with `alwaysRule: domain:<host>`); audit tool `sandbox_network`.
- `status()`: `permissionMode`, `sandbox {enabled, autoAllowBashIfSandboxed, allowUnsandboxedCommands, allowedDomains, excludedCommands, additionalDirectories}`, `bypassAvailable`, `terminalRuntime {sandbox: enabled|disabled|unavailable, unsandboxedAllowed}`; `approvalPolicy`, `sandboxMode`, `permissionPreset`, `sandboxNetwork` removed.

## Working directories (ADR 0067, no contract bump)

Trusted `permissions.additionalDirectories` (the user settings file, or a repository settings file after its SHA-256 content is trusted) are working directories together with the session project. Read, Edit, Write, `apply_patch`, Grep, Glob and LSP resolve a path that exists only in such a directory. A path in neither is normalized and asks for per-operation permission in default/acceptEdits; an explicit allow rule or bypass can permit it (ADR 0092). File-tool approval is independent of the OS sandbox. An external Bash cwd follows normal Bash approval and never enlarges sandbox write roots. `.git`, Cosmew and legacy state, deny rules and secret-file asks still apply inside a granted directory. An untrusted repository file that sets `sandbox.enabled: false` or lists `additionalDirectories` grants neither. `sandbox.enabled` defaults to off (ADR 0081); autoAllowBashIfSandboxed defaults to false and allowUnsandboxedCommands to true. With it trusted off, commands run unsandboxed, including a workdir inside a granted directory, and `default` / `acceptEdits` still ask. `plan` still refuses edits and execution. Nested instructions and project context stay on the session project. See [ADR 0067](../adr/0067-working-directories.md).

## User MCP (ADR 0068, no contract bump)

`fyn mcp` reads only the user file `<state>/mcp.json` (`mcpServers` stdio or HTTP). Project `.cosmew/mcp.json` and `.mcp.json` are not started. Each remote tool is `mcp__server__tool` and goes through ToolDispatcher (`mcp.call`): `default` and `acceptEdits` ask, `plan` and a read-only agent deny without a prompt, an exact tool name may be saved as Always. Results are untrusted, bounded and redacted. Stdio servers from that user file run unsandboxed. OAuth, project launch, `tool_search` and `mcp_resource` are not in this slice. See [ADR 0068](../adr/0068-user-mcp-connect.md).

## Captured tool evidence (contract 1.37)

[ADR 0063](../adr/0063-retrievable-tool-evidence-and-context-continuation.md). `ToolOutputArchive` is an injected persistence port; `OutputArchiveScope` binds the canonical workspace and conversation ID. `ArchivedToolOutput` contains a source descriptor, redacted capture, permission-context digest and truncation flag. The SQLite auxiliary cache does not change conversation schema version 8.

When configured, `tool_output({output_id, offset?, limit?, query?})` pages or searches historical captured output. `query` is literal; offset counts Unicode code points in the currently redacted view; `limit` bounds page text in UTF-8 bytes (1–10000). The metadata reports coverage, `next_offset`, source truncation and search outcome. Too small a byte limit to fit the next code point returns `OUTPUT_PAGE_TOO_SMALL`. Missing/expired/evicted/cross-session handles return `OUTPUT_UNAVAILABLE`. Cache bounds: 1 MiB per artifact, 8 MiB per session, 1024 global entries and seven-day retention.

Retrieval is a dispatcher operation with audit, explicit `Tool(tool_output)` policy and current source Read checks. Effective policy/session/workspace changes or grant revocation invalidate access. No source command or web request runs again. Handles do not restore grants after host restart; reread the source under current permissions when needed. Archive contents are untrusted evidence, never new instructions. Persistence stores redacted producer output before the generic result clip; it cannot recover bytes already omitted by a producer/process runtime. Optional cache write failure leaves the original result usable and reports archive unavailability rather than replaying the operation.
