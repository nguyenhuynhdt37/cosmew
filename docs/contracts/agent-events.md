# Agent events và commands

Current shared contract: **1.24**. [ADR 0052](../adr/0052-headless-exec-and-sdk-interactions.md)
adds headless exec JSONL and typed SDK interaction subscriptions. [ADR 0050](../adr/0050-chatgpt-invalid-grant-recovery.md) adds
the optional non-secret `Settings.chatgptHostID`.
[ADR 0051](../adr/0051-uat-diagnostics-usage-and-execution-evidence.md) versions additive headless UAT
report metadata/evidence and corrects usage aggregation; it adds no agent event or command.

> PA1 provider/auth implementation is documented in [providers/auth](../subsystems/providers-and-auth.md), [ADR 0005](../adr/0005-provider-auth-product.md) and the [acceptance report](../delivery/provider-auth-acceptance.md). The full subsystem/agent protocol below remains a future design except for that explicit slice.

**Thiết kế contract v1; Not implemented.** Public wire format dự kiến JSON-compatible; IDs là opaque strings, thời gian UTC RFC3339, số sequence là integer không âm an toàn hoặc decimal string nếu vượt giới hạn. Không truyền Error/function/SDK instances. Bảng này là schema mô tả, chưa có TypeScript declarations.

| Envelope field | Bắt buộc | Invariant |
|---|---|---|
| contractVersion | Có | Major/minor; reader từ chối major lạ |
| eventId, type | Có | ID duy nhất; type phân biệt payload |
| sessionId, sessionSeq | Durable | Seq tăng đơn điệu theo session, unique pair |
| runId, stepId, attemptId | Theo phạm vi | Attempt thuộc đúng step/run |
| correlationId, causationId | Có / khi có parent | Truy vết, không dùng thay authorization |
| emittedAt | Có | Không dùng sắp thứ tự |
| payload | Có | Validate theo type/version; giới hạn bytes |
| streamId, streamSeq | Delta | Tăng trong một attempt; không có sessionSeq giả |

| Type | Payload chính | Trạng thái / nghĩa |
|---|---|---|
| session.created / message.accepted | workspaceId, messageId, role, contentRefs, revision | Message durable trước model request |
| run.started | mode, configHash, budget, parentRunId? | idle → preparing |
| step.started / model.requested | contextHash, modelRef, attemptId | preparing → streaming |
| model.delta | kind(text/reasoning/tool-fragment), callId?, fragment | Ephemeral; reasoning có policy riêng |
| model.completed | finishReason, normalizedCalls, usage, responseRef | Chỉ complete call mới dispatch |
| tool.requested | invocationId, descriptorVersion, inputHash, target | validated request |
| approval.requested / resolved | approvalId, scopeHash, expiry, policyRevision / decision, principal | waiting_approval → runnable/denied |
| tool.started | invocationId, leaseId, targetRevision | Intent durable trước side effect |
| tool.completed / failed | invocationId, resultRef / error, outcomeCertainty | Một logical outcome; unknown cần reconcile |
| context.compacted | sourceRange, summaryRef, tokenEstimate, provenance | Không xóa bản gốc |
| run.cancel_requested | reason, requestedBy | nonterminal → cancelling |
| run.completed / failed / cancelled | finalMessageRef?, stopReason, usage, unresolvedInvocations | Terminal một lần |
| capability.changed / extension.failed | registryGeneration, capabilityId / error | Không đổi descriptor đang chạy |

Commands: SubmitMessage(commandId, sessionId, expectedRevision, content), CancelRun(commandId, runId), ResolveApproval(commandId, approvalId, scopeHash, decision), ResumeSession(commandId, checkpointId, expectedRevision). Server deduplicate commandId theo principal/session, trả cùng acknowledgement; payload khác cho cùng key là conflict. Unauthorized command không tạo domain action.

Error record: code, category(validation/auth/policy/provider/tool/storage/transport/cancel), safeMessage, retryable, outcomeCertainty(none/completed/unknown), diagnosticRef. Không nhét stack/secret/raw headers vào public event. Missing seq làm client resync; unknown minor event được bỏ qua chỉ nếu optional, unknown command bị reject.

Versioning: thêm optional field/minor event phải có default và negotiation; đổi semantics/required field cần major, ADR và migration. Store append cùng state revision trong transaction; publisher sau commit. At-least-once delivery, consumer dedup eventId; không hứa exactly-once side effects. Replay durable events không gọi lại executor.

Acceptance: duplicate Submit không tạo run thứ hai; concurrent terminal CAS thắng một; dropped deltas không phá durable replay; invalid schema bị chặn trước state mutation; restart không emit lại side effects. Xem [event flow](../architecture/event-flow.md).

## Headless exec / SDK interactions (contract 1.24)

