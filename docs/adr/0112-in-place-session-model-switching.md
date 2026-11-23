# ADR 0112: In-Place Session Model and Account Switching

- **Status:** Accepted
- **Date:** 2026-11-22
- **Contract version:** `1.58` (additive; SQLite schema remains `13`)
- **Updates:** Fork-on-switch clauses of [ADR 0009](0009-command-telemetry-and-account-continuation.md) and [ADR 0074](0074-p3-review-and-session-controls.md)

## Context

Previously, switching models or switching accounts while continuing a conversation either dropped the active session handle (`currentSession = null` on default-scope `selectModel`) or silently called `forkSession` to allocate a new session ID (`selectModel(..., {scope: 'session'})` and `switchAccount(..., continueHistory = true)`).

As a result:

1. Compaction checkpoints (`/compact`) and subsequent turns written after a model switch were persisted under the newly forked session ID rather than the original session ID.
2. Running `cosmew --resume <original-id>` reopened the frozen pre-switch conversation with uncompacted context and missing post-switch turns.
3. In the Ink TUI, `TranscriptItem` resolved its detailed header label as `model ?? item.model` (letting the current session model overwrite older turns), and `messagesToTranscript` did not restore per-turn `item.model` from `turn_receipts` on resume.
4. Explicit `/fork` (`SqliteConversations.fork`) did not carry over verified compaction checkpoints (`conversation_checkpoints.context`) even when the copied prefix hash matched.

## Decision

1. **One conversation = one stable session ID across model/account switches:**
   - Add optional `ConversationStore.updateSelection?(id: string, selection: Selection): void` in `@cosmew/contracts` (`CONTRACT_VERSION = '1.58'`).
   - Implement `SqliteConversations.updateSelection` in `@cosmew/persistence` inside an `IMMEDIATE` transaction: validate `selection` with `selectionSchema`, verify the conversation exists (`NOT_FOUND`), reject active `pending`/`running` turns (`POLICY`), and update `conversations.selection` in place.
   - Add optional `FutrynBackendPorts.setSessionSelection?(id: string, selection: Selection)` in `@cosmew/sdk` and wire it in `apps/cli/src/bootstrap/startup.ts`: verify workspace ownership (`assertSessionWorkspace`), reject active turns (`POLICY`), validate target account/model (`AUTH`/`NOT_FOUND`) before mutating SQLite, call `conversations.updateSelection`, and reopen the active `Conversation` instance so model adapter, context/output limits, tool availability and compaction state match the new selection immediately.
   - Update `FutrynClient.selectModel` (default and `scope: 'session'`) and `FutrynClient.switchAccount(..., continueHistory = true)` to call `setSessionSelection` in place when available, with rollback to the previous selection if saving default settings fails. Keep explicit fallback behavior for minimal custom embeddings that omit `setSessionSelection`.
2. **Preserve security invariants and explicit commands:**
   - Switching model or account continues to call `clearSessionAuthorization()`, revoking session tool grants, elevated permission modes and pending approvals.
   - `logoutAccount` continues to clear `currentSession = null` and never transfers an active conversation to a fallback account (ADR 0009).
   - `providerReplay` remains bound to all five keys (`providerId`, `accountId`, `protocol`, `modelId`, `endpointHash`) in `@cosmew/models`, preventing cross-model/cross-provider signature leakage within the same session.
   - Explicit `/fork` (`client.forkSession`) continues to allocate a new session ID and now preserves `conversation_checkpoints.context` when the copied prefix matches `throughRevision` and `sourceHash`.
3. **Per-turn model attribution without changing `messageSchema` or `contextHash`:**
   - Do **not** add fields to `Message` / `messageSchema`, keeping existing `ContextSnapshot.sourceHash` values in SQLite 100% valid.
   - `turn_receipts` and `usage().byModel` continue to record per-turn `accountId` and `modelId`.
   - In the TUI, `TranscriptItem` prefers `item.model ?? model`, `messagesToTranscript` restores per-turn `item.model` from `SessionRecord.turns` and `SessionRecord.recovery.turns` (excluding `user-shell` turns), and `IntegratedShell` / `/model` keep the current transcript view when `activeSessionId` does not change.

## Consequences

- No SQLite schema migration is needed (schema remains `13`); no new dependencies or package edges are added.
- Resuming a session by its original ID always recovers the latest model selection, compaction checkpoint, and full multi-model turn history.
- Existing tests asserting the old fork/reset-to-null behavior on switch are updated to assert in-place session continuity.
