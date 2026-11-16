# Futryn TUI V2 — engineering delivery

Date: 2026-11-17. Overall: **PARTIAL** against the entire master specification;
**VERIFIED** for indexed long-session rendering, steady-state input responsiveness,
scroll/selection correctness, and the native macOS PTY checks below. This is not
full Claude Code parity or Product MVP acceptance.

## Revisions and worktree

Starting Futryn: `03d3d27bb5e70330ffe8807c3f345be5ac0a51f4`, branch `dev`.
The starting worktree contained only untracked `giao-dien.html` and `hello.html`;
both were preserved. During execution, independent documentation commit
`21443f6291fc6a88415d7e978da8d40817317156` landed on `dev`; its AGENTS/CLAUDE/repository-map
changes were preserved. Delivery is committed on top of it, without pushing.
The exact delivery commit SHA is included in the final delivery message.

Fresh reference SHAs, inspected paths, official docs and UX matrix are in
[references.md](references.md). Claude Code's public changelog revision is pinned;
its private TUI source was neither accessed nor inferred as implementation evidence.
Rolling documentation has access dates, not invented Git revisions.

## Audit and measured causes

- `renderTranscriptViewport` formatted every message into `allLines`, then sliced.
  At 5,000 mixed messages, original layout p50 was 339.7 ms and p95 1,020.3 ms.
- The runtime rendered every 80 ms even when idle. Provider notifications added
  further frames; stdout backpressure did not bound pending rendered output.
- `client.context(draft)` serialized full session history for the composer each frame.
- `client.status()` called `usage()` twice, decoding/summarizing the durable session
  on every keypress. The regression test measured 20 history reads for ten characters.
- Selection required a full formatted document in every frame; simply slicing the
  renderer would break cross-screen copying and disclosure coordinates.
- Composer reflow eagerly segmented the whole draft on every frame. Word wrapping
  repeatedly segmented the remaining suffix; code-block slicing could split graphemes.
- Tool/result lookup was quadratic within a tool-heavy message. Expanded command
  output stopped at 1,000 rows, with no way to see later retained rows.

Retain: Canvas/ANSI diff, existing SDK modes/commands/configuration/model/session
pickers, secure diff collection, real event-driven tool cards, permission decisions,
theme tokens and optional welcome art. Optimize: transcript, input layout, scheduling,
status/context readout and tool lookup. Replace: full-history-per-frame layout and
unconditional redraw. Suppress wallpaper in active conversations; no framework change.

## Implementation

[ADR 0039](../../adr/0039-tui-v2-virtualized-transcript.md) and [usage/architecture](usage.md)
describe the rendering path and migration.

- Exact message-height Fenwick index, stable identities, local layout revisions and
  explicit dirty IDs. Visible intersecting messages are materialized; cached nearby
  layouts remain available through bounded LRU eviction.
- At most 256 cached layouts and 2,000,000 weighted units of styled text/span/row storage.
  This is approximate accounting, not an assertion about exact JavaScript heap bytes.
  Oversized individual layouts are rendered transiently and not cached.
- Message-relative reading anchors, bottom-follow mode, correct total scroll height,
  width/theme invalidation, and a new-output footer. Append/steering does not force
  a reader at an old position to the bottom.
- Lazy frozen selection documents, read on demand across screens; only selection
  creation clones source state. Highlight repaint touches the visible selected rows.
- One coalesced pending frame; input advances the provider deadline. Visible status
  ticks only while working; optional welcome animation pauses on focus loss.
  Idle conversation has no frame timer. stdout drain bounds pending paints.
- Explicit repaint notifications for asynchronous sign-in, startup verification,
  reports, diff refresh, and model/tool-output deltas. A full-suite PTY failure exposed the sign-in progress
  timer's old reliance on unconditional redraw; its producer now notifies on changes.
- Cached status usage; explicit `/usage` remains a fresh read. Composer context base
  is cached, local draft overhead added separately, streaming refresh throttled to 1s.
- Cached draft wrapping, append-tail reflow, grapheme-safe code wrapping, word keys,
  Shift-arrow selection/replacement, Alt+R reverse history search, Ctrl+O verbose
  transcript, empty-prompt Home/End navigation, and process-local per-session drafts.
- Native input dispatch can continue after starting a model turn; the programmatic
  `handleKey` default still awaits completion for existing consumers/tests.
- `/diff` side panel at 140+ columns; modal fallback below; file/layer/refresh/copy
  commands retain the existing SDK collector and permissions. Approval presentation
  uses actual runtime labels/limitations rather than a hardcoded safety failure.
- Existing tool cards remain receipt/event based. Maps replace repeated tool/result
  searches, and expanded command output can expose all retained result rows.

