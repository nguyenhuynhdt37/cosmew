# Background tasks

`BackgroundTasksDialog` renders `FutrynClient.backgroundTasks()` and subscribes to
`onBackgroundTaskEvent`. Enter opens the selected task's bounded, sanitized output tail;
Esc/Enter return to the list. x (`Footer.footer:close`) invokes `stopBackgroundTask` only
for a currently running task; completed or foreign-session IDs cannot be controlled.
The SDK owns session scope, redaction and execution permissions. The host opens this
panel through its overlay router and remains the sole owner of the agent loop.

Hermetic Ink/public-SDK test covers status glyphs, output, terminal sanitization,
selection and session-scoped stop. Native process/background behavior remains the
backend's documented Needs verification boundary (ADR 0070).
