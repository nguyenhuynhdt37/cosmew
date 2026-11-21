# Agent events và commands

Current shared contract: **1.40** (Cosmew rename and optional user-declared provider reasoning metadata; [ADR 0076](../adr/0076-cosmew-project-rename.md), [ADR 0078](../adr/0078-user-declared-reasoning-efforts.md)). Previous shared contract: **1.39** (P3: diff bases, editable plan approval, summarize rewind, selective retract and session/history scopes; [ADR 0074](../adr/0074-p3-review-and-session-controls.md); SQLite 10). Previous contract: **1.38** (P1: background tasks, queued input, plan approval, images, checkpoints and hook/MCP status; [delivery](../delivery/tui-v4/p1-backend.md); SQLite 9). Historical versions: **1.37** (1.37: bounded session-scoped tool-output archive and mediated retrieval; [ADR 0063](../adr/0063-retrievable-tool-evidence-and-context-continuation.md)). **1.31** (1.31: memory mutation capability and edit policy; 1.30: MemoryInfo usage/unused, display citation parser và ranked index context; [ADR 0057](../adr/0057-user-scoped-project-memories.md). 1.29: user-scoped MemoriesPort/schema, memory tool, SDK và /memory; [ADR 0057](../adr/0057-user-scoped-project-memories.md). 1.28: skills catalog/port, optional `ToolResult.skillDirectory`, instructions tổng ≤32.768 ký tự với budget metadata skill riêng 8.000; [ADR 0056](../adr/0056-skills-discovery-and-mediated-invocation.md). 1.27: `CommandSandbox.mode` `'danger-full-access'`, `PermissionResolutionScope` `'always'`, `PermissionPromptRequest` `decisions`/`alwaysRule`/`approved_always`, `Network`/`Unsandboxed` rule tools and Codex presets; [ADR 0055](../adr/0055-codex-approval-decisions-network-and-full-access.md). 1.26: `context.compacted` model event, model-written `ContextSnapshot.strategy`, `CompactionOutcome`, optional `ConversationStore.addUsage`; [ADR 0054](../adr/0054-model-compaction.md). 1.25: optional `ModelRequest.cacheKey`, `CommandSandbox.unsandboxed`; [ADR 0053](../adr/0053-codex-sandbox-and-approval-alignment.md)). [ADR 0052](../adr/0052-headless-exec-and-sdk-interactions.md)
adds headless exec JSONL and typed SDK interaction subscriptions. [ADR 0050](../adr/0050-chatgpt-invalid-grant-recovery.md) adds
the optional non-secret `Settings.chatgptHostID`.
[ADR 0051](../adr/0051-uat-diagnostics-usage-and-execution-evidence.md) versions additive headless UAT
report metadata/evidence and corrects usage aggregation; it adds no agent event or command.

> PA1 provider/auth implementation is documented in [providers/auth](../subsystems/providers-and-auth.md), [ADR 0005](../adr/0005-provider-auth-product.md) and the [acceptance report](../delivery/provider-auth-acceptance.md). The full subsystem/agent protocol below remains a future design except for that explicit slice.

**Thiết kế contract v1; Not implemented.** Public wire format dự kiến JSON-compatible; IDs là opaque strings, thời gian UTC RFC3339, số sequence là integer không âm an toàn hoặc decimal string nếu vượt giới hạn. Không truyền Error/function/SDK instances. Bảng này là schema mô tả, chưa có TypeScript declarations.

| Envelope field             | Bắt buộc           | Invariant                                       |
| -------------------------- | ------------------ | ----------------------------------------------- |
| contractVersion            | Có                 | Major/minor; reader từ chối major lạ            |
| eventId, type              | Có                 | ID duy nhất; type phân biệt payload             |
| sessionId, sessionSeq      | Durable            | Seq tăng đơn điệu theo session, unique pair     |
| runId, stepId, attemptId   | Theo phạm vi       | Attempt thuộc đúng step/run                     |
| correlationId, causationId | Có / khi có parent | Truy vết, không dùng thay authorization         |
| emittedAt                  | Có                 | Không dùng sắp thứ tự                           |
| payload                    | Có                 | Validate theo type/version; giới hạn bytes      |
| streamId, streamSeq        | Delta              | Tăng trong một attempt; không có sessionSeq giả |

