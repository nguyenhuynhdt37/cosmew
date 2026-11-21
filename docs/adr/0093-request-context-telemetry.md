# ADR 0093 — Request context and diagnostics

Date 2026-11-22. Accepted. Shared contract 1.47. SQLite schema remains 11.

The TUI used printable conversation history to estimate context. This included older messages whose model-visible history had already been compacted. It also omitted tool schemas and agent instructions. The `/context` grid showed a 90% threshold while the runtime used 85%.

The SDK uses the core request estimate during sampling. Idle previews use the current context checkpoint, the known project instruction size, the draft and staged images, queued steering, and the current tool schemas and guidance. Content loaded only at send time, such as a skill body, enters the estimate once the request is prepared. The estimator uses UTF-8 bytes and media approximations. Provider framing and tokenization can differ. The display and runtime share the 85% automatic compaction threshold and use the effective input window after any explicit output reservation. The runtime can also use provider usage from the preceding round as a pressure signal.

Regular model requests journal the prepared estimate with `model.requested`. The matching `model.finished` records outcome and provider-reported input and output counters when available. Interrupted processes may leave a request without a finish record. The terminal turn receipt and `turn.finished` store the sanitized error code. Old records remain readable and unknown counters stay unknown. Aggregate `/usage` can include repeated inputs, compaction and child usage. Only regular sampling rounds get individual journal entries. Stored telemetry excludes raw provider errors, requests and credentials.

Provider HTTP 400/413 envelopes with exact context-limit codes map to `CONTEXT_LIMIT`. Live payload coverage for provider-specific context-limit errors remains to be verified.