[ADR 0052](../adr/0052-headless-exec-and-sdk-interactions.md) defines the implemented S1 slice.
`client.onInteractionEvent(listener)` subscribes before `sendMessage` and returns an unsubscribe
function. `InteractionEvent` is `{type: 'permission.requested' | 'question.asked', request}`
(a discriminated union with `PermissionPromptRequest` or `PendingQuestion`). Each observer receives
an isolated sanitized clone. A callback may resolve the request immediately using its id/scope;
permission notifications run after the waiter is installed. Aborted/settled permissions are not
announced as pending. Observer exceptions grant nothing. Existing `onReactiveEvent` consumers
remain compatible and need no migration. `status().approvalPolicy` reports the current policy.
UAT now subscribes to these events instead of polling the pending lists; pending-list APIs remain.

`fyn exec --json` emits one serialized `HeadlessEvent` per line: existing `ModelEvent` fields at
the top level, typed interaction events, then exactly one terminal `turn.completed` or
`turn.failed` (`error: {code, message}`). Each line includes `contractVersion: "1.24"`, `seq`
starting at 1. Provider `completed` can occur within a multi-request turn; only `turn.completed`
means the entire run succeeded. `responseDiscarded` invalidates the current provisional response;
plain output / `-o` keep only the final response. This stream is not the future durable domain
envelope table above, and it is not a Codex wire-format compatibility claim.

Argument/startup diagnostics go to stderr. Exit codes: 0 completed; 1 failed/cancelled turn or
output write; 2 missing explicit `--cd` consent or usable tool account/model; 64 invalid arguments
or empty/oversized stdin. Without TTY the default approval policy is `never`; even explicitly
selected interactive policies deny prompts immediately when no input UI is attached. Exec sets
`setUserInputAvailable(false)`; SDK questions then return unavailable without waiting. Tools still
use ToolDispatcher. No new execution authority, persistence schema, dependency or external agent.

## Implemented execution evidence (contract 1.12)

The [ADR 0030](../adr/0030-durable-conversation-recovery.md) SQLite journal persists user.accepted, model.requested, assistant.text, tool.call, tool.intent, tool.result and turn.finished with stable turn IDs and per-conversation sequences. This is a private recovery projection of public domain events, not an implementation of every proposed envelope above. Provider reasoning is transient. Lifecycle states are pending/running → completed/failed/cancelled/interrupted; terminal events cannot reopen execution. Unknown tool outcomes are explicit protocol outputs, never successful audit receipts. STALLED is a public error/stop reason for bounded no-progress termination.

## Execution streaming (contract 1.13)

ADR0032 adds core-owned toolOutputDelta(callId, name, stream, text) for bounded redacted command progress. Provider streams cannot fabricate this domain event. ToolPort may receive an optional progress callback; final results and intents remain durable and exactly paired. Deltas are transient, not proof of successful completion. Closing the iterator cancels owned execution and journals the observed bounded result.

## Codex-parity loop and steering (contract 1.14)

[ADR 0033](../adr/0033-codex-parity-agent-loop.md) adds, all optional for older consumers:

- `ToolDescriptor.parallel?: boolean` — Codex `supports_parallel_tool_calls`. Only declared tools share execution; absent means exclusive. It is ordering metadata, never permission.
- Journal event `user.steered(steerId, message)` — user input accepted into the active turn, durable before acceptance is reported. Recovery shows it before the next non-first `model.requested` of that turn, or after everything else when the turn ended first. Legacy rows without it remain valid.
- Model event `steered(steerId, content)` — the steering message became model-visible before the next request.
- `SteerOutcome` (`accepted` + `turnId`/`steerId`, or `no_active_turn` / `turn_mismatch` / `not_steerable` / `empty_input`), returned by `Conversation.steer`, the optional `FutrynBackendPorts.steerTurn` and `FutrynClient.steerMessage`.

`toolCallComplete` is now dispatched as soon as it arrives; results are still emitted and recorded in model-output order after the response. Adapters must emit it only for calls whose arguments are complete.

## Codex-parity completion (contract 1.15)

[ADR 0033](../adr/0033-codex-parity-agent-loop.md), additive:

- `model.requested.protocol: 2` + journal event `model.completed(stepId)`: streamed text of a protocol-2 request is provisional until its response completed. Reconstruction drops a superseded (retried/preempted) response's text and labels text of a turn that ended mid-response `[incomplete response …]`. A response cut by the output-token limit (`finishReason: 'length'`) is never committed: the engine does not record `model.completed` for it, so its text is reconstructed as `[incomplete response …]`, not as a final answer. Legacy requests stay committed.
- `user.accepted.carried[]`: undelivered steering of earlier turns that this turn consumed, placed before its user message. Undelivered steering of finished turns is `RecoveredConversation.pendingInput`, never history. A stale or duplicate carry is refused.
- Model events `completed.endTurn` (only `false` from a provider signal such as Anthropic `pause_turn`), `responseDiscarded(reason: retry|preempted, attempt?)`, `inputDeferred(steerIds, reason)`.
- SDK: `submitWhileBusy` (steer or queue for the next turn), `takeQueuedMessage`, `queuedMessages`, `queuedInput`; port `queuedInput`.