No dependency, daemon, execution backend, persistence schema, permission policy or
Agent Loop changes. No journal/history truncation. No tool replay on resume.

Private TUI package version: **0.2.0** (lockfile updated, no new dependencies).
Local TUI snapshot migration: `TranscriptViewport.lines` contains visible rows;
`totalLines` gives document extent and `freeze()` provides a stable lazy document.
The existing `renderTranscriptViewport().allLines` export remains a deprecated lazy
full-document getter for explicit diagnostics; the interactive path never reads it.
No public wire/event/settings schema was changed.

## Benchmarks

Environment: Apple M1 Pro, macOS Darwin 24.6.0 arm64, Bun 1.4.4, fixed 120×40.
Deterministic fixtures: 100/1,000/5,000 messages, half assistant messages, long reasoning,
Markdown and code, and one 160-line command result per assistant (2,500 tools at 5,000).
App benchmark additionally exercises large paste, streaming plus scrolling, six width
changes, restoration, CPU, heap, forced GC, queue delay, painted rows and ANSI bytes.

Renderer: 24 frames including cold first layout. App: cold frame recorded separately,
24 samples each for typing, scrolling and injected streaming/scroll updates, 20 samples
after a 230k-character multiline paste. These are handler-to-ANSI-generation timings;
terminal emulator paint is excluded. Baseline app harness was executed against an
isolated `git archive` of the starting SHA with the same fixture and harness. Baseline
has no layout counter (`null`); this does not mean zero layout work.

| Messages | Renderer frame p50 / p95, before → after (ms) | App typing p50 / p95, before → after (ms) |
|---:|---|---|
| 100 | 11.34 / 18.60 → 3.14 / 8.39 | 12.53 / 19.81 → 2.66 / 4.69 |
| 1,000 | 69.51 / 93.71 → 2.36 / 4.99 | 77.34 / 87.57 → 2.46 / 3.19 |
| 5,000 | 342.56 / 1,021.63 → 2.00 / 5.89 | 376.05 / 498.02 → 2.52 / 2.94 |

| Messages | Scroll p95 before → after | Stream + scroll p95 before → after | Typing after paste p95 before → after |
|---:|---:|---:|---:|
| 100 | 15.10 → 3.43 ms | 17.60 → 4.03 ms | 79.41 → 5.84 ms |
| 1,000 | 94.33 → 4.35 ms | 85.32 → 38.15 ms | 123.02 → 9.38 ms |
| 5,000 | 453.44 → 3.84 ms | 1,043.23 → 3.87 ms | 659.75 → 3.49 ms |

At 5,000, complete scripted scenario CPU fell from 41.76s user + 4.15s system to
3.16s + 0.29s. Typing formatted **zero** messages after warmup. Output for 24 typing
frames was unchanged: 8,712 ANSI bytes / 48 rows painted, so improvements did not come
from suppressing input output. Cache remained 256 entries / 1,981,696 weighted units.

Cold costs remain: 5,000-message restore about 67 ms plus a 444 ms first layout;
resize p95 about 481 ms (baseline 784 ms). A 1,000-message mixed stream/scroll run
had a 38 ms p95 / 45 ms max; its p50 was 3.55 ms. Thus **not every app scenario meets
the 16 ms frame target**. Source history, width remeasurement and individual-message
layout remain the cost of those paths; no unsupported attribution of automatic GC
pauses is made. Large paste initially took 40–66 ms; subsequent typing met 50 ms.

Total heap after forced GC grew at 5,000 from about 29.6 MB to 45.4 MB: caches trade
bounded memory for speed. This metric includes retained fixture/session data, settings,
SQLite projections and editor caches; it is not solely layout cache size. Forced GC
pause was 55.9 ms after vs 77.7 ms before, not a measurement of automatic GC frequency.
JavaScriptCore automatic GC event counts and emulator/GPU paint times were not
instrumented. No claim that complete process memory is constant with retained history.

Raw artifacts: [renderer baseline](baseline.json), [renderer after](after.json),
[app baseline](app-baseline.json), [app after](app-performance.json). Markdown with/without
syntax timing, Canvas allocation/painting, ANSI diff, CPU/heap/GC and event queue delay
are recorded there. Independent Markdown microbenchmarks are not percentage attribution.

Actual native PTY: ten sequential input-to-output samples at 5,000 messages ranged
4.17–6.79 ms (p95 using these ten samples: 6.79 ms), excluding emulator paint. The test
also checks idle silence, literal Unicode paste, resize, raw-mode/alternate-screen cleanup
and process exit. The 50 ms PTY and 16 ms warm-render budgets are regression assertions.

