# ADR 0111 — Active transcript turn ownership

Accepted 2026-11-22. Internal UI state only; no shared wire/schema/dependency changes.

The maintainer reported a completed answer with a continuously running footer spinner. A local reducer reproduction confirmed that model events and finish actions target the final transcript row, while slash commands can append another row during the turn. Completion then settles the command row, leaving the actual assistant row marked streaming. Starting another response also previously retained any stale streaming flag.

Track an internal active assistant ID from begin through steering and completion. Apply model events and finish actions to that row regardless of appended command/notification rows; preserve the tail. Steering transfers ownership to the new assistant segment. Starting a replacement turn clears stale activity flags from earlier rows without inventing success or discarding content. Reset drops live ownership.

The footer additionally requires a real foreground model/shell activity state before showing a transcript spinner. Background work continues to be represented by the task controls rather than keeping an unrelated foreground spinner alive. No timeout, hidden cancellation or automatic model retry is introduced.

Regression tests failed before the fix for interleaved slash-command completion and replacement-turn orphan activity. Additional coverage checks steering, notification preservation and correct model-text ownership. No live user process was killed/restarted or live user database modified. Existing processes load source changes only in a new launch.

Final scoped test result:

```text
 117 pass
 2 skip
 0 fail
 13480 expect() calls
Ran 119 tests across 9 files. [11.63s]
```

Typecheck, scoped formatting and diff checks passed.