| Type                                  | Payload chính                                                       | Trạng thái / nghĩa                         |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| session.created / message.accepted    | workspaceId, messageId, role, contentRefs, revision                 | Message durable trước model request        |
| run.started                           | mode, configHash, budget, parentRunId?                              | idle → preparing                           |
| step.started / model.requested        | contextHash, modelRef, attemptId                                    | preparing → streaming                      |
| model.delta                           | kind(text/reasoning/tool-fragment), callId?, fragment               | Ephemeral; reasoning có policy riêng       |
| model.completed                       | finishReason, normalizedCalls, usage, responseRef                   | Chỉ complete call mới dispatch             |
| tool.requested                        | invocationId, descriptorVersion, inputHash, target                  | validated request                          |
| approval.requested / resolved         | approvalId, scopeHash, expiry, policyRevision / decision, principal | waiting_approval → runnable/denied         |
| tool.started                          | invocationId, leaseId, targetRevision                               | Intent durable trước side effect           |
| tool.completed / failed               | invocationId, resultRef / error, outcomeCertainty                   | Một logical outcome; unknown cần reconcile |
| context.compacted                     | sourceRange, summaryRef, tokenEstimate, provenance                  | Không xóa bản gốc                          |
| run.cancel_requested                  | reason, requestedBy                                                 | nonterminal → cancelling                   |
| run.completed / failed / cancelled    | finalMessageRef?, stopReason, usage, unresolvedInvocations          | Terminal một lần                           |
| capability.changed / extension.failed | registryGeneration, capabilityId / error                            | Không đổi descriptor đang chạy             |

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
`turn.failed` (`error: {code, message}`). Each line includes `contractVersion: "1.28"`, `seq`
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

## Model compaction (contract 1.26)

[ADR 0054](../adr/0054-model-compaction.md). Additive for older consumers:

- Model event `context.compacted` `{trigger: 'auto' | 'manual', strategy: 'model' | 'excerpt', tokensBefore, tokensAfter, fallback?}`: older model-visible history was replaced by a handoff summary (`model`) or, when the model call failed, by the extractive checkpoint (`fallback: true`). Token counts are conservative estimates. It is emitted before the request that uses the compacted context and is not journaled; the durable record is the `ContextSnapshot` (`strategy: 'model'` carries `retainedUserRequests` = recent user messages up to 20,000 tokens, and `summary` = handoff text). Recovery after restart renders it; source history is never changed. `fyn exec --json` forwards it like other model events.
- Auto compaction starts at 85% of the usable window, before tool withdrawal (ADR 0063 supersedes the earlier 90% trigger); `/compact [instructions]` / `CosmewClient.compact(instructions?, {signal})` → `CompactionOutcome {compacted, strategy?, tokensBefore, tokensAfter, usage, fallback?, reason?}` runs it while idle and throws `POLICY` during a turn. Usage of the summary call is counted in the turn (auto) or added to the latest agent turn receipt (`ConversationStore.addUsage`, manual).

## Implemented execution evidence (contract 1.12)

The [ADR 0030](../adr/0030-durable-conversation-recovery.md) SQLite journal persists user.accepted, model.requested, assistant.text, tool.call, tool.intent, tool.result and turn.finished with stable turn IDs and per-conversation sequences. This is a private recovery projection of public domain events, not an implementation of every proposed envelope above. Provider reasoning is transient. Lifecycle states are pending/running → completed/failed/cancelled/interrupted; terminal events cannot reopen execution. Unknown tool outcomes are explicit protocol outputs, never successful audit receipts. STALLED is a public error/stop reason for bounded no-progress termination.

## Execution streaming (contract 1.13)

ADR0032 adds core-owned toolOutputDelta(callId, name, stream, text) for bounded redacted command progress. Provider streams cannot fabricate this domain event. ToolPort may receive an optional progress callback; final results and intents remain durable and exactly paired. Deltas are transient, not proof of successful completion. Closing the iterator cancels owned execution and journals the observed bounded result.

## Codex-parity loop and steering (contract 1.14)

[ADR 0033](../adr/0033-codex-parity-agent-loop.md) adds, all optional for older consumers:

