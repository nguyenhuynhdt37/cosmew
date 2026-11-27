# ADR 0124: Headless CI/CD Flags, Path-scoped Rules & Custom Commands, Auto-Memory Extraction, and Extended LSP (Contract 1.69)

- **Status**: Accepted
- **Date**: 2026-11-27
- **Contract version**: `1.69` (additive over `1.68` in ADR 0123)
- **Dependencies added**: None (reuses existing `ajv` / `ajv/dist/2020` in `@cosmew/models`)

## Context

Following ADR 0120–0123, four developer-workflow gaps remained high-value daily requirements compared to Claude Code / Codex CLI / OpenCode:

1. **`cosmew exec` CI/CD controls**: headless automation lacked `--json-schema` structured-output enforcement, `--max-turns`, `--max-budget-usd`, `--fallback-model`, `--system-prompt`/`--append-system-prompt`, `--add-dir`, and `--resume`/`--continue`.
2. **Modular project instructions & custom commands**: repositories using Claude Code conventions store path-scoped rules in `.cosmew/rules/*.md` / `.claude/rules/*.md` (with YAML `paths:` globs), modularize `CLAUDE.md`/`AGENTS.md` via `@path/to/file` imports, and define prompt templates under `.cosmew/commands/*.md` / `.claude/commands/*.md`.
3. **Auto-memory extraction**: `~/.cosmew/config.toml` already parsed `memories.auto_extract`, but only emitted a diagnostic stating extraction was not implemented.
4. **Broader LSP language coverage**: `@cosmew/code-intel` shipped only 4 presets (TypeScript, Python, Go, Rust) and had no user-level custom server table.

## Decisions

### 1. Headless `cosmew exec` CI/CD Upgrades (`apps/cli/src/exec.ts`, `packages/models/src/schema-validator.ts`)
- `--json-schema <json|@file>` compiles draft-07 / 2020-12 JSON Schemas via Ajv before any model call (rejecting external `$ref` and schemas > 256 KiB; `@file` reads via `O_NOFOLLOW`), adds strict JSON formatting guidance, validates the final output, allows at most one bounded repair turn, and fails closed with `PROTOCOL` (exit `1`) if output still violates the schema.
- `--max-turns <1..200>` and `--max-budget-usd <usd>` configure `TurnBudget` (`maxSteps`, `maxCostUSD`) plus pre-flight `maxEstimatedCostUSD`.
- `--fallback-model <id>` retries once on `RATE_LIMIT` or `TRANSPORT` failures only if no tool call/result occurred yet.
- `--system-prompt` / `--append-system-prompt` flow through SDK `setAdditionalInstructions()` (capped at 16 KiB, always lower priority than host/security rules).
- `--add-dir <dir>` adds session-only additional working directories via `client.addAdditionalDirectory()` (retaining `.git` and Cosmew state blocks).
- `--resume <id>` and `--continue` (mutually exclusive) restore workspace sessions before sending the prompt.

### 2. Path-scoped Rules, `@import`, and Custom Commands (`packages/workspace`, `apps/cli/src/bootstrap/startup.ts`)
- `ProjectContextLoader` resolves relative `@path/to/file.ext` imports outside code fences/spans through the authorized `ProjectInstructionReader` (depth cap `5`, max `16` imports/file, cycle-safe via canonical path `seen`, within the existing `32 KiB` total budget).
- `.cosmew/rules/**/*.md` and `.claude/rules/**/*.md` (regular files only, no symlinks outside workspace) are discovered deterministically. Rules without `paths:` load at root scope; rules with `paths:` load dynamically when matching files are read or edited using a polynomial-bounded glob matcher (`matchRuleGlob`, zero ReDoS).
- `SkillCatalog` discovers `.cosmew/commands/**/*.md`, `.agents/commands/**/*.md`, and `.claude/commands/**/*.md` (project and user), supports optional frontmatter, namespaces nested directories with `:` (e.g. `git/pr-check.md` → `/git:pr-check`), and expands `$ARGUMENTS` plus positional `$1..$9`.

### 3. Guarded Auto-Memory Extraction (`packages/core/src/context/memory-extraction.ts`, `apps/cli/src/bootstrap/startup.ts`)
- Enabled strictly when user-level `~/.cosmew/config.toml` sets `[memories] auto_extract = true` (default `false`; repositories cannot enable it) and `memories.enabled !== false`.
- Runs best-effort after completed `chat` turns (never in `plan`/`review` modes, `permissionMode === 'plan'`, or subagents) via one tool-free, 15s-bounded `model.generate` call returning up to 3 `memoryWriteSchema`-validated entries.
- **Hard security guards**: rejects any candidate matching secret/credential patterns (`looksLikeSensitiveMemory`) or mutated by the redactor, never overwrites existing memories with the same name, and attributes token usage to the session (ADR 0098).

### 4. Extended LSP Presets & User-Level `[lsp.<id>]` (`packages/code-intel/src/servers.ts`, `apps/cli/src/bootstrap/host-config.ts`)
- Adds 9 built-in presets (`cpp`, `java`, `csharp`, `php`, `ruby`, `swift`, `kotlin`, `yaml`, `json`) alongside `typescript`, `python`, `go`, `rust` (13 total).
- Parses `[lsp.<id>]` exclusively from `~/.cosmew/config.toml` (user-level only; never read from repositories). Every executable must resolve outside the workspace (`trustedServerProgram`) and still runs inside the read-only, no-network `serviceSandbox` (ADR 0043).

## Security Invariants Preserved
- Repository instructions, `@import` targets, `.cosmew/rules`, and `.cosmew/commands` remain untrusted user/project context, read through `ProjectInstructionReader` / `canRead`, and never grant permissions or execute code.
- Auto-memory extraction never bypasses `plan` mode, never writes secrets, and never overwrites user-authored memories.
- Custom LSP servers never come from repositories, never resolve binaries inside the workspace, and never run outside the OS sandbox.
