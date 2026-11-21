# Background tasks UI delivery

## Design

User requested showing background shell/agent tasks, output and stop controls like
Claude CLI. Reuse existing SDK task snapshots, scoped stop, notifications and
Ctrl+B transfer; no new executor, provider call, process persistence or permission
path. Expose `/tasks` and official alias `/bashes` in shared command help/menu,
including while a response runs. Existing footer Down/Enter remains available.
Keep completed tasks inspectable. Output opens at the latest bounded sanitized
tail, follows updates until manually scrolled, and End resumes following.
Session changes cannot expose/control tasks from the old session. Stop is offered
only for running tasks and never reported successful after backend refusal.

Source: https://code.claude.com/docs/en/commands (`/tasks`, `/bashes`) and
https://code.claude.com/docs/en/agent-sdk/typescript (`backgroundTasks`, `stopTask`),
retrieved via Context7 2026-11-21. These establish intended behavior, not exact
terminal pixel parity. Repo background contract remains ADR 0070.

## Plan

- [x] Add failing command registry/router and full-shell tests: aliases visible,
  background panel opens without provider execution, even during active work.
- [x] Add failing task output tests: latest output, manual scroll/follow, session
  switch, status updates, sanitized output and stop refusal.
- [x] Implement command route and bounded task-specific output viewer using
  public SDK, central keymap and scoped mouse input.
- [x] Bump shared contract to 1.42 for added command-overlay surface, update
  consumers, record ADR 0088 and usage docs. No new dependencies.
- [x] Run focused checks, typecheck/lint, core suite and TUI suite; preserve all
  pre-existing uncommitted changes. No commits/staging/settings writes.

## Verification — 2026-11-21

Implemented and verified without paid provider calls:

- Full core suite: **991 pass, 8 skip, 0 fail** (999 tests).
- Full TUI suite: **547 pass, 4 skip, 0 fail** (551 tests).
- The busy-turn integration was added after the full TUI run loaded its file;
  a separate final run of that file passed all **3 tests**, including opening
  agent output while the main response runs and 40/80-column prompt recovery.
- Real macOS process suite (`FUTRYN_TEST_REAL_BACKGROUND=1`): **4 pass, 0 fail**;
  verifies transfer survives parent cancellation, stop, failed exit and capacity.
- Focused feature suite: **19 pass, 0 fail** before the later empty/busy cases.
- Feature-file Prettier and final `git diff --check`: passed.
- Initial typecheck and repository lint passed. A final repository lint rerun
  detected an unrelated concurrent transcript change:
  `apps/tui/src/ink/features/transcript/activity.tsx:32` passes the string
  `"100%"` to Ink's numeric `maxWidth`. This feature does not change that file;
  final repository lint is therefore **blocked**, not claimed green.

Live provider-generated tasks and physical emulator parity remain Needs
verification. Tasks belong to the current live session and do not survive exit.

## Follow-up — visible task navigation while chatting

User screenshot identified two foreground children whose `Task` calls were
visible in chat but whose footer/panel had no matching work. Reproduced using the
actual integrated shell: main response pending, `background: false` child,
missing manage hint. Also reproduced Down being blocked by a queued message.

Changes:

- Add a bounded task area below the input with descriptions and a manage hint.
  At most three task rows, or one in a short terminal; selection remains visible.
- Use the same UI projection for footer counts/selection and the task panel:
  background shells/agents plus foreground children, without duplicate IDs.
- Down selects work from an empty draft even with queued input. Left/Right changes
  the selected task; opening the panel preserves that selection.
- Remove the duplicate agent tree from the main transcript. Ordinary tool records
  and completion notices remain; child output is inspected in the panel.
- Foreground children keep foreground semantics and the SDK `stopSubagent` path.
  Opening/closing inspection does not interrupt the main response or stop work.
  Agent output refreshes on reactive progress events. No public contract changes.

Final focused verification: **42 pass, 0 fail** across five files (251 assertions),
including foreground output/progress, Esc without stop, explicit stop, queued
messages, and four-task selection/prompt recovery at 40×16. Native PTY test run
separately: **1 pass, 0 fail**, 29 assertions. Scoped Prettier and diff check pass.

The broader TUI run overlapped test development and is not a clean final run:
552 pass, 4 skip, 3 fail. The queued-input regression now passes after its fix;
the native PTY failure passed in the isolated final rerun. The remaining keymap
expectation differs from concurrent `alt+up/down/enter` transcript bindings,
outside this change. Final typecheck/lint still reports the concurrent
`transcript/activity.tsx:32` numeric `maxWidth` error described above. No claim of
a fully green repository or live provider acceptance is made for this follow-up.

## Follow-up — full-screen agent conversation

User requested opening a subagent like the main chat, replacing the plain-text
output-tail experience. Agent inspection now uses the main `TranscriptItem`
renderer and full-screen layout, with Markdown, actual recorded tool arguments
and results, Ctrl+O detailed tools, keyboard/wheel scrolling and follow controls.
The parent screen is hidden while inspecting and restored on return. Shell task
inspection keeps its existing output-tail view.

History is read from the public SDK session record of a child already owned by
the active parent, preferring recovered messages. Progress snapshots fill missing
activity without replacing full stored results with excerpts. Pending tool calls
retain running state; denials stay denials. Without recorded history, the fallback
is labeled as an activity snapshot. Virtual history reuses the main viewport and
avoids rendering the entire history on every scroll. Reads are memoized across
scroll-only renders. Inspection never resumes/selects the child or calls a model.

Focused feature verification: **18 pass, 0 fail** across six files. A final
three-test agent-conversation run added parent-screen restoration assertions and
passed **75 assertions**: full 40/80-column screens, real prompt/tool details,
history beyond 8 KB, scroll pause/follow, session switch and no provider calls.
Repository typecheck, unused checks, Prettier and diff check passed. Full TUI
suite: **561 pass, 4 skip, 0 fail** (565 tests across 64 files). No new dependencies or public
contract changes. Real-provider acceptance remains Needs verification.

The `/agents` menu's `View transcript` action also uses the shared full-screen
conversation. Its selection is checked against the active parent's children
before reading details. This final entry-point wiring was verified with the task
and conversation suites plus the complete picker-dialog suite: **69 pass,
0 fail**, 383 assertions across seven files. Repository lint passed afterward.
