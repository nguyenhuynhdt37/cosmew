# ADR 0088 — Background task display and live output

Date: 2026-11-21. Status: accepted. Shared contract 1.42; SQLite remains 10.

## Decision

Expose `/tasks` (alias `/bashes`) in the canonical SDK command registry, help and
autocomplete. Its `background-tasks` overlay is available during a running turn
and before model selection; opening it never submits provider work. The existing
footer Down/Enter entry and Ctrl+B foreground-to-background transfer remain.
Line-mode chat recognizes the command and directs the user to the interactive
Cosmew panel rather than sending a prompt or reporting invalid arguments.

Reuse the existing session-scoped `backgroundTasks`, task observer and
`stopBackgroundTask` APIs from ADR 0070. List running and retained finished shell
and agent tasks. Enter opens output, Esc/Enter returns to the list, and the
remappable stop action only calls the SDK for a running task. Completed tasks
remain inspectable. Backend refusal never becomes a successful stop message.

The task-specific output viewer starts at the latest 8,192 characters, strips
terminal controls, wraps to terminal cells before paging, and follows updates.
Scrolling away pauses follow; reaching the end or using the End action resumes
it. Keyboard actions use the central remappable Select/Scroll contexts; mouse
wheel uses the existing scoped mouse bridge. Terminal resize clamps the viewport.
Changing sessions remounts local selection/output/stop UI state, so old output
and late action messages cannot attach to the new session.

No executor, polling subprocess, dependency, restored process, permission grant,
or provider agent runtime is introduced. SDK owns redaction and task ownership;
the terminal viewer also sanitizes control sequences at the rendering boundary.
The command overlay union is additive and consumers use contract 1.42. Model wire
formats and background task snapshots/events are unchanged.

## Follow-up: discover tasks while chatting

The initial implementation counted only background children in the footer while
Down selection also accepted foreground children. Its panel could therefore be
empty for a selectable running child, and the main transcript appended a separate
agent tree. A user screenshot on 2026-11-21 showed two foreground `Task` calls,
no task footer, and duplicate stopped-agent cards.

Use one TUI-only projection of SDK background snapshots and current-session
subagent snapshots for the task area, footer selection/count and panel. Display
running task descriptions below the input, bounded to three rows (one on short
terminals), with a keymap-derived manage hint. Down selects from empty input even
when messages are queued; Enter/Down opens inspection. Remove the separate agent
tree from the host transcript; ordinary tool records and completion notices stay.
Foreground agents retain their execution semantics and use `stopSubagent`;
background jobs retain `stopBackgroundTask`. No new public contract or permission
is introduced. The task panel updates foreground output on reactive agent events.

Regression tests reproduce the original missing footer, then exercise actual
Down/Enter navigation while the main response is pending, private child output
only after inspection, live output updates, Esc without stopping work, explicit
stop through the agent port and queued-message preservation.

## Sources and evidence

### Full-screen child conversation follow-up

The user requested inspecting a child like the main chat instead of the plain
task-output tail. Agent inspection now takes over the full live screen and uses
the existing main `TranscriptItem`, Markdown/tool presentation, scrollback and
virtual history viewport. Ctrl+O toggles detailed tools; keyboard/wheel scroll,
Home/End and follow behavior reuse existing keymap and scrolling primitives.
Esc returns to the task list and then the parent chat; explicit stop remains a
separate action. Parent history/draft/active session and ongoing work stay owned
by the host. `/agents` → `View transcript` uses the same screen. Shell inspection
keeps its existing output viewer.

Only an agent in the active parent's `subagents()` snapshots can provide a child
session ID to public SDK `getSession`. Prefer recovered messages, then stored
messages, preserving actual tool inputs and results without the task tail's
8 KB cutoff. Live activity supplements missing calls/results; it does not replace
a full stored result with a shorter progress excerpt. Without stored history,
the activity fallback is labeled. No provider replay field is exposed: the
existing public SDK strips private continuation state. Rendering does not resume
the child, change the active session, start execution or broaden permissions.

The TUI-only overlay router tracks full-screen presentation by overlay ID so
cleanup cannot change a replacement dialog. Header/footer occupy fixed rows;
only the conversation scrolls. Session changes unmount the child view. Tests
exercise 40/80-column frames, actual stored prompts/tool arguments/results,
history beyond 8 KB, live update/follow, parent navigation, zero model calls,
pending/denied tools and full result precedence. No public contract changes.

### Upstream references

Primary Claude documentation retrieved via Context7 on 2026-11-21:

- https://code.claude.com/docs/en/commands — `/tasks` views/manages session work,
  including finished subagents; `/bashes` is its alias.
- https://code.claude.com/docs/en/agent-sdk/typescript — background transfer and
  stop APIs. These motivate behavior, not an SDK/runtime dependency.

Repo code inspected: ADR 0070, existing task dialog, footer, keymap, SDK command
registry and task APIs. Regression tests first failed for unavailable commands
and opening old output instead of the latest tail. Tests exercise actual Ink and
public SDK ports, command routing while busy, live follow/manual scrolling,
session changes, terminal sanitization and stop refusal. Full-shell integration
covers 40/80 columns, finished output, prompt focus and zero model submissions.
Line-mode subprocess coverage verifies both aliases without provider calls.

Physical terminal behavior across emulators, live provider task generation and
exact Claude terminal layout remain **Needs verification**. Tasks still do not
survive Cosmew process restart. Shell/snapshot-only output remains bounded by
the backend tail; recorded child conversations expose the retained session history.
