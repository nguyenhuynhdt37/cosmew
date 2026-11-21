# Background tasks

Use **`/tasks`** (alias **`/bashes`**) to open the panel, including while a turn is
running. It appears in slash autocomplete/help. Footer Down/Enter also opens it;
Ctrl+B uses the existing foreground-to-background transfer when available.

Running work is visible in a bounded `Tasks` area below the composer, including
foreground child agents. With an empty draft, Down selects a task; Left/Right
select another, Enter/Down opens the panel, x stops and Esc returns to typing.
Queued messages do not block this navigation. Running/completed agent trees are
no longer appended below the main transcript; task output lives in this panel.
Normal tool records and completion notifications remain in the conversation.

Opening an agent now replaces the chat area with a full-screen child conversation.
It reuses the main `TranscriptItem`, Markdown/tool rendering, scrollback and
virtual history viewport. Ctrl+O expands/collapses tool details, Home/End jump to
history start/latest, and scrolling up pauses following. Esc returns to the task
list; Esc again restores the parent chat and its draft. x retains the task stop
action. Inspecting does not select/resume the child session or start model work.

History comes from the owned child's public `getSession` record, preferring its
recovered messages. Full stored arguments/results are retained rather than the
8 KB output tail. Live activity fills gaps until the record catches up; a
snapshot-only fallback is labeled when stored history is unavailable. Shells
continue to use the bounded plain-output viewer. A session switch clears the
child screen, and overlay full-screen presentation is scoped to its current ID.

`sessionTasks` combines `FutrynClient.backgroundTasks()` and current-session
`subagents()` without duplicate IDs. This is a UI projection; foreground agents
stay foreground. The dialog listens to task and reactive agent events.
Enter opens the selected agent conversation or shell output tail.
Esc returns to the list (shell output also accepts Enter). x (`Footer.footer:close`) invokes `stopBackgroundTask` only
for a currently running background task; a foreground child uses `stopSubagent`.
Completed tasks cannot be stopped from this view.
The output starts at the latest retained tail and follows updates. Scroll up to
pause, use End to follow again; PageUp/PageDown and the scoped wheel also work.
The view wraps before paging so long lines stay within the viewport. A session
change resets selection and ignores late stop messages from the old view.

The SDK owns session scope, redaction and execution permissions. The host opens this
panel through its overlay router and remains the sole owner of the agent loop.

Hermetic Ink/public-SDK test covers status glyphs, output, terminal sanitization,
selection and session-scoped stop. Native process/background behavior remains the
backend's documented Needs verification boundary (ADR 0070).
