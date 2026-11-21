# Long transcript performance

Measured on macOS with Bun 1.4.4 and Ink 8.0.0 on 2026-11-21. The real SDK/Ink fixture uses a 100×36 viewport. It interleaves prompts, Markdown answers with over 200 painted rows and code fences, and 500–5,000-line bash/read/grep/edit receipts. The final fixture includes valid edit hunks and a 350-row Status Details report. Live reasoning and tool output are driven through SDK events in the fullscreen behavior fixture. Stored provider reasoning is private and is omitted by the replay renderer.

Times are milliseconds from stdin dispatch to the first matching current Ink frame. Adaptive polling can add one poll interval. Startup and inter-action settling are excluded. The original trace used edit receipts without valid unified diff hunk headers. The after runs below included valid hunks.

| Items | Run | Ctrl+O enter | Detailed PgUp | Ctrl+O leave | Normal PgUp | Type Z | /context | /status | Status Details |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 300 | Before | 2218 | 683 | 415 | 98 | 114 | 366 | 285 | — |
| 1,000 | Before | 2201 | 843 | 592 | 239 | 239 | 792 | 612 | — |
| 3,000 | Before | 3464 | 1614 | 1353 | 1418 | 1188 | 2614 | 3511 | — |
| 300 | After, original test stream | 45 | 21 | 49 | 21 | 20 | 85 | 95 | 20 |
| 1,000 | After, original test stream | 58 | 37 | 53 | 31 | 25 | 102 | 66 | 31 |
| 3,000 | After, original test stream | 83 | 17 | 44 | 16 | 16 | 75 | 67 | 23 |
| 300 | After, dimensioned test stream | 17 | 16 | 16 | 16 | 16 | 18 | 16 | 16 |
| 1,000 | After, dimensioned test stream | 18 | 16 | 16 | 16 | 16 | 23 | 16 | 16 |
| 3,000 | After, dimensioned test stream | 17 | 15 | 16 | 16 | 16 | 16 | 26 | 16 |

## Attribution

- Before the change, SDK `context()` accounted for 1,094 ms of the 3,000-item typing sample (four calls) and 2,275 ms of /context (13 calls). Each call serialized and UTF-8 encoded the full history. The composer now computes its footer estimate on SDK revision changes. The SDK caches per-message byte lengths, preserves the JSON array byte count and shares the session record with usage calculation. The corrected 3,000-item run made zero SDK context calls while typing and one for /context, under 1 ms in the instrumented trace.
- Before the change, detailed entry used another 2,345 ms beyond the SDK estimate. The shell mounted 60 transcript items and added 40 at each history page boundary. Detailed mode mounted a component per tool-output line. Ink visits text nodes for width, wrapping, layout and output even when the enclosing viewport later clips them. Normal tool grouping also computed full display records just to classify successful calls.
- An isolated Bun CPU profile of the original transcript and grouping components rendered valid edit hunks in a clipped 100×36 Ink box. Detailed rendering took 2,556 ms with 60 mounted items and 4,249 ms with 100. Across the normal and detailed mounts, Ink text measurement accounted for 715 ms inclusive, text squashing for 224 ms self, and `stringWidth` for 70 ms self at its hottest site. The profile also sampled the tool display and transcript block builder. This isolate used the current shared UI components and excluded SDK requests and input timing. It attributes the render cost separately from the whole-session baseline.
- Fullscreen now mounts the row range around the viewport and keeps placeholders for the rest. The row index caches estimates by item identity, width and transcript mode and corrects them with measured Ink box heights. Search and prompt jumps still use the measured anchors. Per-item block, Markdown and highlight caches reuse recent content. Simple long Markdown answers, full tool receipts and full diffs window their physical rows too. Detailed tool receipts preview the head and tail, with a live tail for running tools. The context grid remains capped at 140 cells and adjacent same-color cells share text nodes.
- The lazy search index was inactive during the timings. Query scans yield every few milliseconds between items. Matching ASCII lines skip the Unicode offset map, while Unicode retains the original UTF-16 mapping. A bounded excerpt limits the layout cost of highlighting a match inside a huge receipt.
- A Bun CPU profile of the revised harness with its original stream recorded 563 ms in synchronous `terminal-size` subprocesses across startup and interaction, plus 310 ms copying SDK history in `activeSession()`. It also sampled Ink/Yoga layout and width measurement, terminal output traversal, Markdown/highlight initialization and React reconciliation. The mock stdout supplied columns alone, so Ink invoked its dimension fallback even when the app received a viewport height. The dimensioned runs supply both rows and columns, as a native TTY does. The shell now reads the session ID through status instead of cloning the transcript on every render.

The 3,000-item dimensioned run retained 264, 265 and 265 MiB of JS heap after three identical 48-key scroll sweeps and full GC. The harness discarded old captured frames during each sweep. This measures repeated scrolling through the same range. The logical row index can retain one measurement per visited item, and the SDK retains the replayed history.

## Reproduction and scope

Set `TRANSCRIPT_BENCH=1` and run `bun test apps/tui/src/ink/testing/transcript-performance.test.tsx` for all sizes and the retained-heap sample. The default test exercises the 3,000-item fixture with generous regression budgets. Related fullscreen tests cover both scroll ends, oldest-match reveal in 5,000 items, Ctrl+E semantics, and complete scrollback/editor export past the mounted range.

Ctrl+O follows the latest content when switching modes. Fullscreen Ctrl+E remains disabled under the Task 5 virtual-scroll branch. Inline rendering preserves the 30-item window and Ctrl+E expands it. Complex Markdown with wrapping, nested structures or multiline fences uses the regular renderer within the item window.

**Needs verification** — native terminal latency and real provider sessions, long inline output after Ctrl+E, and worst-case layout of a single complex Markdown item. The timing table measures Ink paint in a deterministic SDK fixture.

## Files

The changes are in `packages/sdk/src/client.ts`, the TUI shell and viewport in
`apps/tui/src/ink/{integrated-shell.tsx,screen.tsx}`, the transcript, usage and composer features,
and the shared Markdown, code and diff views. The benchmark lives beside the adaptive Ink session
harness in `apps/tui/src/ink/testing/`.

Job 1 verification passed typecheck and lint, with 133 passing tests and two skips. The final
post-expansion run passed typecheck and lint again, with 384 passing tests and four skips across
35 files. No golden frames were re-recorded.
