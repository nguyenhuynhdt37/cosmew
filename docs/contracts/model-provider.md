# Model provider port

**Original full-agent v1 proposal; partially implemented by PA1 as specified below.** `models` sở hữu chuyển đổi provider; core chỉ biết normalized request/stream/result. Không để AI SDK điều khiển loop/tool execution thay core. AI SDK cung cấp primitives; tool descriptors không có privileged execute callbacks truyền cho model layer.

| Request field | Quy tắc |
|---|---|
| requestId, runId, stepId, attemptId | Attempt mới khi retry; trace ID không chứa prompt |
| providerRef, modelId, configHash | Model được pin; không tự đổi endpoint |
| messages | role + typed content parts; tool results liên kết callId |
| systemInstructions | Trusted/untrusted segments và provenance phân biệt |
| toolDescriptors | Namespaced name, schemaVersion, inputSchema; không code |
| limits | maxInputTokens, maxOutputTokens, deadline, cost ceiling |
| generation | sampling hỗ trợ thực tế; unsupported field gây diagnostic |
| abortSignal | Port nội bộ; wire dùng cancellation ID |
| credentialRef | Resolve trong adapter; không serialize credential vào events |

| Capability field | Giá trị và invariant |
|---|---|
| text / image / audio | supported / unsupported / unknown |
| toolCalling / parallelTools | Chỉ dùng khi verified; unknown không suy ra từ tên model |
| structuredOutput / reasoning | Semantics riêng provider; không ép equivalence |
| contextLimit / outputLimit | Metadata có source/revision; thiếu thì ceiling bảo thủ |
| usage / cancellation | Mức hỗ trợ; cancel remote không bảo đảm rollback |

Stream events: started; textDelta; reasoningDelta (ẩn theo policy); toolCallStart(callId,name); toolCallDelta(callId,fragment); toolCallComplete(callId,args); usageUpdate; completed(finishReason); failed(error). Deltas không được mutate canonical call đã complete; callId không trùng trong response. Tool JSON phải parse/schema validate sau completion, giới hạn size/depth, reject incomplete/truncated arguments. Out-of-order fragments chỉ buffer trong limit; unknown call ID là protocol error.

Usage: input/output/cacheRead/cacheWrite/reasoning tokens có thể null khi provider không báo; estimated flag bắt buộc nếu ước tính. Không cộng reasoning hai lần khi đã bao gồm output; giữ raw usage reference đã redacted và normalized accounting policy. Price snapshot/currency được version; cost unknown không ghi 0.

Finish reasons: stop, tool_calls, length, content_filter, error, cancelled, unknown. Length không đồng nghĩa tool call đầy đủ. Router ưu tiên 9Router sau xác minh endpoint; fallback provider chỉ theo configured policy, không gửi lại dữ liệu sang tenant/provider khác tự động. OpenAI-compatible không chứng minh Responses, tools hoặc usage đều tương thích.

Retry: 429/temporary transport trước effects có backoff + Retry-After ceiling; auth/invalid input không retry. Khi đã stream partial text, retry tạo attempt mới và replace/mark previous partial, không nối thành message sai. Timeout gồm connect/first-byte/idle/total; các giá trị pin trong resolved config và test theo fake clock ở phase triển khai.

Version migration cần ADR khi đổi role/part semantics. Acceptance fixtures: interleaved calls, malformed JSON, SSE disconnect, no usage, provider refusing tools, cancellation và secret redaction. 9Router model list/auth/limits là Needs verification trước Phase 1.


## Implemented PA1 model/conversation contract 1.0

[ADR 0005](../adr/0005-provider-auth-product.md) scopes the first executable API. The original table above is not a claim that the full agent loop/event protocol exists. `packages/contracts/src/index.ts` is the only public entry. Contracts export no SDK or Bun types; Zod validates strict records. All new consumers migrate together from the zero-byte baseline; no deployed v0 data/API exists. Optional `streamUsage` and `authGeneration` fields preserve schema-1 compatibility; absent auth generation means generation 1. Newer storage/config versions fail closed. Future incompatible semantics require ADR and migration.

