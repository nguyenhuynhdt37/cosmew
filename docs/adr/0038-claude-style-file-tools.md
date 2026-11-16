# ADR 0038 — Claude Code–style file tools: edit, write, ripgrep grep

Date: 2026-11-17. Status: accepted (user request: "max" reading/writing/understanding of projects, like Claude Code).

## Context

Futryn offered `read`, `glob`, a JavaScript-regex `grep` (Worker, 100 lines, no context) and `apply_patch` (Codex patch text). Models trained on Claude Code–style tools make focused changes more reliably with exact-string `edit` and whole-file `write`, and search large repositories faster and with fewer tokens through ripgrep with modes, context and paging. Reference behavior: Claude Code `Edit`/`Write`/`Grep`/`Glob` tool semantics (public tool descriptions; no source copied).

## Decision

**edit** `{path, old_string, new_string, replace_all?}` and **write** `{path, content}` compile to a one-file patch plan (`ApplyPatchRuntime.verifyFile`). They therefore inherit every apply_patch guarantee: `writePath` syntax, `evaluateWrite` (secrets, `.git`, Futryn state, `.futryn`/`.hannes` denied), `SecureFiles` snapshots, an approval that shows the full diff, revalidation of the snapshot after approval (a file changed during the prompt is not overwritten), and the same receipt (`FILE_CHANGE_TOOLS` in contracts lets core, TUI and the bridge treat the three alike). No second write path exists.

- `edit` matches exactly and uniquely unless `replace_all`; replacement is literal string slicing (`$` sequences stay literal). For a CRLF file, an LF `old_string` is translated so line endings are preserved.
- **Read before change** (`ReadLedger`): an existing file may be edited or overwritten only when its current content hash equals a version the model read (or wrote) through this dispatcher. Unread → `READ_REQUIRED`; changed since → `FILE_CHANGED_SINCE_READ`; both refused before any approval prompt. Creating a new file with `write` needs no read.
- Plan/Review modes offer only `fs.read` tools, so edit/write are excluded there automatically.

**grep** uses ripgrep when a trusted `rg` exists, else the existing Worker. New inputs: `output_mode` (`content` | `files_with_matches` | `count`), `context`/`before`/`after` (≤ 20), `type`, `multiline`, `head_limit` (≤ 2000, default 100) and `offset`. Content lines are `path:line:text`, context lines `path-line-text`, groups separated by `--`.

- Trust: only an absolute `rg` outside the workspace is used (a repository cannot plant `rg` via a project-local PATH entry); `ToolDispatcherOptions.ripgrep` may pin a path or `null` to force the built-in search.
- rg runs with `--no-config`, an empty environment, no symlink following, `--max-filesize 1M`, a deadline, cancellation and a 16 MiB output cap. It only proposes paths: each is re-resolved inside the workspace and judged by `evaluateRead`; secret files are counted and skipped, Git/state files and symlink escapes dropped.
- The user glob is applied by Futryn, not passed to rg, because an rg `--glob` include overrides `.gitignore`.
- Regex syntax is Rust (rg); the built-in fallback uses JavaScript and reports that `type` and context lines need ripgrep.

**glob** returns the most recently modified files first.

**Workspace listing hardening**: `git ls-files` (used by glob, the built-in grep and file mentions) ran the repository's `core.fsmonitor` program — verified by test — so opening a hostile repository and listing files could execute code outside the sandbox. Listing now uses the /diff collector policy: `core.fsmonitor=false`, hooks to `/dev/null`, `safe.bareRepository=explicit`, inherited `GIT_*` variables removed.

## Not included

LSP, Tree-sitter, ast-grep and MCP/Serena remain unimplemented (see `docs/subsystems/code-intelligence.md`); language servers execute project code and need their own sandbox decision. No new package dependency: `rg` is an optional system binary.

## Evidence

`tests/security/file-edit.test.ts`, `tests/security/grep-ripgrep.test.ts` (each scenario on both backends), `tests/security/workspace-listing.test.ts` (fsmonitor test fails on the previous code), `tests/end-to-end/file-edit.test.ts` (agent loop + TUI approval).
