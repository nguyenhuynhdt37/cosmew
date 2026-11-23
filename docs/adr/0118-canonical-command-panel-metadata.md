# ADR 0118 — Canonical metadata for implemented command panels

Accepted 2026-11-23. Shared contract 1.63; no dependency or database change.

The command registry described `/mcp` as unavailable even though the TUI's host-only override opened the implemented MCP manager. `/rewind` and its aliases also depended on that override while advertising an unavailable handler. SDK consumers and autocomplete could therefore disagree with actual user-visible functionality. `/switch` still described creating a new session although the current host can keep the same session selection/history.

Expose `mcp` and `rewind` as canonical `CommandOverlay` values with the existing `overlay` handler. Remove the duplicate host-panel routes for these commands; keep the informational hooks panel separate because hooks execution remains unsupported. Both panels retain the existing idle-only guard. `/mcp` arguments explain the supported interactive panel and `cosmew mcp --help` path instead of silently opening a panel or claiming the manager is missing. Rewind aliases keep their canonical route. No new management action, tool execution, permission grant or server discovery is triggered by registry parsing/help.

The public SDK overlay union and metadata change are versioned to 1.63 with exact-version consumers updated. Existing MCP manager, rewind, approval and session implementations are reused. `/switch` description refers to continuing the conversation without promising a same-session ID for hosts that still use the fallback fork port.

Tests cover public SDK parsing/discovery of all panel aliases and UI routing, unsupported arguments and active-turn restrictions. Historical roadmap/capability documentation now labels its original Phase 0 snapshot and links to the current implemented inventory; unverified OS/provider/distribution work remains explicit.
