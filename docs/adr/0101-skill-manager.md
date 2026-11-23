# ADR 0101 — Skill manager

Accepted 2026-11-22. Shared contract 1.53, SQLite schema 13.

- `/init` continues to inspect the repository with the agent loop. The target is now `AGENTS.md` at the project root. The agent proposes changes if that file exists. The project instruction loader continues to recognize existing `CLAUDE.md` files for compatibility.
- `/skills` and `/skill` open the skill manager. Entries are grouped by discovery source: Project, Personal and Built-in. Filter by name, description or source. Press Enter or Space to cycle `on`, `name-only`, `user-only` and `off`. Press `t` with an empty filter to switch between name and estimated catalog-description token order within each source. The menu shows which entries are locked by `disable-model-invocation` frontmatter.
- Esc saves the user’s workspace-scoped changes to the existing local state database. Only changed entries are written and the default `on` removes the override. Repository settings files have no control over these preferences.
- `name-only` publishes the name alone in model context. `user-only` permits explicit slash and dollar invocation. `off` removes the skill from completion and blocks invocation. Model load and explicit user load both go through the same dispatcher checks. Consecutive leading skill commands can load up to six skills with the same trailing arguments.

The manager follows documented Claude Code keyboard behavior and visibility semantics. Local group names reflect Cosmew’s current discovery sources. Plugin and managed policy entries are unavailable in this manager.

Upstream checked 2026-11-22. Installed Claude Code revision 2.1.330. Live rendering and group order in that revision need verification. [Commands](https://code.claude.com/docs/en/commands) · [Skills](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)
