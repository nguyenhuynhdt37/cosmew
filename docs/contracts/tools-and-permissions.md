# Tools và permission contracts

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
Nonempty terminal input always asks (and `never` refuses), including shells,
REPLs, editors and pagers; polling/interrupt remain transport operations.

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
