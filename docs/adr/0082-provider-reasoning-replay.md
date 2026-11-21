# ADR 0082: Private provider-bound reasoning replay

Date: 2026-11-21. Status: Accepted. Public contract: 1.41; SQLite schema remains 10.

## Problem

The adapter reduced reasoning to display deltas and tool calls to normalized arguments. This lost Responses encrypted-only items, Gemini thought signatures on their original parts, and Anthropic signed/redacted thinking. Session JSON could not recover bytes already discarded by the adapter. Journal reconstruction also replaced completed stored messages with visible event-derived text/calls, losing private state a second time.

## Decision

Add optional `Message.providerReplay` and an internal `ModelEvent` named `providerReplay`. Its version-1 envelope binds an ordered list of reasoning/text/tool-call references to the configured provider ID, account UUID, protocol, model ID and SHA-256 of its base URL. Tool inputs remain canonical `Message.toolCalls` values rather than being duplicated in the envelope. Only allowlisted continuation fields cross the adapter: Responses `itemId`/`reasoningEncryptedContent`, Google `thoughtSignature`, Anthropic `signature`/`redactedData`/signed-compaction `type`. Chat's existing opt-in reasoning replay also receives a bound envelope. There is no arbitrary `providerOptions` input.

The adapter captures final ordered SDK content, including empty reasoning parts, after clean stream completion and emits private state immediately before `completed`. Cancellation, errors and preemption do not commit an incomplete envelope. Core consumes this event internally and attaches it to committed assistant messages; it never forwards the event to display consumers or writes the envelope into the execution event journal. A reasoning-only `endTurn:false` response is a continuation, not an empty final answer. Explicit `length` remains an incomplete response under the existing core invariant.

Responses requests use `store:false` and explicitly request `reasoning.encrypted_content` for stateless replay on both OAuth and API-key transports. Existing effort/summary behavior remains unchanged. No Anthropic or Gemini thinking controls are introduced.

The strict schema permits at most 2,048 ordered parts, 524,288 characters per text/opaque field, and 1 MiB of total UTF-8 JSON per envelope. Unknown fields, protocol-inappropriate metadata, user/tool-origin envelopes and tool-call order mismatches are rejected. Binding mismatches drop private replay and use ordinary canonical history; an existing bound Chat envelope cannot fall back to unbound reasoning when its binding mismatches. Historical pre-envelope Chat sessions retain their existing opt-in reasoning compatibility path; their original endpoint/model provenance is unavailable.

Session `parts` and private turn checkpoints retain the envelope without a schema migration. Opaque signature/ciphertext bytes are never redacted into invalid values. Visible content, reasoning text and canonical tool arguments still follow ordinary redaction. If redaction changes signed plaintext or canonical inputs, persistence drops the whole replay envelope; checkpoints retain their existing fail-closed secret/size behavior. Opaque fields stay private in SDK session projections and event streams.

Recovery first validates the execution journal as before. It reattaches private state from stored completed assistant messages only when a journal `model.completed` proves that response finished and visible text plus ordered calls match exactly. Partial responses cannot gain replay authority from a stored envelope. The envelope grants no tool execution permission and never replays a tool.

## Evidence and validation

Regression tests in `tests/contracts/provider-reasoning-replay.test.ts` exercise installed SDK serializers with synthetic transports: Gemini parallel signatures and sequential rounds; Responses encrypted-only items with empty summaries; Anthropic signed/redacted blocks; provider/account/model/endpoint isolation; UTF-8 bounds; rejection of user-origin/unknown state; cancellation; private event-journal boundaries; actual database close/reopen; checkpoints; plaintext-secret redaction; and interrupted recovery. Initial adapter, persistence/restart and empty-continuation regressions were observed failing before implementation. Existing adapter, effort, DeepSeek, checkpoint and conversation-recovery suites remain focused compatibility checks.

Primary documentation retrieved through Context7 on 2026-11-21:

- https://ai-sdk.dev/providers/ai-sdk-providers/openai — typed Responses reasoning metadata and stateless encrypted replay.
- https://ai-sdk.dev/providers/ai-sdk-providers/anthropic — response messages retain signed continuation metadata.
- https://ai.google.dev/gemini-api/docs/thought-signatures — original-part signature preservation (also referenced by installed Google serializer).

Pinned installed source revisions: `ai@7.0.173` (`src/generate-text/to-response-messages.ts`, `stream-text.ts`); `@ai-sdk/openai@4.0.118` (`src/responses/openai-responses-language-model.ts`, `convert-to-openai-responses-input.ts`); `@ai-sdk/google@4.0.121` (`src/convert-to-google-messages.ts`); `@ai-sdk/anthropic@4.0.105` (`src/convert-to-anthropic-prompt.ts`); `@ai-sdk/openai-compatible@3.0.92`. Package source, rather than an unpinned branch, determines the serializer behavior tested here. No dependencies were added.

Live authenticated interoperability, semantic reasoning quality, exact Claude Code CLI parity, and non-macOS compatibility remain **Needs verification**. These fixtures do not claim live provider acceptance. Dropping state after redaction or a provider/model switch can lose reasoning continuity intentionally; confidential plaintext is not retained to preserve a signature. Provider changes cannot recover historical metadata that earlier versions discarded.

Account identity is mandatory within every new envelope: switching accounts with the same provider, model and base URL drops the previous account's state. The endpoint fingerprint currently covers base URL only; query-parameter/header configuration changes under the same account are not a full configuration-revision boundary. **Needs verification**: a non-secret configuration revision binding if gateways use such options to select independent model identities. Credentials and credential-bearing headers are never hashed or stored in replay bindings.