## Generation limits (contract 1.17)
See [ADR 0036](../adr/0036-codex-generation-limits.md): Codex values only (`GENERATION_LIMITS`, `codexBackoffMs`), optional `Provider.streamIdleTimeoutMs`, optional `ModelRequest.maxOutputTokens` (none sent by default), no size ceilings on messages/tool calls/diffs, `responseDiscarded.maxRetries` on every retry. Widening only; 1.16 data still parses.

## Unified exec terminal (contract 1.16)

ADR 0034 adds no new agent event. Command ports gain optional `CommandSandbox` (`read-only`/`workspace-write`, approved `network`), `tty`/`shell`/`login` on requests, `sandboxDenied` outcomes (tool result code `SANDBOX_DENIED`, output kept, never retried), runtime `capabilities()`/`resize()`, and session launch facts used by stdin review. Each command or stdin result carries only output produced since the previous call on that session. `toolOutputDelta` semantics are unchanged; a PTY session streams merged output as `stdout`.

## Chat/config integration (contract 1.18)

[ADR 0037](../adr/0037-chat-configuration-command-parity.md): optional user work-budget preferences and per-session Chat/Plan/Review mode metadata use validated atomic settings storage. Modes are workflow restrictions, not grants. Session navigation revokes delegation, permission modes and grants; persisted modes never restore execution authority. SDK registry metadata drives canonical slash dispatch, aliases, overlay discovery and command shortcuts. `/fork` uses the existing durable history-copy port without replay.

Workspace diff metadata adds optional staged/unstaged/untracked layer, original path, binary/truncation and readiness diagnostics. Async refresh updates a single cached report; render must never execute Git. Report totals cover returned lines/files, and bounded results are labeled. Optional terminal-runtime status reports the actual selected sandbox and limitations. A failed probe is unavailable, never successful execution.

Turn receipts may declare `kind: user-shell`; these retain execution evidence without counting a user shell operation as provider usage. Missing kind means an agent receipt for backward compatibility.

## Wave 1 integration (contract 1.19)

[ADR 0040](../adr/0040-codex-approval-policy.md),
[0041](../adr/0041-full-read.md), [0042](../adr/0042-plan-and-questions.md),
[0043](../adr/0043-sandboxed-code-intelligence.md),
[0044](../adr/0044-mcp-and-web-tools.md) define the additive wave-1 contract.

- Capabilities add `agent.state`, `user.input`, `code.intel`, `network.search`,
  `network.fetch`; Plan/Review permit these read/session-state capabilities but
  still withhold writes and process execution. Permission policy remains a gate,
  not authority supplied by a tool descriptor.
- `ToolResult.attachments` and tool `Message.attachments` carry bounded media
  (`mime`, base64 `data`, redacted `name`) beside the existing string content.
  Transcript/journal text excludes base64; the persistence side table reattaches
  media by call id on recovery. Older rows without attachments remain valid.
- The SDK adds `plan()`, `listPendingQuestions()`, `answerQuestion()`,
  `dismissQuestion()`, UI availability control, and observer notifications
  `plan.updated`, `question.asked`, `question.answered`. These are SDK observer
  notifications, not new durable domain envelopes. They do not replace the active
  streaming/tool activity state. Plan and pending-question display text are
  redacted before exposure. Question answers are tool results, never grants.
- SQLite schema 6 adds per-session plans, discovered instruction directories and
  bounded media storage. Schema 5 databases migrate transactionally; future
  schemas fail closed. Answered questions persist as paired tool results;
  interrupted pending dialogs are not replayed as live interactions after restart.
- `CommandRuntime.spawnService?` and `ServiceProcess` form the optional sandboxed
  helper port. Existing command runtimes without it remain valid and report LSP
  unavailable. No helper execution is restored by journal replay.
- Successful write receipts may include `diagnostics: string[]`; the TUI renders
  them in error color below the edit. Standalone `diagnostics.reported` and
  `mcp.server.status` SDK notifications from the original plan are not implemented;
  web search uses fixed adapters, not a general MCP server-management surface.
- All rule edits revoke dispatcher/prompt session caches. Restrictive edits (adding
  deny/ask or removing allow) also deny/settle unresolved prompts, so a stale
  dialog cannot approve an operation after policy tightens. Adding allow preserves
  the current “don’t ask again” approval and other pending requests. New project read-rule checks cannot override builtin hard
  denies or silently approve secret reads.

The single public version bump is 1.18 → 1.19 for the integrated wave. Earlier
wave commits referred to 1.19 while under construction; this integrated constant
and consumers now agree. No wave-2 subagents/memory/skills/general MCP or wave-3
CodeMode contract is claimed here.