- `ToolDescriptor.parallel?: boolean` — Codex `supports_parallel_tool_calls`. Only declared tools share execution; absent means exclusive. It is ordering metadata, never permission.
- Journal event `user.steered(steerId, message)` — user input accepted into the active turn, durable before acceptance is reported. Recovery shows it before the next non-first `model.requested` of that turn, or after everything else when the turn ended first. Legacy rows without it remain valid.
- Model event `steered(steerId, content)` — the steering message became model-visible before the next request.
- `SteerOutcome` (`accepted` + `turnId`/`steerId`, or `no_active_turn` / `turn_mismatch` / `not_steerable` / `empty_input`), returned by `Conversation.steer`, the optional `CosmewBackendPorts.steerTurn` and `CosmewClient.steerMessage`.

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

## Skills (contract 1.28)

[ADR 0056](../adr/0056-skills-discovery-and-mediated-invocation.md). `client.skills()` →
`SkillsReport {skills: SkillMetadata[], errors: SkillDiagnostic[], warnings: SkillDiagnostic[]}`.
Metadata gồm `name`, `description`, `source: project|user|system`, `path`, `directory`, `shortPath`,
`disableModelInvocation`, optional `argumentHint`; không chứa body hay grant. Diagnostic có `code`,
optional `path`. SDK clone report; trước folder consent hoặc backend chưa hỗ trợ trả arrays rỗng.

`skill {name}` qua dispatcher, không nhận path tùy ý; `ToolResult.content` là SKILL.md đã redact,
optional `skillDirectory` là thư mục tài nguyên (informational, không phải quyền đọc/ghi).
Core gắn directory vào tool message; wrappers dùng schema mới để nhận field optional này.
Output skill tối đa 65.536 byte sau redact, các tool khác giữ bound cũ; truncation báo qua `truncated`.
Metadata model 8.000 ký tự, ẩn disabled entries, cảnh báo khi rút/bỏ; tổng `instructions` tăng tới
32.768 ký tự cho host guidance. Toàn bộ catalog là untrusted project data trong user/project-context message, không đưa vào
`ModelRequest.instructions` (chỉ host guidance). Body từ explicit slash/mention là user-scoped context
của lượt gọi; không trở thành system authority. `$name` bỏ qua common environment variables
(case-insensitive) và fenced/inline code; `/name` giữ nguyên.
`SkillsPort` được inject vào core (`instructions`, `loadPrompt`), không thêm package dependency hay
persistence schema. Canonical `/skills` và `/name args` trong TUI; `$name` cũng hoạt động ở `fyn exec`.
`allowed-tools` không có semantics cấp quyền. Consumer JSONL dùng version 1.28; không thêm agent event.

## Memories (contract 1.29)

[ADR 0057](../adr/0057-user-scoped-project-memories.md). `MemoryMetadata {name, description, type}` với
`type: user|feedback|project|reference`; `MemoryWrite` thêm `content`. `MemoriesPort` cung cấp
`directory`, `list/read/write/delete/context`; persistence sở hữu durable file writes.
`memory {action: list|read|write|delete, name?, description?, type?, content?}` dùng `agent.state` cho list/read, `agent.state.write` cho write/delete (contract 1.31),
không approval filesystem, vẫn qua dispatcher/audit/redact. Read/delete cần slug; write cần đủ field.
File ≤16 KiB gồm frontmatter, directory ≤1 MiB/256 entries; secret-like input bị từ chối.
SDK contract 1.36 adds the permission model of [ADR 0061](../adr/0061-claude-code-permissions-and-sandbox.md) (see tools-and-permissions.md); SDK contract 1.35 ([ADR 0060](../adr/0060-ink-tui-integration-and-memory-write.md)) thêm
`client.writeMemory(entry: MemoryWrite): Promise<ToolResult>`: consent + idle chat, schema validation,
port `memoryAction(write, name, entry)` gọi memory tool qua dispatcher/audit/redact; plan/review,
read-only và deny rule vẫn chặn ghi. Consumers read/delete giữ nguyên.
SDK `client.memories()` trả metadata clone; `client.readMemory(name)`/`deleteMemory(name)` trả
`Promise<ToolResult>` qua dispatcher. Backend không hỗ trợ trả list rỗng/UNSUPPORTED cho actions.
`memoryDirectory()` và `openMemoryDirectory()` là đường UI/host cho folder cố định, không model tool.
`/memory` mở Modal; args `list`, `read <name>`, `delete <name>`, `open`.

