# ADR 0100 — Claude Code project and session commands

Accepted 2026-11-22. Supersedes ADR 0099 behavior. [ADR 0101](0101-skill-manager.md) restores AGENTS.md as the initialization target. Shared contract 1.52, SQLite schema 13.

- `/init` runs a normal Cosmew agent turn to explore the workspace and write a project-specific `CLAUDE.md` with verified commands and architecture. The turn asks the model to suggest improvements when the file exists. File actions pass through the same tool dispatcher and approvals as other turns. The instruction loader reads `CLAUDE.md` alongside the existing AGENTS instructions under the same scope, permissions and context budget.
- `/copy [N]` selects the Nth most recent completed response and offers the full reply, fenced code blocks and blockquotes. The picker accepts Enter for clipboard and `w` to save the selection. `/export [filename]` produces a plain-text transcript and offers clipboard or file when called without arguments. File output uses the create-only dispatcher path with relative workspace destinations. Naming a file that exists fails safely.
- `/rename [name]` uses explicit text or asks the session's model to derive a title from bounded recent conversation text. The title request has no tools and accounts for model usage separately. The title appears by the composer and persists for resume.
- `/undo` and `/checkpoint` invoke `/rewind`. The picker offers conversation, code, both, or summary where available. The external prompt editor is bound to Ctrl+G and Ctrl+X Ctrl+E. The SDK removes the separate editor, undo, and redo slash handlers and the conversation-only undo/redo methods.

Parity scope covers the default Claude Code command flows. Claude's optional interactive initialization and configuration import are outside this change. Export uses Cosmew's guarded workspace writes. Interactive behavior was derived from the documented CLI and tested with local fixtures. Live Claude Code parity beyond the documented behaviors needs verification.

Upstream inspected 2026-11-22. Installed Claude Code version 2.1.330. [Command reference](https://code.claude.com/docs/en/commands) · [Project memory and initialization](https://code.claude.com/docs/en/memory) · [Interactive keyboard bindings](https://code.claude.com/docs/en/interactive-mode)
