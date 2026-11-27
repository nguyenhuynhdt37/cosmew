# ADR 0120: Executable Lifecycle Hooks, Anthropic Prompt Caching, and UX Slash Commands

- **Status**: Accepted
- **Date**: 2026-11-27
- **Contract version**: `1.65` (additive over `1.64`)

## Context

Cosmew previously reserved `hook.ran` and `HooksSnapshot` (`supported: false`) without an execution runtime, sent Anthropic API requests without explicit `cache_control` breakpoints, and left daily-driver Claude Code slash commands (`/add-dir`, `/reload-skills`, `/autocompact`, `/btw`, structured `/export`, `/clear <name>`) unavailable while `BackendCapabilitiesReport` still hardcoded legacy PA1 `'not-implemented'` values.

## Decisions

### 1. Anthropic Prompt Caching (`@cosmew/models`)
- For `protocol === 'anthropic'`, `ProviderAdapter` applies explicit ephemeral block-level breakpoints (`cacheControl: {type: 'ephemeral'}`) via `applyAnthropicCacheControl`:
  - Breakpoint 1: last tool definition (if tools are offered).
  - Breakpoint 2: system instructions (`SystemModelMessage` with `providerOptions.anthropic.cacheControl`).
  - Breakpoints 3–4: up to 2 most recent cacheable conversation messages (skipping empty or reasoning-trailing messages so `@ai-sdk/anthropic`'s validator emits zero warnings and total breakpoints never exceed 4).
- Non-Anthropic protocols are untouched.
- If an Anthropic-compatible third-party gateway rejects `cache_control` with HTTP 400 before observable output, the adapter remembers `anthropicCacheUnsupported` for that instance and retries once without `cacheControl`.

### 2. Executable Lifecycle Hooks (`contracts`, `security`, `tools`, `core`, `cli`, `sdk`, `tui`)
- Settings schema (`~/.cosmew/settings.json`, `<project>/.cosmew/settings.json`, `<project>/.cosmew/settings.local.json`) accepts Claude Code style `hooks.<Event>[{matcher?, hooks: [{type: "command", command, timeout?}]}]` for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, and `SessionStart`.
- **Untrusted repository settings invariant**: `describeLoosening()` lists every configured hook; `mergeSettings()` merges hooks **only** from `trusted` layers (`user`, or `project`/`local` approved by SHA-256 hash). Unapproved repository hooks are ignored and counted in `untrustedPendingCount`.
- **No permission escalation invariant**: `PreToolUse` may block (`exit 2` or JSON `decision: "block"` / `continue: false` / `permissionDecision: "deny"`) or add redacted context, but never grants permissions or bypasses `ToolOrchestrator` policy/approval/revalidation.
- **Read-only / sandbox invariants**: command hooks are disabled in `plan` mode; before folder consent (`toolsEnabled === false`) no hook executes; when `sandbox.enabled` is true hooks run inside `CommandRuntime` sandbox and never silently fall back outside it; environment variables matching secret/credential patterns are scrubbed; inputs and outputs are redacted and byte-bounded.
- **Loop guard**: `Stop` hook continuations are capped at 2 per turn and skipped once a budget/context stop reason is active.

### 3. Daily UX Slash Commands & Capability Honesty
- Enabled `/hooks` (interactive overlay panel), `/add-dir [--save] <path>`, `/reload-skills`, `/autocompact [on|off|status]`, `/btw <question>` (ephemeral side query without tools or durable history mutation), structured `/export` (`.md`, `.json` without `providerReplay`, `.txt`), and `/clear <name>`.
- Updated `BackendCapabilitiesReport` to reflect wired ports (`generalToolsExecution`, `delegatedSubagents`, `hooks`) instead of hardcoded `'not-implemented'`.

## Consequences
- No new package dependency edges are added (`dependency-rules.md` unchanged).
- `CONTRACT_VERSION` bumps from `1.64` to `1.65`.
