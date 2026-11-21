# ADR 0091 — Vim prompt editor and user preference

- Status: Accepted
- Date: 2026-11-22
- Amends: [ADR 0075](0075-persistent-workspace-consent-and-claude-keybindings.md), [ADR 0080](0080-user-settings-appearance.md)

The prompt composer offers `normal` (the existing editing keys) and `vim`.
The editor starts in Insert when Vim is enabled. `/config` changes the setting
through the CLI's user settings store and the mounted composer observes it.
The user file stores a top-level `editorMode` value. Missing or unknown values
resolve to `normal`. Embeddings without the optional store keep a session value.

The central key router owns the Vim context. The composer owns draft and undo
snapshots, including collapsed paste metadata. A pure state machine interprets
Vim counts, operators, text objects, selection and repeat. The unnamed register
is local to the editor. Search, help, history, submit and entry into external
editing use existing composer paths. Scope and upstream evidence are recorded
in [Vim parity](../delivery/tui-v4/vim-mode-parity.md).

The additive SDK contract is version 1.44. Existing ports remain valid and the
headless envelope retains its fields. SQLite, provider payloads and permission
policy are unchanged.
