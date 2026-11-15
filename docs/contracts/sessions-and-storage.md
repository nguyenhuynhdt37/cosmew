# Sessions và storage contracts

> PA1 provider/auth implementation is documented in [providers/auth](../subsystems/providers-and-auth.md), [ADR 0005](../adr/0005-provider-auth-product.md) and the [acceptance report](../delivery/provider-auth-acceptance.md). The full subsystem/agent protocol below remains a future design except for that explicit slice.

**Historical proposal; the implemented recovery slice is specified below.** Persistence là owner mọi SQLite write; core chỉ gọi transaction ports. Không có schema SQL/migration implementation trong Phase 0.

| Entity | Fields dự kiến | Invariant |
|---|---|---|
| Session | sessionId, workspaceId, ownerId, createdAt, revision, status, configHash | Scope workspace/owner bất biến trừ migration rõ |
| Message | messageId, sessionId, role, partsRefs, parentId?, provenance, state | Không sửa message committed âm thầm |
| Run | runId, sessionId, mode, state, writerEpoch, budgets, stopReason? | Một active writer/session; CAS revision |
| Event | eventId, sessionId, sessionSeq, envelope | Append-only; unique sequence |
| Invocation | invocationId, inputHash, targetRevision, state, receiptRef | Một logical command; unknown không replay |
| Checkpoint | checkpointId, sessionSeq, transcriptRef, contextRef, configHash, workspaceSnapshotRef, pendingInvocations | Tham chiếu event prefix đã committed |
| Grant | grantId, scopeHash, policyRevision, expiry, revocation | Secrets không nằm trong grant |
| Artifact | artifactId, mediaType, contentHash, size, retention, owner | Authorization khi đọc, content không mặc định trusted |

Session states: open/archived/deleting/deleted. Run states là runtime contract. Message states: partial/committed/interrupted; partial stream snapshot không giả thành complete message. Run recovery chuyển interrupted/recovery_required, không trực tiếp running trước reconcile.

Atomic unit: append durable events + update materialized session/run revision + invocation metadata trong cùng transaction. Publish sau commit. Checkpoint chỉ tham chiếu complete transaction; workspace filesystem không atomic cùng SQLite, do đó receipt và expectedRevision bắt buộc. SQLite single-writer, WAL dự kiến cần thử Bun/OS; busy timeout hữu hạn, queue bounded; lease epoch ngăn writer cũ sau restart ghi tiếp.

Resume input: sessionId, checkpointId hoặc durable cursor, expectedRevision, principal. Output: canonical transcript, active/unknown invocations, pinned config/profiles, workspace mismatch diagnostics. Không hồi sinh approval đã expired, model stream cũ, plugin handles hoặc credential bytes.

Retention: tách event metadata, prompt/tool content, audit và artifacts; configurable deletion theo owner; tombstone trước GC references. Backups phải mã hóa khi chứa nội dung repository và không lưu tokens. SQLite không tự mã hóa; encrypted DB/OS storage còn cần chọn. Export bỏ secrets và đánh dấu schemaVersion; import là untrusted data và không chạy embedded commands.

Migrations: monotonic schemaVersion, backup/restore và exclusive migration lock, reject newer unsupported DB; không âm thầm downgrade. Durable envelope major khác DB schema version. Rebuild views từ events cần đảm bảo không replay effects.

Acceptance: power-loss giữa intent/effect/result; concurrent resume; migration interruption; disk full trước approval và trước result; artifact GC vẫn giữ checkpoint references; tenant isolation và deletion. Chi tiết [persistence subsystem](../subsystems/persistence.md).

## PA1/TUI1 schema 2 usage receipts

[ADR 0009](../adr/0009-command-telemetry-and-account-continuation.md) adds transactional `turn_receipts(conversation, revision, data)` and migrates SQLite `user_version` 0/1 to 2. Newer versions are rejected. Turn outcome, times, selection IDs, nullable usage, price provenance and optional context/quota measurements are stored; prompts, credential material and reasoning text are excluded from receipts. Pending messages and initial receipts, and completed/interrupted messages and final receipts, are atomic pairs. Intermediate reported usage/context is persisted without asserting successful completion. Unclean exits can leave pending/unfinalized receipts; the UI does not report these as completed. No fabricated history backfill. Account continuation copies only committed messages into a new session, retaining the original and clearing session permission grants.

## TUI appearance profile 2

[ADR 0011](../adr/0011-monochrome-appearance.md) replaces the previous selectable multicolor catalog with system, dark and light monochrome appearances. Schema-1 settings remain readable: retired theme/wallpaper selections migrate separately for global and current project while preserving the selected mode and unrelated settings. Existing custom-theme files are retained without being offered as active choices. No SQLite or settings schema migration is required.

## TUI appearance profile 3

[ADR 0012](../adr/0012-theme-naming-and-semantic-colors.md) uses canonical IDs `auto`, `dark`, `light` and a new default ID `auto`; the stored `mode` values and schema remain unchanged. Profile-2 IDs are accepted aliases and migrate on initialization, separately for global and active project. Dark/light surfaces retain semantic accent/status/syntax colors. Downgrading to software before profile 2 may fall back to its own default for unfamiliar IDs.

## Implemented contract 1.12 / SQLite 4

[ADR 0030](../adr/0030-durable-conversation-recovery.md) supersedes the blanket future-only status and committed-only continuation rule above. SQLite owns ordered execution turns/events and task/context checkpoints. User acceptance is durable before model work; text, call intent and actual results survive failure. Terminal lifecycle transitions and event sequence/pairing are validated. Recovery merges legacy rows and journal ranges without invoking tools. Missing outcomes are unknown or not-executed, never successful. Resume and fork preserve evidence, clear grants and require current policy/revalidation for new calls.

Schema 0–3 upgrades transactionally to 4, adding execution_turns, conversation_events, conversation_checkpoints and tool_audit.scope_hash without rewriting historical messages. Versions above 4 are rejected; no downgrade. DELETE journal / FULL sync are used, not the historical proposed WAL/lease system. Live PID ownership fences concurrent turns; PID reuse fails closed. throughRevision in context snapshots is a hashed canonical-message prefix count. Optional store methods preserve custom-port compatibility; crash recovery requires the SQLite implementation. Filesystem effects are not atomic with SQLite receipts.
