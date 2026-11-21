# ADR 0075: Persistent workspace consent and Claude keybinding compatibility

Date: 2026-11-21. Status: Accepted. No dependency or public event version change.

Interactive folder consent is remembered per canonical workspace in the user settings database. The
first interactive launch still defaults to refusal and asks the user to trust the folder. After an
explicit approval, later TUI launches for that workspace skip only the folder prompt; account/model
verification and every individual tool permission continue to run normally. Exiting the TUI, changing
permission mode, or revoking tool grants does not erase the user's folder trust. A new canonical
workspace requires a new approval.

The setting is additive and optional so older settings remain valid. It is user state, never read from
the repository, and does not grant a tool, shell, network, or write permission by itself.

Futryn keeps `~/.futryn/keybindings.json` as its default user file and accepts an existing
`~/.claude/keybindings.json` as a compatibility source when the Futryn file is absent. Both use the
same context/action schema, reserved-key rules, hot reload, and validation. Repository keybinding files
are never read.
