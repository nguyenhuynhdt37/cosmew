# ADR 0020: Progressive code exploration (Task 02)

Accepted 2026-11-15 by the user's explicit Task 02 request. Scope: guidance and bounded-loop changes so the model chooses each next read from the actual previous tool results. It is not a rewrite of the agent loop. No new tools, shell, write, MCP, RAG, memory, live-activity TUI, dependency, package edge or database migration.

## Audit of the existing loops

- **Direct providers** (`packages/core/src/agent/engine.ts`): round-based. Each round offers `read`/`glob`/`grep`, executes every completed call in order through the injected `ToolPort` (`ToolDispatcher`: validate → workspace containment → `evaluateRead` → approval → audit → redact), appends `assistant{toolCalls}` then one `tool` message per call, and sends the whole history again. Pairing was already correct (call id → `toolCallId`, adapters map to provider-native ids). Gaps: the model received **no exploration guidance at all** (tool descriptions only); the cap was 8 rounds with up to 32 calls *per round* (up to 256 calls per turn); identical rereads were re-sent in full; when the cap hit, tools silently disappeared.
- **Codex subscription** (`apps/cli/src/subscriptions/host.ts`, ADR 0018): one runtime turn; dynamic tool callbacks run through the same core `ToolPort` and are capped at 32 per turn (exceeding it failed the turn). Codex already had host developer instructions with investigation advice, but they were Codex-only text.
- Other subscription runtimes stay chat-only (ADR 0008); nothing changes for them.

## Decision

1. **One shared guidance text** in `core/agent/guidance.ts`, built only from the tool names actually offered and the budget. It asks for targeted discovery first, reading what discovery found, following imports/calls/references from the results, waiting for a result when the next step depends on it, batching independent calls *only if the model can issue several in one response* (no provider assumption), not repeating calls, stopping when evidence suffices and naming missing evidence. It is static per tool set, so providers can cache it, and it never contains repository or user text.
2. **Trusted channel.** Contract 1.8 adds optional `ModelRequest.instructions` (≤ 8000 chars). The AI-SDK adapter maps it to `system` (Chat Completions/Responses/Anthropic/Gemini each place it in their native system channel). The Codex host appends it to its existing `developerInstructions`. It is sent only when tools are offered (or were used earlier in the turn), is not stored with the conversation, and repository content still never enters system/developer fields (ADR 0019 unchanged).
3. **Budget, re-evaluated.** Old: 8 rounds × 32 calls. A one-call-per-round model needs a round per dependency hop (discover → read → follow → follow …), so 8 rounds cut legitimate investigations short, while 256 calls per turn was far looser than needed. New: `MAX_TOOL_ROUNDS = 16` rounds that may offer tools **and** `MAX_TOOL_CALLS = 32` executed calls per user turn, shared by both paths. The round after the budget offers no tools and carries a notice telling the model the budget is used up and to report what is missing. Calls the model makes beyond 32 get a paired `TOOL_BUDGET` error result and are never executed (so every call still has a result). For Codex, 4 extra refused attempts (`MAX_INLINE_TOOL_ATTEMPTS = 36`) are answered before the turn fails closed, as before. The loop stays strictly finite.
4. **Unchanged rereads.** A successful call with identical tool + arguments whose content equals the earlier result in the same turn returns a short `[unchanged]` notice instead of the content. The call still goes through the dispatcher (permission check, audit, redaction), so a changed file is detected and returned in full. Nothing is cached across turns.

Preserved: permission engine and approvals, Project Context Loader, `ToolResult`/`Message`/event schemas, cancellation, durable storage (`complete(..., intermediate)` only on success), provider rejection fallback (ADR 0017), Codex fail-closed checks.

## Contract 1.8

Additive optional field `ModelRequest.instructions`. Adapters that ignore it keep working. Durable data, settings and SDK API are unchanged; no migration. `@hannes/core` additionally exports the budget constants and the guidance builder.

## Acceptance (deterministic)

The fixture "models" are deterministic policies that see only the request that reached the fixture server: they parse the tool results Hannes actually sent and derive the next call from them (regex over the returned `import` line). They contain no path of the fixture repository except the discovery pattern. Reads are real dispatcher reads of temporary files, verified through `tool_audit`.

`tests/end-to-end/progressive-exploration.test.ts` (Chat Completions and Anthropic wire formats) and the Codex cases in `tests/end-to-end/subscriptions.test.ts` verify:

- `glob **/routes.*` → `read src/routes.ts` → `read src/service.ts` (from the import) → answer quoting the real definition; `src/billing.ts` is never read and its marker never leaves the machine.
- Each request carries every earlier result paired to its call (no orphan results, no unanswered calls); UI `toolResult` events match `toolCallComplete` ids; stored history is `assistant{call}` → `tool` pairs and resumes with them; guidance appears in the system channel of every round and not in storage.
- Negative: when `routes.ts` imports `./token-check`, the model reads `src/token-check.ts`, never `service.ts`.
- Missing file → explicit `MISSING` answer, no retry loop. Independent reads: three calls in one round, one round trip, results in call order.
- Permission denial of a secret file: dialog request, deny, the content never reaches the provider, the model reports the gap.
- Cancellation between rounds: no further read, no partial tool history committed, conversation usable afterwards.
- Round budget: a 40-file dependency chain stops after 16 rounds; the final request offers no tools, carries the budget notice, and the answer names the first uninspected file. Call budget: 32 executed, 3 paired refusals, never executed.
- Rereads: second identical read returns `[unchanged]`, a read after the file changed returns new content; all three still audited.
- No folder consent: request has no tools and no guidance.
- Codex: the same discovery/follow and negative cases through `item/tool/call`; runaway callers fail closed after 36 attempts with exactly 32 executed; a caller that stops after the refusal completes.

Result 2026-11-15: `bun run lint` passed; `bun test tests` **292 pass, 5 skip, 0 fail** (297 tests, 27 files). The five skips need a native keyring, installed vendor CLIs or interactive login and are not counted.

## Limits

- Fixture policies prove that real results reach the next request, are correctly paired, and that the loop, budget and permission paths behave; they do **not** prove that a real model follows the guidance. No live provider evaluation was run for this task (Needs verification).
- Whether a provider issues parallel calls is model-dependent; the guidance only allows it.
- The `[unchanged]` check compares content within one turn only; it does not stop a model from rereading across turns.
- 16 rounds / 32 calls are engineering choices sized for small dependency chains, not measured optima.
