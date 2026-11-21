# OSC 11 startup input regression

2026-11-21. The background query accepts only BEL- or ST-terminated OSC 11 replies. It reads stdin in paused mode, like Ink: switching through flowing `data`/`resume`/`pause` reproduced a Bun stdin-handle loss and an idle exit in the native PTY regression.

The original persistent read wrapper regressed synchronous harness input: it held a trailing Escape for 25 ms, emitted a later `readable`, and discarded BEL outside protocol strings (the Ctrl+G binding). That wrapper has been removed from both the runtime and input hooks. Ink receives its original reader throughout interactive input. Ink itself has a 20 ms lone-Escape disambiguation timer; Cosmew adds no timer to live key delivery.

Protection is confined to startup. After an OSC 11 answer or the query timeout (default 150 ms), the query keeps draining for 500 ms **before** Ink starts. Raw mode stays enabled throughout this bounded window and is restored before resolution. The startup parser discards OSC/DCS/APC traffic across split introducers/terminators, retains no protocol payload, and suppresses orphaned ST only after a swallowed string. Ordinary input, including BEL and a trailing Escape, is queued back in order at handoff (bounded to 4096 characters). No reader override, timer, or drain listener remains after handoff. Silent-terminal startup therefore takes about 650 ms at the default timeout.

Files changed in this follow-up:

- `apps/tui/src/input/terminal-input.ts` and `terminal-input.test.ts`: startup-only parser, BEL preservation, conditional orphaned ST handling; remove the stream wrapper.
- `apps/tui/src/input/key-delivery.test.tsx`: real input hook sees Escape with only Ink's own timer and synchronous Ctrl+G, followed by ordinary input and CSI.
- `apps/tui/src/theme/terminal-background.ts` and `terminal-background.test.ts`: bounded pre-render drain, split/late replies, input replay, original reader identity and listener/raw-mode cleanup.
- `apps/tui/src/ink/hooks/input-scope.tsx` and `runtime.tsx`: remove persistent filters.
- `apps/tui/src/ink/testing/fullscreen.test.tsx`: exercise bytewise protocol traffic through the startup drain before mounting the consent UI; account for the bounded startup grace period.
- This report. No dependencies or public contracts changed.

Sequential validation:

- `bun run typecheck`: passed.
- `bun run lint`: passed.
- `bun test tests/end-to-end/memories.test.ts`: 6 pass, 0 fail (including memory deletion after Escape).
- `bun test tests/end-to-end/tui-modes.test.ts`: 1 pass, 10 fail at HTTP fixture setup (`EADDRINUSE` on port 0), before UI assertions. This includes the review/unapproved-workspace and Shift+Tab tests; neither could be verified in this environment.
- `bun test tests/end-to-end/native-agent.test.ts`: 0 pass, 1 fail at the same HTTP fixture bind, before the native Seatbelt scenario.
- `bun test apps/tui/src/input`: 7 pass, 0 fail.
- `bun test apps/tui/src/theme`: 14 pass, 0 fail.
- `bun test apps/tui/src/ink/testing/fullscreen.test.tsx`: 20 pass, 0 fail.
- `bun test tests/end-to-end/tui-ink-pty.test.ts -t 'keeps workspace consent alive'`: 1 pass, 0 fail, covering all six 0/50/400 ms × BEL/ST cases with split terminators and real consent navigation.

No test runs were launched in parallel. A standalone `Bun.serve({hostname: "127.0.0.1", port: 0, ...})` probe also failed with `EADDRINUSE`, independently of the test harness. These fixture failures are not reported as passing verification. Shared pre-existing edits were retained; no stash, reset, or commit was used.
