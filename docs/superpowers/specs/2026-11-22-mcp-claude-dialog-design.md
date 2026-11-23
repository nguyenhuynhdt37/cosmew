# MCP dialog — Claude-style interaction

The maintainer requests `/mcp` to work like Claude CLI because the current tabbed manager and name-first form are confusing. Proceed autonomously under the existing instruction; preserve all host permission/auth/install behavior.

Reference: `docs/delivery/tui-v4/reference/idle-100x30/20-cmd-mcp.txt`, captured Claude Code 2.1.328 (2026-11-19). It shows “MCP servers”, count, grouped server rows, status glyphs/tool counts, and arrow/Enter/Esc navigation. Details/add forms below are Cosmew design choices; exact Claude parity beyond the captured list is **Needs verification**.

Use the existing SDK and Ink components. Open directly to the user server list, without a three-tab header. Present connection glyph + name + human-readable status/tool count. Keep registry and recommendations accessible as explicit list actions. Select a server to see its endpoint and status, with tools/reconnect/enablement first; group credentials/config/removal under advanced settings. Only show an authentication recommendation when authentication is needed.

Remote add asks for URL first, suggests a unique 1–32-character local name, and explains what the name means. Validate per field, keep drafts on errors, show entered fields together, support Tab/Shift+Tab to revisit fields, and keep explicit target confirmation with Cancel selected. Secrets remain masked and never appear in confirmations. Esc respects subview nesting and cancellation drains before accepting more work.

No new dependencies or wire contracts. Test actual key input, default Cancel, invalid/duplicate fields, narrow views, status rendering, advanced actions, and cancellation. Preserve the backend compatibility fallback. Fix the independently reproduced bounded JSON Schema 2020-12 validation incompatibility and rerun the real OpenAI Docs call through ToolDispatcher.
