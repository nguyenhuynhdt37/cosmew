# Ink test waits

Ink test input delivery, promise continuations, passive React effects and throttled
renders complete on different event-loop turns. A fixed sleep can return a stale
frame on a busy machine, even when the same test passes alone.

Use `settle(ms?, timeoutMs?)` from `apps/tui/src/ink/testing` after input when no
specific result is expected. It yields timer and promise turns and requires three
consecutive 15 ms polls with unchanged frame text **and frame count**, across the
tracked views. `ms` is a minimum wait (default 0); `timeoutMs` defaults to 2000 and
throws with the last frame when the view keeps painting. Standalone fixtures may
import the helpers: the wait module has no `bun:test` dependency.

Use `waitForFrame(view, frame => frame.includes('expected text'), timeoutMs?)` when
waiting for a particular async result. It checks the current frame, defaults to a
2000 ms deadline, and reports the last frame on timeout. Keep the assertion after
it. A quiet frame cannot prove that a slow external operation has completed;
unresolved permissions, shell streams and long-lived application timers must not
prevent input in the meantime.

`renderInk` and the test-only `render` wrapper track their views automatically.
The fullscreen stream harness and native PTY register their output with
`trackFrames`. Weak references avoid retaining discarded views. Bounded polling
for explicit SDK state/PTY output remains condition-based; sleeps used to simulate
delayed work in the wait regression tests are intentional.

No production code or public SDK contract changes.