`~/.cosmew/projects/<sha256(canonical workspace)>/memory/MEMORY.md` được nạp tối đa 200 dòng/25.000 byte
vào user/project-context có nhãn untrusted và nhắc kiểm chứng, không vào `ModelRequest.instructions`.
Không có ký ức thì không thêm context; `fyn exec` dùng cùng cơ chế S3. `COSMEW_MEMORY=0` hoặc
`[memories] enabled = false` ở host config user tắt loading/tool; không đọc config repo.
Port context optional của core phải được bỏ khi S5 tạo subagent. Không thêm event hay migration SQLite;
headless envelopes/consumers dùng 1.29.

### Memories bổ sung (contract 1.30)

`MemoriesPort.list()` / `client.memories()` → `MemoryInfo[]`, metadata cũ cộng
`usage_count: number`, `last_usage: string|null` (UTC ISO), `updated_at: string`, `unused: boolean`.
Write input giữ nguyên, không nhận counters. Successful read tăng sidecar `.usage.json` trước khi trả output.
Mục lục overflow ưu tiên fresh, count rồi recency; không đổi disk index. User `[memories] max_unused_days`
mặc định 30, clamp 0..365; SDK/UI chỉ gợi ý xoá, không tự prune.

SDK `parseMemoryCitations(text, streaming?)` → `{content, files}` cho presentation. Model thêm block
`<oai-mem-citation><citation_entries>name.md:1-3|note=[reason]</citation_entries></oai-mem-citation>`
cuối câu trả lời ngoài code fence; standalone `name.md` entries cũng đọc được. Parser loại index/path/range sai,
dedupe, giữ code examples, ẩn block dở; TUI render một dòng “Ký ức đã dùng: …” cho assistant text cả stream/replay.
Journal, SDK model events và headless JSONL giữ text gốc; không có event/schema Message mới hay SQLite migration.
Citations là model-declared provenance, không phải proof hay grant. Không đưa memory body/metadata vào instructions.
Auto extraction vẫn deferred/off; `auto_extract=true` chỉ báo unsupported, không chạy ngầm.

### Memory mutation policy (contract 1.31)

`agent.state.write` is a distinct tool/prompt capability for durable memory edits.
Read Only sandbox and Plan/Review (`analysisOnly`) refuse write/delete before storage,
including after an awaited approval. List/read stay available as `agent.state`.
Memory edits use permission kind `edit` and `Tool(memory …)` project rules:
`untrusted` asks; normal Auto/on-request and never approve without a prompt unless
a project rule restricts them. No new events or SQLite migration.

### Subagents (contract 1.32, ADR 0058)

Tool `agent` (`agent.spawn`, parallel) và ba sự kiện: `subagent.started {callId, agentId, agentType, description, modelId, reasoningEffort?, forkContext?, background?}`,
`subagent.progress {…, currentTool?, toolCount, usage, steps?}` (gộp theo `callId`, có thể bị bỏ khi hàng đợi đầy) và
`subagent.finished {…, status: completed|failed|cancelled, toolCount, usage, durationMs, summary?, errorCode?, steps?}`.
Thứ tự: started → progress* → finished, trước tool result của cha. Chỉ Cosmew phát; provider stream phát `subagent.*` là lỗi `PROTOCOL`.
`steps` đã redact và bounded. `fyn exec --json` phát cùng envelope (`contractVersion` 1.32). SDK: `client.subagents(sessionId?)`,
`client.inspectSubagent(agentId)`, `ReactiveAgentEventKind` thêm ba kind. Prompt quyền có `subagent {agentId, agentType, description}`.
Persistence: bảng `subagent_sessions` (SQLite vẫn 8). Con ẩn khỏi `listSessions()`.

### Subagents S5b (contract 1.33, ADR 0058)

`agentType`/`SubagentType` là string (built-in hoặc tên agent tuỳ chỉnh). `subagent.progress/finished` có `background?: true` cho con nền; sự kiện của con nền sau khi tool call `agent` đã trả về không đi qua stream của lượt mà qua `client.onSubagentNotice(notice)` (`SubagentNotice {agentId, parentSessionId, agentType, description, status: completed|failed|cancelled, delivery: steered|queued}`) và `ReactiveAgentEvent` `subagent.finished`. Kết quả tới model là input `<subagent id status type description>` (steer vào lượt đang chạy hoặc next-turn input bền), không phải event.
Tool mới (chỉ offer khi phiên đã có con; `agent.spawn`, parallel): `agent_message {id, message}`, `agent_wait {ids?, timeout_ms?}` (mặc định 30000, kẹp 10000..3600000), `agent_close {id}`. `agent` nhận `background: true` -> `{"id","status":"running"}`. SDK: `client.agentTypes()` (`AgentTypesReport {types: AgentTypeView[], errors, warnings}`), `client.stopSubagent(id)`, `client.onSubagentNotice()`. Slash `/agents`. SQLite vẫn 8.

