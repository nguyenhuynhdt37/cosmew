# MCP servers

`/mcp` uses the injected SDK manager and opens a Claude-style list: server count,
user-server group, status glyphs and tool counts. Arrow keys navigate; Enter opens
a server; Esc goes back one level or closes the list. Connection, authentication,
enablement and installation remain separate host states, presented as readable labels.

Server details put View tools, Connect/Reconnect and Enable/Disable first.
Authentication is suggested when required. Advanced settings contains credentials,
configuration replacement, diagnostics and removal. Credentials stay masked and
never enter confirmations/transcript messages. Finished operations refresh from the
returned authoritative snapshot; adding opens the saved server when available.

Add server → Remote server asks for the URL first, then suggests an unused local
name. Both fields stay visible with examples. Enter validates and advances;
Tab/Shift+Tab revisits fields. Invalid input and duplicate names stay editable.
Every field is revalidated before the default-Cancel confirmation. Local executable
setup retains exact JSON argument boundaries. Edit is a full replacement: old
headers/environment/managed ownership may be cleared, and the confirmation says so.

Registry and recommendations are explicit list actions (legacy c/d/r and Tab
shortcuts remain supported). Browsing retrieves metadata only. Installation requires
a concrete pinned recipe, a local name and confirmation. Registry publication is
separate from compatibility testing. Next page reuses the current query/cursor.

Esc aborts an active operation and keeps the dialog busy until cleanup settles.
It never replays a mutation. Unexpected transport errors use a generic message
instead of raw secret-bearing exception data. Unsupported SDK backends retain the
read-only fallback. Repository MCP files are not launched; tool permissions apply.

Reference: captured Claude Code 2.1.328 `docs/delivery/tui-v4/reference/idle-100x30/20-cmd-mcp.txt`
(2026-11-19). Exact Claude detail/add-form parity: Needs verification; these are
Cosmew interaction choices. See ADR 0104.

`manager.test.tsx` exercises keyboard input with injected SDK ports; it does not
certify real-service OAuth, OS keyring or package installation compatibility.

## Visual overview and quick actions

The overview counts connected, sign-in-required, failed, disabled and pending servers.
Rows/details use theme semantic colors and readable glyphs, including NO_COLOR.
`/` filters configured servers by name/URL/source or discovered tools by name/description.
Enter finishes typing; Esc clears the filter before leaving the view. `a` opens add,
`d` registry, `r` recommendations, and `f` refreshes the host snapshot only. Refresh
does not reconnect, launch an executable, install packages or refresh OAuth credentials.
Connection diagnostics explicitly reconnects and discovers tools. All configuration
issues are browsable. Managed packages do not advertise unsupported executable edits.
Transient snapshot failures show a retry message rather than an unsupported-backend fallback.
