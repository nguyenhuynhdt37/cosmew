# ADR 0104 — Claude-style MCP dialog and bounded JSON Schema 2020-12

Status: Accepted
Date: 2026-11-22

## Context

The maintainer found the MCP name/URL form difficult to use and requested the Claude CLI interface. Live verification of the saved `openai-docs` endpoint succeeded at initialize/tools-list (five tools), but a dispatcher call failed with INVALID_INPUT before approval: its schema advertises draft 2020-12 while the validator only registered draft-07.

## Decision

Use the captured Claude Code 2.1.328 server-list pattern: “MCP servers”, count, user-server grouping, status glyphs/tool counts, arrow navigation, Enter and Esc. Source: `docs/delivery/tui-v4/reference/idle-100x30/20-cmd-mcp.txt`, captured 2026-11-19. The detailed actions and guided add form are Cosmew choices; exact parity beyond the captured screen is **Needs verification**.

Remove the top-level tab header. Keep registry/recommendations available as explicit list actions. Put tools/connect/enablement first in server details; move configuration, credentials and removal into Advanced settings. Show human-readable connection/authentication states and the safe endpoint. Preserve SDK-only management, masked credential input, default-Cancel confirmation and cancellation drain.

Remote setup asks for URL first and suggests an unused local name. Show both fields and examples, validate inline without losing drafts, support Tab/Shift+Tab, and revalidate every field before confirmation. Detect duplicate names before issuing a backend mutation. Clamp list navigation at the last action.

Select the installed AJV 8.20.0 draft-2020 entry point (`ajv/dist/2020.js`) when the schema explicitly declares `https://json-schema.org/draft/2020-12/schema` (optional trailing fragment). Keep draft-07 behavior otherwise; unknown dialects fail closed. Never strip `$schema` and reinterpret newer validation semantics as draft-07. Extend restricted-keyword inspection to 2020-12 schema positions (including prefixItems and unevaluated schemas). Preserve the 8 KiB/512-node/depth-16 bounds, no references/regex/async/network schema loading, and no coercion/default insertion/field removal. Existing deny/approval/plan/read-only behavior remains unchanged.

This extends the implementation's supported schema subset from ADR 0084 without changing wire contracts or database schema. No new dependency/version/license is introduced. Implementation reference inspected 2026-11-22: installed AJV 8.20.0 `dist/2020.js`; upstream documentation: https://ajv.js.org/json-schema.html#draft-2020-12.

## Verification

Two dispatcher regressions failed before the schema fix and passed afterward. Coverage includes the actual OpenAI search schema and invalid arguments before approval, 2020-12 dependentRequired semantics, unknown dialect rejection, restricted keywords in newer schema positions, masked secrets, explicit mutation confirmation, cancellation, guided add, duplicate names and nested back navigation.

Real auth-free smoke after the fix: OpenAI Docs handshake/listTools returned five tools; search through ToolDispatcher requested `mcp.call` approval, then returned `ok` with 1,892 characters. This verifies that endpoint and read-only call, not universal MCP/OAuth compatibility or paid model generation.

Final focused acceptance: typecheck/lint passed; MCP plus complete Ink test tree passed **707 tests, 4 skipped, 0 failed**, 8 snapshots and 28,062 assertions across 72 files (96.74s). The skipped opt-in color/terminal checks are not new acceptance evidence.

## Usability extension

The maintainer subsequently requested stronger visual hierarchy and easier access to capabilities. The dialog adds theme-aware state counts, rows and details, next-step guidance, local server/tool filtering, read-only snapshot refresh and visible connection diagnostics. Configuration issues are browsable instead of silently truncated. Managed installations omit unsupported executable replacement, and removal confirmation describes possible credential/sign-out effects. Transient snapshot errors offer retry instead of pretending the backend is unsupported. No new host action, dependency or wire contract is introduced. Colors are tested under dark/light ANSI rendering and NO_COLOR; local filtering and refresh do not make remote calls.

Final visual/usability integration: typecheck and lint passed. MCP plus complete Ink test tree: 721 passed, 4 skipped, 0 failed. 8 snapshots, 28192 expect() calls. Ran 725 tests across 73 files. [90.52s].
