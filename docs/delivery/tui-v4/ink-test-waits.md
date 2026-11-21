# Ink test waits

Ink test input delivery, promise continuations, passive React effects and throttled
renders complete on different event-loop turns. A fixed sleep can return a stale
frame on a busy machine, even when the same test passes alone.

Use `settle(ms?, timeoutMs?)` from `apps/tui/src/ink/testing` after input when no
specific result is expected. It drains `setImmediate` and microtask turns and
requires three consecutive turns with unchanged frame text **and frame count**.
The test input streams mark bare Escape as pending through Ink's escape parser
timer. Use the optional `{quietMs}` third argument for deliberate timer fixtures
or a separate PTY process when there is no observable completion condition.
`ms` sets a minimum wait (default 0), and `timeoutMs` defaults to 2000 and includes
the last frame on failure. Standalone fixtures can import the wait module
without loading `bun:test`.

Use `waitForFrame(view, frame => frame.includes('expected text'), timeoutMs?)` when
waiting for a particular async result. It checks the current frame immediately,
then tries event-loop turns before using short timers on the slow path. It
defaults to a 2000 ms deadline and reports the last frame on timeout. Keep the
assertion after it. For multiple paints, include the result and its context in
the predicate. A quiet frame alone cannot establish that external work finished.

`renderInk` and the test-only `render` wrapper track their views automatically.
The fullscreen stream harness and native PTY register their output with
`trackFrames`. Weak references avoid retaining discarded views. Bounded polling
for explicit SDK state/PTY output remains condition-based; sleeps used to simulate
delayed work in the wait regression tests are intentional.

See [test suite timings](test-speed.md) for measurements and examples.