## Validation and acceptance

| Command | Actual exit | Result |
|---|---:|---|
| `bun test tests` | 0 | 653 passed, 33 skipped, 0 failed; 67 files, 121.53s |
| `bun run typecheck` | 0 | TypeScript passed |
| `bun run lint` | 0 | unused checks, Prettier and diff whitespace passed |
| `bun test tests/contracts/transcript-virtualization.test.ts tests/performance/tui-performance.test.ts` | 0 | 7 passed, 927 assertions |
| `bun test tests/end-to-end/tui-v2-pty.test.ts` | 0 | 1 passed, 18 assertions, actual native PTY |
| `bun test tests/end-to-end/subscriptions.test.ts --test-name-pattern 'Esc cancels redirected'` | 0 | Sign-in repaint regression passed |
| `bun tests/performance/tui-benchmark.ts` | 0 | before/after artifacts |
| `bun tests/performance/tui-app-benchmark.ts` | 0 | before/after artifacts, real persistence and SDK, deterministic injected tool/stream presentation |
| `git diff --check` | 0 | No whitespace errors |

An earlier full run had one failed sign-in PTY case; it was fixed and the complete
suite rerun passed. The 33 skipped tests are opt-in authenticated/native-vault/platform
or Docker acceptance; they are not presented as verified. Normal default security,
permission, cancellation, pairing and terminal-injection tests remained enabled.
Docker-specific tests in the existing suite do not create a TUI runtime dependency.

| Requested case | Status / evidence |
|---|---|
| 1–3 Long load / beginning / bottom | **VERIFIED** — indexed equality, Home/End/page/wheel and 5,000-message native resume |
| 4 Streaming while reading history | **VERIFIED** — dirty-tail test preserves visible rows/offset; mixed benchmark |
| 5–6 Expand old output / collapse reasoning | **VERIFIED** — anchor/equality tests, existing transcript activity tests, >1,000 output rows |
| 7 Resize | **VERIFIED** correctness; **PARTIAL** latency, full exact remeasurement remains |
| 8 Theme switching | **VERIFIED** — theme invalidation and existing theme/golden suites |
| 9–10 Session switching / resume | **VERIFIED** — draft integration, native resume and existing recovery tests; drafts process-local |
| 11 Typing during streaming | **VERIFIED** deterministic mixed benchmark and existing streaming UI tests; authenticated terminal session not exercised |
| 12 Queued input | **VERIFIED** existing Agent Loop steering/continuation tests; no queue backend rewrite |
| 13 Large paste | **VERIFIED** literal bounded decoder, Unicode replacement, large app benchmark; cold paste can exceed one frame budget |
| 14 Approval during streaming | **VERIFIED** existing tools/permission flows; actual runtime labels retained |
| 15–16 Interrupted / failed command | **VERIFIED** existing command/cancellation and receipt tests; sandbox behavior unchanged |
| 17 Concurrent calls | **VERIFIED** existing Agent Loop/shared-exclusive tests and ordered cards |
| 18 Recovery | **VERIFIED** conversation-recovery tests; no replay/no schema migration |
| 19 Shutdown | **VERIFIED** native PTY exit/terminal protocol cleanup; SIGKILL/emulator recovery not claimed |
| 20 Duplicate history | **VERIFIED** indexed equality, session resume/recovery tests |
| 21 Unicode / ANSI | **VERIFIED** grapheme input/code wrapping, Canvas/selection and security terminal-injection suite |
| 22 Clipboard / selection | **VERIFIED** native mac clipboard fixture, OSC52 fallback tests, cross-screen frozen selection; other host clipboards unverified |
| 23 Diff | **VERIFIED** wide/narrow integration and secure diff/security regression suites |
| 24 Configuration persistence | **VERIFIED** existing Task 03+04 config/settings tests, unchanged backend |
| 25 Narrow layout | **VERIFIED** golden frames at 44×14 plus existing tiny-terminal tests and modal diff |

## Platform matrix

| Environment | Status |
|---|---|
| Native macOS arm64 PTY / Bun 1.4.4 | **VERIFIED**, actual TUI runtime, no Docker |
| macOS Terminal, iTerm2, Ghostty, VS Code | **IMPLEMENTED — NOT LIVE VERIFIED** individually; no emulator-by-emulator acceptance performed |
| Linux terminals | **IMPLEMENTED — NOT LIVE VERIFIED**; OS was not available in this run |
| tmux / SSH | **IMPLEMENTED — NOT LIVE VERIFIED**; tmux binary absent, no remote session available |
| Windows Terminal | **IMPLEMENTED — NOT LIVE VERIFIED** terminal layer; existing Windows command sandbox remains unsupported/fail-closed |
| Classic/native terminal scrollback | **NOT IMPLEMENTED**; fullscreen is the only exposed interactive mode |

