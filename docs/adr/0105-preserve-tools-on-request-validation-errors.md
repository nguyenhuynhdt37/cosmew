# ADR 0105 — Preserve tool availability on request validation errors

Status: Accepted
Date: 2026-11-22

## Context

A live Cosmew screenshot showed a failed request labelled as unsupported workspace tools, followed by text-only promises to work and completed turns. The selected Grok model's local catalog was marked `tools: unsupported`.

Three independent paths explain this failure pattern:

1. The provider adapter compiled every offered tool with draft-07 AJV. The actual OpenAI Docs MCP schema advertises JSON Schema 2020-12, already supported at ToolDispatcher after ADR 0104. Adapter compilation still rejected it with INVALID_INPUT before any HTTP request.
2. Core treated any first-round INVALID_INPUT with tools offered as proof of tool incompatibility. It converted the error to UNSUPPORTED and invoked a callback that persisted `tools: unsupported`. Generic provider HTTP 400 and local schema errors both triggered this inference.
3. TUI described every UNSUPPORTED as tool rejection, although unsupported reasoning settings use the same code. When no tools were available, core provided no capability-limitation guidance.

The exact original Grok request was not captured; the screenshot alone cannot establish which request field was rejected. Local adapter, core and end-to-end reproductions verify the concrete failure paths above without paid generation.

## Decision

- Remove implicit tool-capability inference and INVALID_INPUT-to-UNSUPPORTED rewriting. Preserve the original safe error; do not retry automatically, resend without tools, or change durable catalog capabilities. Keep the legacy callback constructor shape for compatibility; generic request errors do not invoke it. This supersedes ADR 0017's HTTP-400 inference.
- Model/tool availability continues to honor explicit discovery metadata and folder consent. Do not globally erase legitimate unsupported metadata. Rediscovery is the supported way to replace an inferred stale catalog mark.
- Compile explicitly declared JSON Schema 2020-12 (including optional trailing fragment) with installed AJV 8.20.0's `ajv/dist/2020.js` in the model adapter, as well as at the dispatcher. Preserve original schema semantics and wire schema. Unknown dialects, invalid/async schemas and duplicate tool names remain rejected. No dependency change.
- TUI unsupported/invalid-input hints explain request/model/effort checks without claiming that tool access was changed. A persistent fullscreen Chat only warning exposes actual SDK `status().toolsEnabled`, distinct from folder consent.
- With no tools available in a request, host instructions state that inspection, commands, installation and background actions cannot run; the model must explain the limitation rather than claim ongoing work. Do not guess user intent or force extra model calls from text heuristics.

No event/SDK wire shape, permission grant or database schema changes; contract remains 1.54. Error-code preservation corrects an inference bug rather than introducing a new error type.

## Verification and recovery

- Exact OpenAI Docs schema failed at adapter compilation before the fix, with zero HTTP requests. Chat and Responses now reach real local HTTP fixtures with the schema unchanged, with and without the trailing fragment.
- Core regressions failed before the fix; afterward INVALID_INPUT and reasoning UNSUPPORTED retain identity, usage and history, never invoke the rejection callback, and still offer tools on the next turn.
- End-to-end regressions cover supported and unknown tool capabilities after generic HTTP 400, and a stale reasoning-effort selection that fails before HTTP. A subsequent valid request executes a real fixture file read.
- TUI integration verifies a persistent Chat only warning after a text reply. No-tools core guidance is verified on the actual outbound ModelRequest.
- Read-only local metadata inspection found grok-4.7 marked unsupported. One normal online catalog rediscovery replaced that with unknown, preserving configured reasoning levels. No credentials, sessions or user preferences were edited directly, and no paid model generation was used. The already-running process must restart to load the fixed code.

## Final check evidence

Targeted runtime/UI regressions: 33 passed; adapter suite: 33 passed; the two CLI-history expectation updates: 2 passed. Typecheck, lint/format and diff checks passed. The first full quality run had 1,992 passing tests, 13 skips and four stale expectation failures (README title and the new leading no-tools system guidance); all four passed after their expectations were updated while preserving exact conversation-order checks.

The final full run had 1,995 passes, 13 skips and two isolation-guard failures: the same real `~/.futryn/provider-auth.sqlite` changed during a time-budget test and at teardown. Two independently running Cosmew CLI processes held the database (elapsed about 22 minutes and 6 hours); the writer was not conclusively attributed. The affected time-budget test passed in isolation afterward (1 pass, 0 failures). The guard was never disabled and no real database was restored. Consequently the aggregate quality gate is **not green**, despite passing functional regressions. Logs: `/tmp/cosmew-tool-capability-quality-final.log` and `/tmp/cosmew-budget-isolated.log`.

A later metadata read found the tool capability marked unsupported again while the older CLI processes remained open. Recovery requires closing old Cosmew sessions, then normal `cosmew models list` rediscovery before launching the fixed CLI. Do not force a tools-supported flag or erase genuine discovery evidence. No paid Grok generation has been verified by this task.