### Subagents S5c (contract 1.34, ADR 0058)

`agent` nhận `isolation: "worktree"`: con chạy trong Git worktree riêng (xem ADR). Kết quả tool/thông báo nền thêm dòng `Worktree kept with changes: <path> (branch <branch>)` hoặc `The isolated worktree had no changes and was removed.`. Mã lỗi mới: `AGENT_BUDGET_EXHAUSTED` (cap/ngân sách lượt cha đã hết, từ `agent`/`agent_message`). `[agents] max_child_tokens|max_child_duration_ms|max_child_cost_usd` trong `~/.cosmew/config.toml`. `SubagentSessionRecord.isolation?: 'worktree'` (cột SQLite `isolation`, SQLite vẫn 8). `fyn exec` chờ con nền và chạy các lượt thông báo.

## P1 SDK (contract 1.38)

ADR 0069–0073 bổ sung snapshot/notifications cho background tasks, queue retraction,
plan approval và image attachments. `task.started|updated|finished` mang metadata task
đã redact; completion shell gửi durable `<task-notification>` qua cùng parent inbox.
`hook.ran` có `{event,name,summary}` nhưng không có hook runner trong P1;
`hooks().supported` luôn false. SDK export các type renderer cần dùng, TUI không
import core/tools/persistence. MCP status phản ánh hub và HTTP search adapter đang
được inject; management/OAuth flags false. Adapter search chưa khởi tạo được báo
`disabled` (lazy, chưa có connection evidence), không giả connected.

SQLite v9 thêm input retraction receipts và state P1; migration additive, journal
không sửa tại chỗ. Consumers nâng lên 1.38 trước khi bật các event mới. SDK host
thiếu optional port phải trả UNSUPPORTED/empty snapshot có cờ hỗ trợ, không tự tạo
đường execution thay thế. Chi tiết migration và giới hạn bằng chứng ở ADR tương ứng.

### Background tasks (contract 1.38, ADR 0070)

`BackgroundTask` là snapshot shell unified-exec hoặc projection background child:
`{id, kind: shell|agent, description, status: running|done|failed|stopped, startedAt, exitCode?, outputTail}`.
SDK `backgroundTasks(sessionId?)`, `stopBackgroundTask(id): Promise<boolean>` và
`backgroundCurrentTask(): BackgroundTask|undefined` không tạo executor. Chuyển foreground chỉ
release wait/abort linkage, giữ ID/process/sandbox/lease. Stop unknown/finished trả false.
`onBackgroundTaskEvent` phát `{type: task.started|task.updated|task.finished, task, parentSessionId?, delivery?: steered|queued}`;
reactive notifications cùng kind không thay active activity. Đây là observer notifications, không
phải provider event hay durable envelope mới. Text redact và tail bounded 8.192 ký tự; subscriber
không được cấp quyền. Completion shell `<task-notification>` vào cùng durable steering/inbox
đường với background subagent trước khi event có delivery xuất hiện. Task execution là live-only;
inbox đã lưu tồn tại qua restart. Không thêm SQLite migration.


## P3 SDK (contract 1.39, ADR 0074)

`WorkspaceDiffReport` thêm effective `base` và `capabilities` theo nguồn; SDK nhận optional base.
`PlanProposal` thêm optional path/revision (row cũ vẫn đọc); approved/feedback outcome có edited plan khi revision > 1,
feedback đi cùng mode trong một resolution. `editPlanProposal` không grant. `RewindScope` thêm summarize,
focus instructions giới hạn/redact, outcome cho biết model/excerpt và fallback. `retractQueuedEntries` selective
trả id/type/content; no-argument `retractQueuedInput` cũ vẫn giữ. `PromptHistoryEntry` có id/sessionId/content/timestamp,
scopes session/project/everywhere; model/effort session scope không persist user preference.
Không có producer event mới; observer state update và JSONL dùng version 1.39. SQLite 10 thêm nullable canonical
workspace và timestamp metadata cùng bounded prompt_history projection của actual submissions/steering. Migration từ 9 giữ unknown là NULL; copied context/handoff không tạo prompt mới; binary cũ từ chối schema mới.