| API | Actual fields/semantics |
|---|---|
| Provider | id/name, protocol(chat/responses/anthropic/gemini), baseURL, auth(api-key/none), catalog(openai/anthropic/gemini/ollama/manual), metadataVersion=1, timeoutMs, optional streamUsage |
| Account | UUID id, providerId, unique alias, CredentialRef(keyring UUID/env NAME/none), status, validatedAt, optional defaultModel/authGeneration |
| ModelInfo | Opaque model ID including provider namespaces/aliases (`~` supported), name, five tri-state capabilities, nullable limits/pricing and source/fetch/metadata provenance |
| SettingsStore | read and transactional update; schema 1 checks duplicate IDs/aliases/credential refs and provider/account/selection relationships |
| CredentialVault | get/set/delete reference; secret bytes are runtime-only return values, never serialized account/model/event fields |
| ModelRequest | UUID requestId, pinned modelId, bounded user/assistant text messages, maxOutputTokens, optional maxEstimatedCostUSD and descriptor-only tools; no credential/SDK fields |
| ModelPort | stream(request, AbortSignal?) and generate(request, AbortSignal?); bound provider/account resolved by injected adapter |
| ModelEvent | started(requestId), textDelta(text), toolCallComplete(call), completed(finishReason, usage); exceptions are HannesError safe diagnostics |
| Tool descriptors/results | Draft-07 JSON Schema validated explicitly with Ajv; invalid/unknown names, async/external unresolved schemas, duplicates, incomplete arguments and oversized content fail. No execute callback or dispatcher exists. |
| Usage | inputTokens/outputTokens/costUSD are number or null; costEstimated=true labels cost computed from advisory prices and reported usage |
| NetworkPolicy | authorize(provider, account); root rereads durable auth generation/status and endpoint snapshot per operation/wire chunk |
| ConversationStore | create(selection), append pending/committed, complete with revision fencing, interrupt. Full event log/recovery protocol is not implemented. |

Adapters normalize SDK `tool-calls`/`content-filter` into underscore finish reasons. Missing/error/other/interrupted terminal results are rejected, not committed as complete. Total provider deadline propagates into fetch and stream consumption; caller cancellation aborts it. Safe GET discovery has at most 3 attempts and Retry-After/jitter ceilings; generation has no automatic retry because remote acceptance/cost is uncertain. Text output is capped at 256 KiB; request serialization at 1 MiB; HTTP wire response at 4 MiB; complete tool arguments at 64 KiB and 32 calls. Core history is capped at 200 messages and bounded serialized bytes.

Optional maxEstimatedCostUSD is an explicit estimate guard: missing prices or an input-byte/output-token cost estimate above the limit deny before network. The estimate includes message/tool JSON bytes plus framing allowance; it is not an exact tokenizer or billing ceiling. No implicit cross-provider fallback, reasoning transcript exposure, tool execution, multimodal inputs, provider-specific sampling options, hard dollar budgets, exact provider token counting or delegated-agent execution is advertised by this contract. Metadata capabilities remain unknown when not independently verified. See [runtime/CLI](../subsystems/providers-and-auth.md) and [acceptance](../delivery/provider-auth-acceptance.md).


## Provider Connect contract 1.1

[ADR 0007](../adr/0007-provider-connect-and-commands.md) adds Integration, AuthMethod and ProviderAuthChallenge metadata, optional SDK auth-challenge ports and optional connect input fields. All current consumers migrate together. Storage remains schema 1: OpenRouter's official PKCE yields an existing keyring API-key reference; verifiers/codes are never durable. TUI consumes registry metadata, not a hardcoded provider list. No plugin host/vault access or MCP auth is exposed. Model changes start a fresh pinned conversation; permission scopes hash full targets and session grants are cleared at conversation boundaries. Existing schema-1 data loads without rewriting.


Contract 1.2 ([ADR 0008](../adr/0008-subscription-runtime-auth.md)) adds optional runtime/family provider metadata, runtime credential references, automatic/polling auth and method target/advanced metadata. Existing schema-1 rows remain unchanged. New runtime refs must match their provider runtime and cannot resolve through API-key credential access. All current consumers migrate together; older readers reject unfamiliar runtime data.

## Contract 1.3: telemetry, reasoning and account continuation

[ADR 0009](../adr/0009-command-telemetry-and-account-continuation.md) versions the additive request effort/model-effort metadata, optional reasoning preferences, reasoning-summary/usage/context stream events and validated turn receipts. All CLI/core/SDK/TUI/model/security/persistence consumers migrate together. Consumers must distinguish progress/reasoning events from answer text, and usage observations from terminal completion. `costEstimated`, pricing source/time, optional cache/reasoning subsets, premium-request units and account quota snapshots retain their meanings through persistence and UI. Unknown values are nullable, not zero.

SQLite schema 2 adds turn receipts alongside existing schema-1 messages. `ConversationStore.append`, `complete`, `interrupt` accept optional receipts; `observeTurn` durably records intermediate usage/context without committing the answer. Complete/interrupt share transactions with their final receipts. Existing sessions have missing historical coverage, never synthetic zero receipts. `/switch` forks committed history into a new selection-bound session after explicit UI confirmation, without copying usage or permissions. Source sessions remain unchanged.

Effort requires provider-advertised model values. Native Codex/Copilot and supported Responses requests carry the selected value; unsupported models expose no effective control. Context includes a labelled local heuristic and separately dated runtime measurements; no exact tokenizer, complete hidden runtime context or billing reconciliation is claimed.
