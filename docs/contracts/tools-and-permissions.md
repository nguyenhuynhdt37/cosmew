# Tools và permission contracts

Task 03B contract **1.9** ([ADR 0023](../adr/0023-process-supervision.md)) adds optional CommandOutcome.lifecycle observations and optional CommandRuntime.shutdown(). Absent lifecycle fields mean unconfirmed. Existing injected runtimes remain source-compatible. No request, ToolResult or database schema migration; stored model-facing text preserves lifecycle observations. Exit code 0 certifies only the leader exit status.

Task 03A contract **1.8** ([ADR 0022](../adr/0022-sandboxed-exec-command-foundation.md)): additive process.execute tool capability, optional exitCode/durationMs on ToolResult, and CommandRuntime/CommandRequest/CommandOutcome ports. Core still sees only ToolPort. `exec_command` arguments are strictly cmd (1–1024 characters), optional workspace-relative workdir, timeout_ms (1000–120000), max_output_tokens (100–14000, four bytes per approximate token). No tty/yield/session/write_stdin arguments; unknown fields are errors. Result status describes execution delivery; a nonzero exit is returned truthfully and rendered Failed. No storage migration; prior read-only messages remain valid; older strict consumers cannot consume the expanded contract. **Production gate is closed on all platforms**; prototype support is not enabled command execution.

Execution approval is bound to command + canonical cwd + effective sandbox ID (one-shot mode). SDK prompt scope hashing includes that raw binding in addition to display fields; target redaction cannot merge distinct grants. No fs.read grant authorizes a command. Revocation clears both the dispatcher and SDK prompt cache. The existing approval TTL/cancellation rules apply. macOS candidate isolation tests are separate from mandatory lifecycle acceptance; Linux/Windows explicitly fail closed. [Evidence and blocker](../delivery/exec-command-foundation.md).

**Đề xuất v1. TOOLS1 đã triển khai một phần con chỉ đọc (`read`/`glob`/`grep`, quyết định allow/ask/deny, approval once/session/deny, audit) theo [ADR 0017](../adr/0017-read-only-tools-and-permission-engine.md); phần còn lại (write, shell, lease, revision, artifact) vẫn Not implemented.** Allow/Ask/Deny là quyết định policy, không là nhãn do tool/plugin tự khai. Dispatcher là enforcement point, security là decision owner; executor không nhận raw bypass path.

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
