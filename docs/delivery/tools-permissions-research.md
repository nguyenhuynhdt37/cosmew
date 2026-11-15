# Upstream tool and permission comparison

Access date: 2026-11-15. Sources are the vendors' **public documentation pages**. They have no revision pins, so they record the documented design on that date. No upstream source code was read for this note, and nothing here is a live Hannes compatibility test. Claude Code's public repository is proprietary (see [provider-auth-research](provider-auth-research.md)), so it is used only as documented behavior, never as code to reuse.

## Findings

| Upstream | Source | Tools | Permission model | Notable limits and defaults |
|---|---|---|---|---|
| OpenCode | [opencode.ai/docs/permissions](https://opencode.ai/docs/permissions/), [opencode.ai/docs/tools](https://opencode.ai/docs/tools/) | `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `question`, `subagent`, … | Rules `{ action, resource, effect }` with effect `allow` / `ask` / `deny`; unmatched → `ask`. **Last matching rule wins**. When one operation checks several resources, any `deny` blocks it, otherwise any `ask` prompts. `external_directory` guards paths outside the project. Optional `policies` can only harden to `deny`. | Base policy allows almost everything but asks before reading `*.env`/`*.env.*`. `read` 2,000 lines / 50 KiB per page, long lines cut at 2,000 chars, binary fails. `glob`/`grep` 100 results, 30 s timeout. `shell` 2 min default timeout. Approvals: allow once / allow always (saved as project rules, never overriding `deny`) / reject. |
| Claude Code | [code.claude.com/docs/en/permissions](https://code.claude.com/docs/en/permissions), [code.claude.com/docs/en/tools-reference](https://code.claude.com/docs/en/tools-reference) | `Read`, `Glob`, `Grep` (no approval), `Edit`, `Write`, `Bash`, `WebFetch`, `NotebookEdit` (approval) | Rules like `Bash(npm run *)`, `Read(./.env)`, `Edit(src/**)` in allow / ask / deny lists. **Evaluated deny → ask → allow**: deny always wins and an allow cannot carve an exception out of a deny. Modes: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Protected paths `.git`, `.claude`. | Read-only tools need no approval inside the working and additional directories. Grep is ripgrep-based and skips `.gitignore`d files; Glob does not skip them by default. Bash parsing splits compound commands and strips wrappers such as `timeout`/`nice` before matching. |
| Codex (OpenAI) | [learn.chatgpt.com/docs/sandboxing](https://learn.chatgpt.com/docs/sandboxing), [developers.openai.com/codex/concepts/sandboxing](https://developers.openai.com/codex/concepts/sandboxing) | Shell and edits run inside an OS sandbox | Two axes: `sandbox_mode` = `read-only` / `workspace-write` / `danger-full-access`, and `approval_policy` = `on-request` / `never` (`untrusted` retired). The recommended local setup is `workspace-write` + `on-request`: it asks before network use or leaving the workspace. | OS enforcement: Seatbelt (macOS), `bubblewrap` (Linux), Windows sandbox / WSL2. Protected paths and the edit mechanism were not found in the pages read (Needs verification). |
| GitHub Copilot CLI | [docs.github.com … use-copilot-cli](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli), [docs.github.com … allowing-tools](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools) | shell, write, MCP tools | Folder trust on first start: this session / remember / exit. Per-tool approval once or for the session. `--allow-tool='shell(git:*)' --deny-tool='shell(git push)'`; **deny wins** even with `--allow-all`. Flags are session-only. | `/sandbox enable`, `--cloud`, `/yolo`. The flag syntax comes from a search summary of the allowing-tools page, which was not opened directly (Needs verification). |

## Common ground relevant to a read-only first slice

1. Folder trust happens before tools run. Hannes already has session-scoped consent ([ADR 0014](../adr/0014-interactive-startup-verification.md)).
2. Reads inside the trusted workspace run without prompts; leaving the workspace needs approval.
3. Deny always wins. Claude Code's fixed order (deny → ask → allow) is easier to reason about than last-match-wins.
4. Secret-looking files (`.env*`) need an explicit decision even when reads are otherwise allowed.
5. Results are bounded: about 2,000 lines / 50 KiB per read, 100 matches, 30 s timeouts.
6. Search skips `.gitignore`d files unless a path is named explicitly.
7. Approval choices are once / session / deny. Durable "always" rules are a separate, explicit act.
8. OS sandboxing (Codex) matters for process execution, not for in-process reads. It is deferred to the shell phase.

## Limits of this evidence

Documentation pages only, read on one date. Defaults change between releases. No behavior was reproduced locally, and no third-party code or text was copied. Field names quoted above may drift; check them again before any compatibility claim.
