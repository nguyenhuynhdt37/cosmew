# Session task notifications and status presentation

The integrated shell owns completion notifications for the active parent session.
Background shell/agent `task.finished` events and out-of-turn child notices share
one terminal identity (`kind` + task ID). The helper retains 512 recent identities,
clears them when the active session changes or the transcript resets, and ignores
foreign-session or unattributed events. Transcript notification IDs provide a
second duplicate guard while the item remains in the transcript.

Completion text distinguishes completed, failed, and cancelled/stopped outcomes,
includes the description and task ID, and points to `/tasks` followed by the ID to
find in the task list. It does not claim that `/tasks <id>` is a supported command.
The task list now includes IDs. Existing task selection opens its conversation or
shell output; notices never open a dialog automatically.

Foreground completion stays in the normal tool-result presentation. Task events
without completion delivery and child notices marked `consumed` do not create an
out-of-turn notice. The shell disables the generic notice hook's automatic child
subscription, so that path cannot duplicate or leak another session's notices.
Standalone consumers of that hook retain their previous default behavior.

Pending child permission attribution derives a `waiting for permission` label in
the task list and conversation header. It does not mutate SDK task status, grant a
permission, complete a task, or replace the permission overlay. A recovered child
whose SDK status is `interrupted` is labelled interrupted rather than running.
Completion insertion uses the existing transcript notification reducer, preserving
the parent's live streaming item and leaving transcript scroll position alone.

## Validation

On 2026-11-22, the focused Bun tests cover both duplicate-source orders; missing,
foreign and late session attribution; success/failure/cancellation; foreground
suppression; the bounded identity window and reset; permission waiting/clearing;
and shell integration for duplicate suppression, preserved permission overlays,
paged history, and parent streaming continuity. Existing background task output
and shell integration tests pass with the more informative notification text.
`bun run typecheck` passes.

Commands:

- `bun test apps/tui/src/ink/features/background-tasks/notifications.test.ts apps/tui/src/ink/features/background-tasks/background-tasks.test.tsx apps/tui/src/ink/testing/p2-integration.test.tsx apps/tui/src/ink/testing/task-notifications.test.tsx`
- `bun run typecheck`

These tests exercise public SDK observer ports and Ink rendering. They provide no
live provider, operating-system process, or terminal-emulator acceptance evidence.
No SDK/backend/persistence contract or dependency is introduced by this UI slice.
