# ADR 0017: Read-only workspace tools and permission engine (TOOLS1)

**Status: Accepted 2026-11-15 by the user; implementation in progress.** `AGENTS.md` now authorizes this slice (TOOLS1) and nothing beyond it. Design inputs: the Phase 0 [tools and permissions contract](../contracts/tools-and-permissions.md), the [tools and workspace subsystem spec](../subsystems/tools-and-workspace.md) and the [upstream comparison](../delivery/tools-permissions-research.md).

## Goal

The model can read and search the trusted workspace. It cannot write, run commands or reach the network. Every read goes through one enforcement point. This slice is the foundation later write/edit and shell slices must build on, not a shortcut around them.

## Scope

| Package | Responsibility in TOOLS1 |
|---|---|
| `contracts` | Minimal subset of the Phase 0 records: `ToolDescriptor`, `ToolInvocation`, `PermissionDecision`, `ToolResult`, plus tool-call and tool-result message parts. Versioned contract change with migration notes. |
| `workspace` | Canonical path resolution: realpath, symlink-aware containment check against the workspace root, recheck at open, `.gitignore` handling. |
| `security` | Policy evaluation (deny → ask → allow), built-in default rules, approval ledger, output redaction. Owns every decision. |
| `tools` | Registry, dispatcher (the single enforcement point) and three builtin executors. Executors never receive a path that has not been through `workspace` and `security`. |
| `persistence` | Durable approval and audit records; intent persisted before an approval prompt is shown. |
| `core` | Bounded agent loop: model → tool calls → dispatcher → tool results → model, through injected ports only. |
| `apps/cli`, `apps/tui` | Composition; wire the existing permission dialog; tool cards in the transcript; `/permissions` lists and revokes session grants. |

## Tools

| Tool | Input | Behavior and limits |
|---|---|---|
| `read` | `path`, `offset?`, `limit?` | UTF-8 text only, binary refused. At most 2,000 lines or 50 KiB per call; lines over 2,000 characters are truncated. Line-numbered output with a continuation hint. |
| `glob` | `pattern?` (glob), `path?` | Up to 100 paths, sorted. Skips `.git` and `.gitignore`d entries unless the path is named explicitly. 30 s deadline. |
| `grep` | `pattern` (regex), `path?`, `glob?` | Up to 100 matching lines with path and line number. Pattern length capped; files over 1 MiB and binary files skipped; 30 s deadline and per-file time budget against pathological regexes. No ripgrep dependency in this slice. |

`@file` mentions in the composer attach content through the same dispatcher, with the user as principal. No second read path exists.

## Permission model

- Capability `fs.read`. The target is the **canonical real path** after symlink resolution, never the raw string.
- Evaluation order **deny → ask → allow**. The first category with a match decides, and an allow rule never overrides a deny (Claude Code / Copilot semantics, not last-match-wins).
- Built-in defaults:
  - **deny**: anything outside the workspace root, including via symlink or `..`; the Hannes state directory (`~/.hannes`); `.git/` internals.
  - **ask**: `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, and files matching credential patterns the redactor knows.
  - **allow**: other files inside the approved workspace.
- Approval choices: **once / session / deny**, using the existing `PermissionPromptRequest` contract. `scopeHash` binds tool, canonical target, input hash and policy revision. Esc or dismiss always denies. A change in target or policy needs a new decision.
- Session grants live for the session only. Durable "always" rules and user-editable rule files are out of scope.
- Tool output passes through the existing redactor before it reaches the model, transcript or storage.

## Agent loop

`Conversation` currently rejects `toolCallComplete` with `UNSUPPORTED`. TOOLS1 replaces that with a bounded loop:

- At most 8 tool rounds per user turn and 32 calls per round.
- Duplicate call IDs or schema-invalid arguments are protocol errors.
- Cancellation stops the loop between and during calls.
- Tool calls and results are persisted as message parts so sessions resume correctly.

Tools are offered only to direct API providers whose model advertises tool support. Subscription runtimes keep rejecting every tool request ([ADR 0008](0008-subscription-runtime-auth.md)). The startup consent text changes to disclose that approved file contents are sent to the model provider.

## Acceptance tests (minimum)

- Path traversal (`..`), absolute paths and symlinks escaping the root.
- Symlink swapped between check and open.
- `.env` asks; deny beats a session grant; Esc never grants.
- Revoking a grant between approval and execution.
- Cancellation mid-loop; the 8-round cap.
- Read, list and search limits; binary and huge files; a pathological regex stays bounded.
- A provider without tool support; a subscription runtime rejecting tools.
- Duplicate or invalid calls.
- Persisted session resume with tool parts.
- Golden frames for the tool card and the permission dialog.

## Out of scope

Write, edit, patch, shell, network, MCP, plugins, subagents, external directories, persistent "always" rules, user-editable rule files and OS sandboxing. Each needs its own ADR. Shell additionally needs the sandbox decision recorded in the research note.

## Decisions (user, 2026-11-15)

1. Reads outside the workspace are **denied**, not prompted.
2. **Built-in default rules only** in this slice; no user-editable rule file.
3. Tool names are **`read` / `glob` / `grep`**, matching OpenCode and Claude Code conventions.