## Security and ownership review

Author self-review of the final diff (including a reproduced/fixed missing tool-output repaint); no independent/subagent review was used.
No edits to tool dispatch, core loop, approval policy, workspace protection, subscriptions,
Git collection, journals or schema. No dependencies installed. Source/history data remains
complete; presentation caches have no authority to execute/replay tools. Canvas continues
to sanitize terminal controls; selection reads sanitized cells; OSC52 remains bounded.
Diff is read-only and collected outside render frames. Delegated runtime labels remain.
Drafts stay in process memory, avoiding silently persisting potentially sensitive unfinished
input. SDK status caches carry no permissions/grants; explicit usage reads remain fresh.
External DB-only usage changes need a local lifecycle notification or explicit usage refresh.

Environment hook warned about installed Node 24.22.0 and recommended 24.22.1+; system
Node was not changed. Project execution and verification used Bun.

## Remaining limitations

- **PARTIAL:** cold history layout and width changes are synchronous O(history) measurements.
  A content-offset anchor within a reflowed long message would preserve exact text better
  than the current message/row anchor. Streaming a single oversized message can re-layout
  that message; finer-grained block virtualization remains future work.
- **PARTIAL:** Canvas still composes a fixed full screen, then ANSI diffs dirty rows. Dirty
  regions coalesce updates and avoid history work; they are not separate retained canvases.
- **NOT IMPLEMENTED:** durable draft/scroll storage across process restart, custom input-key
  remapping, full transcript search UI, composer mouse cursor positioning/autocomplete clicks,
  classic renderer, rewind/workspace checkpoint restoration, general background scheduler,
  side questions and agent/subagent navigation. Existing unavailable commands remain honest.
- **PARTIAL:** optional sidebar/session picker still uses existing session summaries; its
  backend can read histories. Primary performance measurements use default sidebar off.
- **IMPLEMENTED — NOT LIVE VERIFIED:** emulator/platform matrix above and authenticated
  provider acceptance. The project cannot honestly be labelled cross-platform verified.
- Some automatic GC and emulator paint metrics are unavailable; forced GC and PTY delivery
  are explicitly distinguished. Timing tests are environment-sensitive, alongside structural
  zero-layout/bounded-cache assertions that do not depend on machine speed.

## Modified files

```text
apps/tui/package.json
apps/tui/src/app.tsx
apps/tui/src/core/feature.ts
apps/tui/src/features/chat/controller.ts
apps/tui/src/features/chat/view.ts
apps/tui/src/features/composer/layout.ts
apps/tui/src/features/composer/logic.ts
apps/tui/src/features/composer/types.ts
apps/tui/src/features/composer/view.ts
apps/tui/src/features/connect/controller.ts
apps/tui/src/features/diff/controller.ts
apps/tui/src/features/diff/view.ts
apps/tui/src/features/help/view.ts
apps/tui/src/features/permissions/controller.ts
apps/tui/src/features/permissions/view.ts
apps/tui/src/features/reports/controller.ts
apps/tui/src/features/selection/logic.ts
apps/tui/src/features/startup-gate/controller.ts
apps/tui/src/features/transcript/layout.ts
apps/tui/src/features/transcript/logic.ts
apps/tui/src/features/transcript/view.ts
apps/tui/src/input/terminal-keys.ts
apps/tui/src/input/text.ts
apps/tui/src/render/frame-scheduler.ts
apps/tui/src/runtime.tsx
apps/tui/src/types.ts
bun.lock
docs/README.md
docs/adr/0039-tui-v2-virtualized-transcript.md
docs/delivery/tui-v2/after.json
docs/delivery/tui-v2/app-baseline.json
docs/delivery/tui-v2/app-performance.json
docs/delivery/tui-v2/baseline.json
docs/delivery/tui-v2/documentation-snapshots.json
docs/delivery/tui-v2/plan.md
docs/delivery/tui-v2/references.md
docs/delivery/tui-v2/report.md
docs/delivery/tui-v2/usage.md
package.json
packages/sdk/src/client.ts
tests/contracts/__golden__/tui-overlays.json
tests/contracts/composer-input.test.ts
tests/contracts/frame-scheduler.test.ts
tests/contracts/transcript-virtualization.test.ts
tests/contracts/tui-v2-integration.test.ts
tests/end-to-end/tui-v2-pty.test.ts
tests/performance/tui-app-benchmark.ts
tests/performance/tui-benchmark.ts
tests/performance/tui-fixture.ts
tests/performance/tui-performance.test.ts
```
