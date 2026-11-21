# Subagent conversation navigation

Implemented 2026-11-22. TUI-only presentation change; no execution authority,
provider loop, persisted state, package dependency, or public contract is added.

Selecting a task in the main footer opens that task directly. Agent tasks open a
full-screen conversation through the main `TranscriptItem`, `ScrollViewport`,
virtual viewport, and `ActivityNavigation` components. Esc returns directly to
the parent chat for footer entry; entry through `/tasks` returns to the task
list. The breadcrumb names that destination. The parent session is never selected
away, and its mounted composer/transcript continue to own draft, scroll and work.
Stopping remains an explicit stop action through the existing SDK path.

Left/Right switch agent tasks belonging to the current parent's task projection,
including foreground children and completed agents. Shell tasks remain in the
task list. Switching keeps each agent's scroll position, follow mode, global
detail toggle, focused activity and individual activity expansion while the panel
is open. The cache is reset on parent session change and panel close, holds at
most 32 agents and at most 512 expanded activity IDs per agent.

Tool rows use the same scoped mouse targets as the main transcript. Alt+Up/Down
focus an activity; Alt+Enter toggles that activity. Ctrl+O toggles the complete
detailed view. Tool grouping, reasoning expansion, truncation and further output
expansion follow the existing main renderer. All keys resolve through the central
keymap and honor remapping. Activity snapshots remain explicitly labelled when
stored child messages are unavailable.

## Evidence and limits

`apps/tui/src/ink/testing/agent-conversation.test.tsx` drives the real Ink shell
and SDK fixture: single-action footer entry, 40/80-column layout, full recorded
tool input/output, more than 8 KB of history, paused follow, parent-session reset,
sibling switching, individual keyboard expansion, and restored expansion/scroll.
It verifies navigation creates no provider turn or stop call and preserves the
active parent. The existing background task tests cover running-parent continuity,
explicit stop routing, shell paging, failure and late completion after a session
switch. These fixtures do not prove a live provider, OS terminal or mouse driver.
Mouse hit testing and terminal parsing retain their existing shared tests.

Per-agent presentation retention lasts for the open panel; reopening starts at
the current tail. Navigation does not itself send agent messages. Live streamed
text/history completeness depends on the SDK child snapshot and persistence
work documented separately.
