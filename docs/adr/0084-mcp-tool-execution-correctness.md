# ADR 0084 — MCP execution, validation and retrievable evidence

Date: 2026-11-21. Status: accepted implementation; contract 1.41 (additive archive source kind).

## Decision

Unknown and mutating MCP tools take the existing exclusive execution slot. An explicit
MCP `annotations.readOnlyHint: true` opts into shared scheduling only. This is untrusted
server metadata, never a grant: default/acceptEdits calls and MCP archive retrieval still
use the normal MCP permission flow; plan and read-only agents remain denied.

ToolDispatcher validates MCP arguments against the advertised schema before approval.
Remote schemas are bounded to 8 KiB, 512 structural nodes and depth 16. AJV 8.20.0
(MIT, already selected by models) is now also a direct tools dependency. Validation never
coerces, adds defaults, removes fields, fetches references or runs async validation.
References, regex/pattern keywords, format, contains and uniqueItems are refused; this is
a deliberately bounded draft-07 subset, not universal JSON Schema compatibility. Invalid,
oversized and unsupported schemas disable the tool and omit it from model-facing tool
descriptors, so unsupported function-schema keywords cannot poison a provider request.
Direct calls still return explicit schema refusal diagnostics before approval or execution;
valid tools remain exposed. No unrestricted-object fallback is advertised. Discovery refuses
an entire server with an explicit diagnostic when its advertised input schema is missing/invalid/oversized.
Schema or metadata changes replace registrations; an awaiting approval cannot execute the
old registration after revalidation.

Application `isError` responses preserve bounded redacted text (and structured result text)
separately from transport exceptions. ToolDispatcher reports `MCP_TOOL_ERROR` with repair
guidance. SDK exceptions retain fixed diagnostics; endpoints, headers and arbitrary exception
payloads are not surfaced. Existing 64 KiB capture bounds remain: omitted producer bytes
cannot be recovered. Captured MCP output exceeding the dispatcher threshold is archived
before display clipping, including captured application failures. `tool_output` retrieves
captured evidence without replaying MCP side effects. Handles remain scoped to the current
session/workspace, policy fingerprint and grant generation, with normal MCP reauthorization.

## Evidence and limits

Regression tests exercise schema/type/required/additionalProperties rejection before
approval, malformed/oversized/expensive schema refusal, shared/exclusive ordering and
read/write exclusion with the real execution gate, normal approvals, registration change
while approval awaits, redaction/error separation, and archived tail retrieval/revocation.
Local stdio fixtures are protocol tests, not live compatibility proof. HTTP/provider live
verification and exact Claude Code scheduling parity remain **Needs verification**.

Upstream comparison source: openai/codex revision
`4739e94260dccd4ec050d457b437a5fc82e3493e`, inspected 2026-11-21,
https://github.com/openai/codex/blob/4739e94260dccd4ec050d457b437a5fc82e3493e/codex-rs/core/src/tools/handlers/mcp.rs#L187
(explicit parallel/read-only metadata, default false). This does not reverify historical
wave-1 pins or claim measured latency/token parity.
