# ADR 0099 — Project and session slash commands

Date: 2026-11-22. Status: superseded by [ADR 0100](0100-claude-project-and-session-commands.md). Contract 1.51 and SQLite schema 13.

`/init` creates a starter `AGENTS.md` in the workspace. It is a deterministic scaffold. `/export [filename]` saves the visible transcript as Markdown. Both submit a guarded create-only patch through the existing tool dispatcher. Repository policy, approval, redaction and stale-file protection apply. Export accepts a simple filename at the workspace root and generates a timestamped filename by default. It excludes hidden reasoning and tool result bodies.

`/editor [text]` opens the configured editor with an optional starter draft in a private temporary file. `Ctrl+G` edits the text already in the composer. `/copy` sends the latest completed assistant reply to the native or terminal clipboard. Terminal clipboard delivery depends on OSC 52 support when native copying is unavailable.

`/rename [name]` stores a sanitized title on the session record. Without an argument it derives the title from the first user message. Schema 13 adds a nullable title column, so existing sessions keep their derived titles. Headless event payload shapes stay compatible.

`/undo` forks from the latest conversation checkpoint if it is restorable and makes its prompt available in the composer. `/redo` returns to the original session if its revision and the checkpoint branch revision still match. Redo is available in the current client. `/rewind` handles workspace file restoration with the existing approval and poststate checks.

Upstream references checked 2026-11-22. [Claude Code commands](https://code.claude.com/docs/en/commands) · [Codex commands](https://learn.chatgpt.com/docs/developer-commands#built-in-slash-commands) · [OpenCode TUI](https://opencode.ai/docs/cli/tui/) · [OpenCode v1 initialization, revision c72f8b1](https://github.com/anomalyco/opencode/blob/c72f8b17c67f21e62cdb2502ad3b55c2c01db4bf/packages/web/src/content/docs/index.mdx#initialize)
