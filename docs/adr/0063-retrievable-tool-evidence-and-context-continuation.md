# ADR 0063 — Retrievable tool evidence and context continuation

Date: 2026-11-19. Status: accepted for implementation by the current user request. Contract 1.37; no external agent runtime or new dependency.

## Problem and upstream evidence

A request occupying 87% of the usable context skipped the model-compaction guard (90%) and subsequently withdrew tools (85%). Separately, every request recut read output above 24,000 bytes even when the entire producer page fit. A fixture with its dependency import in the middle of a 40 KiB page lost that import before the next model request and could not follow the code.

This does not establish that output truncation itself is wrong or that model quality is below a particular product. All researched agents bound tool results. Sources inspected 2026-11-19:

- Claude Code official [output limits](https://code.claude.com/docs/en/tools-reference#output-limits) and [context lifecycle](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up). Documented behavior, no public internal revision; exact live parity Needs verification.
- OpenCode revision `852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252`: [`packages/core/src/tool-output.ts`](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/tool-output.ts), [`session/runner/llm.ts`](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/session/runner/llm.ts). Persists bounded tool artifacts with pointers; compact then continue.
- Codex revision `090be4df0724cdef5758e6a0934ba557af8b6bbe`: [`context_manager/history.rs`](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/context_manager/history.rs#L628-L691), [`session/turn.rs`](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/session/turn.rs#L767-L814). Per-tool clipping is legitimate; successful compaction continues the active turn.

## Decision

1. Align automatic compaction with context pressure before considering tool withdrawal. At 85% of the usable window, attempt model summary and existing fallback. Measure the replacement and keep tools if below pressure. Failed/no-gain attempts remain bounded; a still-unfitting request stops honestly. Cancellation does not publish a partial handoff.
2. Preserve the producer's complete bounded page while the full request fits. Context-layer head/tail trimming is a pressure fallback, never an unconditional per-result transform. UTF-8 slicing respects code-point boundaries. Raw durable messages remain intact.
3. Add a bounded redacted tool-output archive port owned by persistence and a registered `tool_output` retrieval tool. The composition root binds reads/writes to the active session/workspace. Archive references are opaque UUIDs, historical evidence, never paths or permission grants. Paging/search stays bounded and reports coverage/remaining output.
4. Retrieval runs through dispatcher authorization/revalidation/audit and applies current redaction. Scope, permission-context and grant revocation changes refuse old handles; filesystem source rules are checked where available, bound to the captured canonical source and revalidated after approval awaits and at execution. Retrieval never reruns the source process/tool. Denied outputs and mutations are not cached as permission grants. Storage failure cannot turn an already-applied change into a retryable action.
5. Preserve bounded actual archive references in model and excerpt handoffs. Do not rely on the summarizer to reproduce a UUID. References from context remain untrusted data and grant no access. Archive storage is durable, but permission scope is process/session-local: host restart invalidates old handles rather than restoring past grants; the agent must reread the source under current permissions.
6. Guidance connects discovery to entry points, implementation, callers and relevant tests; requires resolving contradictions and missing output before relying on it, and checking actual results after edits. No imposed delay, minimum call count or claim that prompts guarantee model competence.

## Boundaries and alternatives

Simply increasing limits consumes more input without ensuring relevant evidence. Mandatory slow calls are not a comprehension mechanism. An unrestricted state-directory file reader violates the security boundary. The chosen archive is scoped, bounded and revocable; adapters still only translate, core still depends on contracts ports, persistence owns durable writes.

This work does not change provider reasoning protocols or promise Claude/Codex parity. Provider-specific reasoning support requires separately verified wire semantics. Existing producer limits still apply: an archive can recover captured text, not bytes a process runtime already omitted.

## Verification and limits

Contract/security tests exercise 87% continuation, middle-evidence delivery, UTF-8, compaction fallback/no gain/cancellation, host-preserved pointers, archive scoping/bounds/redaction/revocation and no process replay. End-to-end fixture tests derive the next dependency path from actual wire-visible read results, edit the discovered implementation, read back, and exercise the changed function while preserving unrelated files. Deterministic fixture behavior is transport/runtime evidence, not proof that a real model follows guidance.

Comparative authenticated model quality and live provider acceptance: **Needs verification**. Evaluate the same model/effort/task/permissions with and without this change; score correct completion, constraint retention and verification, with latency/token/call counts as diagnostics.
