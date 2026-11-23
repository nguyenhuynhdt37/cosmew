# ADR 0017: Read-only workspace tools and permission engine (TOOLS1)

**Status: Accepted 2026-11-15 by the user; implemented and fixture-tested (live provider tool use: Needs verification).** `AGENTS.md` authorizes this slice (TOOLS1) and nothing beyond it. Design inputs: the Phase 0 [tools and permissions contract](../contracts/tools-and-permissions.md), the [tools and workspace subsystem spec](../subsystems/tools-and-workspace.md) and the [upstream comparison](../delivery/tools-permissions-research.md).

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

`@file` autocomplete inserts a path reference. The model must call read through the dispatcher to obtain contents; it is not an eager attachment. No second read path exists.

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

- At most 8 tool rounds per user turn and 32 calls per round (superseded by ADR 0020, see the amendment below).
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

4. Tools are offered to models whose tool capability is `supported` **or `unknown`**. When the provider rejects the tool definitions (HTTP 400 before any output in the first round), the model is marked `unsupported` in the catalog, the user is told, and later turns chat without tools. Nothing is re-sent automatically. Rediscovering the catalog resets the mark.
5. A tool waiting for approval during a running turn **opens the permission dialog automatically**.

## Implementation notes

- **Packages.** `@futryn/workspace` (`WorkspaceRoot`, `listWorkspaceFiles`), `@futryn/tools` (`ToolDispatcher` and the `read`/`glob`/`grep` builtins), `@futryn/security` (`evaluateRead`, `SessionGrants`), `@futryn/persistence` (`ToolAuditStore`, schema **v3**: `messages.parts` JSON and the `tool_audit` table). Builds older than v3 refuse a v3 database (fail closed).
- **Contracts (additive).** `Message` gains role `tool` with `toolCallId`/`toolName`, and assistant `toolCalls`. Plain text messages are unchanged. `ModelEvent` gains `toolResult`. `ConversationStore.complete` takes the turn's tool rounds, so they commit atomically with the final answer. `ToolPort` and `ToolResult` are in `contracts/tools.ts`.
- **Who gets tools.** Only clients that called `setToolsEnabled(true)`. The TUI does that when the user approves the folder; non-TTY runs, `hannes run` and the line chat have no consent step and offer no tools. Subscription runtimes never get tools.
- **Approvals.** `FutrynClient.requestPermission` resolves to `deny` on dismiss, on expiry (5 min) and on abort. Clearing session authorization (account switch, new session) also clears tool grants and wakes any waiting call with `deny`. `/permissions` lists session grants; `Ctrl+X` revokes them all.
- **Grep.** Runs in a Worker with a hard deadline, because JavaScript cannot interrupt a running RegExp. JavaScriptCore caps one backtracking match at about 0.5 s, but many such lines add up. JS regex syntax, not ripgrep.
- **Known limits.** The symlink-swap check is realpath plus inode comparison after open, not handle-based path resolution. A swap of an intermediate directory between the check and `open` within the same inode window is not fully excluded (Needs verification on each OS). The output redactor only knows registered secrets and common token shapes.

## Evidence

`tests/security/read-tools.test.ts` covers traversal, absolute paths, file and directory symlinks, secret files (ask / once / session / deny), policy order, audit order, glob/grep secret skipping, invalid input, binary files, directories, paging and the catastrophic-regex deadline. `tests/end-to-end/read-tools.test.ts` drives the real app against a fixture provider: no tools before consent; read → result → answer; stored tool parts on resume; `.env` dialog with Esc deny (secret never sent); session grant and revoke; outside-workspace denial; provider rejection marking the model `unsupported`. The full suite passed with 227 tests at the time of writing.

Supersession 2026-11-15: [ADR 0018](0018-codex-read-tool-bridge.md), explicitly authorized by the user, adds Hannes-owned read/glob/grep for ChatGPT/Codex only. Other subscription runtimes retain chat-only restrictions. `@file` autocomplete currently inserts a path reference; it is not an eager file attachment. The model must call read to obtain contents through the dispatcher. Earlier wording about unconditional content attachment was a design requirement, not implementation evidence.

Permission UI follow-up (2026-11-15): `/permissions` is a compact modal manager with an actual workspace-read availability indicator, remembered target grants and Ctrl+X revocation. Empty/resolved history shows no grant actions. Only pending requests are selectable; selection is bound to approval ID across queue insertions, and each newly selected request defaults to Deny. Long targets/reasons can be scrolled while decision controls remain visible. Esc or leaving a pending dialog denies that selected request. This changes presentation and safe defaults only; execution, scope hashing, policy order and permission boundaries are unchanged.

## Amendment 2026-11-15 (ADR 0020)

The budget "8 tool rounds per user turn and 32 calls per round" is replaced by 16 tool rounds and 32 executed calls per user turn on both the round-based and the Codex inline path; over-budget calls receive a paired `TOOL_BUDGET` result. See [ADR 0020](0020-progressive-code-exploration.md).

## Correction — 2026-11-22

[ADR 0105](0105-preserve-tools-on-request-validation-errors.md) supersedes the first-round HTTP-400 inference above. Generic request errors no longer mark the model unsupported or force later turns into text-only mode. Explicit catalog capability metadata is still honored.
