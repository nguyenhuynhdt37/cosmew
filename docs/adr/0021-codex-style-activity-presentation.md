# ADR 0021: Codex-style activity presentation in the TUI

Accepted 2026-11-15 by explicit user request ("cách trình bày như Codex CLI"). The user chose inline, dim thinking (visible by default, Ctrl+R hides) over Codex's transcript-only thinking, and asked for the work to be done now. Scope: `apps/tui` rendering only. No contract, provider, persistence or permission change. Shell/"Ran" cells are **Not implemented** because Hannes has no shell tool (AGENTS.md).

## Upstream evidence

Codex source, commit `ee344ca9458351a6ea102795fa73110ad3ede5dc`, accessed 2026-11-15, read only as design reference (nothing copied):

- `codex-rs/tui/src/exec_cell/render.rs`: exploration cells: header `• Exploring` (active, animated marker) / `• Explored` (bold), rows prefixed `  └ ` then `    `, verbs `Read`/`List`/`Search` in the accent color, adjacent successful reads merged as `Read a, b`, a failing call gets its own row with a red status. Shell cells: `• Running` / `• Ran <command>`.
- `codex-rs/tui/src/history_cell/messages.rs`: reasoning summaries are dim italic with `• `; completed reasoning is transcript-only (hidden from main scrollback). Agent messages start with `• `.
- `codex-rs/tui/src/history_cell/dynamic.rs`: dynamic tool cells `• Calling|Called|Failed <name>` with `  └ ` output preview.
- `codex-rs/tui/src/status_indicator_widget.rs`, `chatwidget/streaming.rs`, `chatwidget.rs` (`extract_first_bold`): status row `<marker> <header> (<elapsed> • esc to interrupt)`; header defaults to `Working` and switches to the latest bold title of the reasoning summary; elapsed `12s`, `1m 05s`, `1h 02m 03s`.

Limits: one revision; the behavior of the installed Codex 0.167.0 binary was not compared on screen.

## Previous FUTRYN behavior (audit)

- `TranscriptItem` kept reasoning, tool calls and text in separate flat fields, so a multi-round turn was drawn as: one `▸ Thinking · from provider · Ctrl+R` block, then every tool card, then all text concatenated. Chronology was lost.
- Each call was one card `✓ read path — N lines`; no grouping.
- Live status lived only beside the Fyn mascot (`··· Thinking from provider` / `Esc to interrupt`) and was absent when the mascot did not fit.

## Decision

1. `TranscriptItem.parts` records the turn in arrival order: `reasoning` and `text` slices of the stream and `tools` groups (call ids). Flat fields stay for existing consumers and as the fallback for items without parts. Stored sessions rebuild parts from `assistant{toolCalls}`/`tool` messages, so a resumed session looks the same (reasoning is not stored, unchanged).
2. Tools part → exploration group: `◦ Exploring` while a call has no result, `• Explored` after; rows `Read` (adjacent successful reads merged; file name, full path when two files share a name), `List` (glob), `Search` (grep), with notes `denied`/error code in the error color and `unchanged`/`partial`/`over budget` dim.
3. Reasoning parts render inline, dim italic, `• ` first row; `**Title**` markers are stripped inline. Ctrl+R still toggles them (default visible). Answer text keeps the `• ` accent bullet; a blank line separates text from activity.
4. One status row above the composer while streaming (beside Fyn when shown): `• <label> (<elapsed> • Esc to interrupt)`, label in order: `Waiting for your approval`, `Reading`/`Exploring` (a call is running), the latest reasoning title or `Thinking`, `Replying`, `Waiting for provider`, `Working`.
5. Italic is carried through `StyledSpan` → `FrameCell` (optional, set only when true) → ANSI `ESC[3m`/`ESC[23m`. Model-supplied paths and patterns are still stripped of control bytes and every cell stays sanitized by `Canvas`.

## Evidence

`tests/contracts/transcript-activity.test.ts`: ordering, grouping/notes, hidden thinking, wrapping, control bytes, resumed order, elapsed/title helpers, and a live fixture frame mid-turn (`└ Read notes.txt` plus a status line with elapsed time) that settles to `• Explored` without the status line. Existing tool tests now expect `└ Read …`. Golden overlay frames are unchanged (they contain no tool or reasoning turns).

2026-11-15: `bun run lint` passed; `bun test tests` **301 pass, 5 skip, 0 fail** (306 tests, 28 files). Not verified: appearance in a real terminal with a live reasoning model; italic support varies by terminal (unsupported terminals show normal text).

## Live continuation follow-up (2026-11-15)

User reported that tool/model continuation was not visible. TUI now shows a live `Waiting for model…` row after completed tool batches, clears it on actual provider output/end, and keeps separate groups for later model rounds even without text/reasoning between calls. Provider reasoning is shown only when supplied. Patch proposals/results get their own pending/stopped/denied/completed/partial cells with actual receipt paths and created directories; incomplete exploration is never labelled successful. Resumed interrupted tool-only turns flush before the next user turn and at EOF. No core, provider, permission or execution behavior changes. Focused tests cover the timeline, two real fixture read/continuation rounds, patch outcomes and interrupted resume.

Follow-up verification: focused activity/patch tests 21 pass; full suite 385 pass, 5 skip, 0 fail; typecheck/lint pass. Subagent review checked grouping, resume and truthful patch states; denied receipt payloads cannot render completed file effects. Interactive live-provider appearance remains separate acceptance.

## Chat interaction follow-up (2026-11-15)

User requested Claude-style folding within chat, retaining the existing composer, themes, sidebar and welcome screen. Chat activity now defaults to clickable `▸` rows: provider thinking summaries and ordered tool batches expand independently, with full tool inputs/status and actual command/patch receipts. Ctrl+R expands/collapses thinking. Adjacent tool-only rounds compact visually without changing stored parts or call/result pairing. Answers render basic Markdown and short local file references; chat uses muted activity colors and a three-row Fyn at the left of the composer.

Wheel scrolling moves two lines; PageUp/PageDown move a viewport, clamp at boundaries and resume following at the bottom. Drag selection can cross viewport boundaries by wheel or edge autoscroll, using a frozen rendered document while the live turn continues. Only displayed, sanitized text is copied; the existing 64 KiB clipboard bound remains. ANSI repaint hides and parks the hardware cursor because the composer draws its own caret. Fold and selection state are local to the TUI; no provider, permission or execution authority changes.

Evidence: `chat-interactions.test.ts`, `quiet-transcript.test.ts`, `text-selection.test.ts`, updated live activity tests, overlay goldens and existing PTY tests. These cover click expansion/collapse, exact inputs, denied outcomes, ordering, wheel/page limits, selection beyond one screen, edge autoscroll, control-byte removal, frozen streaming selection and cursor sequences. Live-provider visual acceptance in the user's terminal remains separate from fixture/PTY evidence.

Verification: focused interaction/activity/selection tests 25 pass; full suite 391 pass, 5 skip, 0 fail (396 tests / 37 files); typecheck/lint pass. Only eight chat golden frames changed; welcome and overlay frames stayed unchanged. Light/dark rendered fixture previews were inspected; PTY fixtures verified reasoning expansion, read/continuation, input and terminal lifecycle.

### Chat role contrast and requested sprite (2026-11-15)

User rejected the ASCII cat and requested the actual Weepinbell used by their `hydefetch`, on the right. Chat now has explicit `Bạn` prompt cards with accent rails/tint and a separate bold `Hannes` answer label; activity is indented under the model. The composer, welcome and theme controls retain their layout. The sprite sits in a narrow right rail so it does not consume full-width conversation rows; small terminals omit the rail.

Asset provenance: local `~/.local/opt/pokemon-colorscripts/colorscripts/small/regular/weepinbell`, inspected 2026-11-15, SHA-256 `45ecb894b15cb1f8a878f217cfdcca56088dc022196e466f6b5e97a084286d3d`. Its original 22×22 pixels/palette are statically decoded into `weepinbell.ts`; no approximation, runtime file access, shell command or ANSI execution. The Pokémon artwork retains its original ownership and is not relicensed under the repository's source license. The existing lifecycle labels remain; the sprite is static.

Verification: 34 focused chat/activity/selection/TUI tests pass; current workspace full suite 402 pass, 5 skip, 0 fail (407 tests, 37 files), typecheck and lint pass. Light/dark fixture renders were inspected. Regression coverage checks role tint/labels, original sprite palette, right alignment across resize, live state and selection/click behavior. Real user-terminal visual acceptance remains separate; no authenticated provider request was used for these checks.

### Welcome-only companion correction (2026-11-15)

User's final request removes the companion entirely from conversations. Chat now uses the full content width, with generic lifecycle text in the header and the existing tool/model status row. There is no sprite, mascot label or reserved rail in a conversation. Welcome renders the actual Weepinbell, using a compact version only when height requires it; clearing a conversation restores welcome. Compact welcome art has bounded bob/sway using the existing motion clock, respecting reduced motion, animation disable, focus pause and speed settings. No runtime asset loading or new dependency.

Tests cover welcome → chat → clear, no conversation art/name, restored transcript width, compact dimensions/movement, frozen/reduced motion and actual sprite palette. Golden snapshots normalize variable elapsed time instead of treating it as layout.

Verification: focused UI/activity/selection tests 36 pass. An isolated snapshot of HEAD plus only this change passes typecheck and unused-symbol checks. Its full suite reports 394 pass, 5 skip, 1 PTY timing failure (`project-context`'s second-turn completion wait); rerunning the entire project-context file passes 11/11. Copilot PTY passes in that isolated snapshot; the shared workspace separately has a subscription transport failure and unused symbols in concurrent security changes. Those files are not part of this UI commit. Golden frames were regenerated against the isolated snapshot to avoid including concurrent provider changes.

### Claude Code transcript and diff review follow-up

Reference: installed Claude Code 2.1.325, latest Hannes terminal conversation inspected directly with Orca terminal inventory and a native-window screenshot. Observed compact tool headers, indented `⎿` results, numbered red/green edit hunks and a separate file list in its diff pane. Only presentation is adopted; no Claude process/tool authority or permission mode is imported.

Hannes now renders compact tool headers/results in that style and previews actual returned patch `changes[].diff` inline, including partial receipts only for files actually changed. Denied/failed payloads cannot produce applied-code previews. `/diff` has a selected file list on wide terminals, numbered wrapped code, red/green surfaces and bounded line/page navigation; narrow terminals show the selected file without the list. Permission previews share the numbered renderer and explicitly remain proposals. The same bounded unified-diff parser handles hunk counts and source lines resembling file headers. No public contract, dispatcher, provider or execution changes.

Verification: isolated HEAD plus only this UI change passes the complete suite (400 pass, 5 skip, 0 fail; 405 tests, 38 files), typecheck and unused-symbol checks. Focused tests cover exact hunk numbers, header-like source lines, long code wrapping, wide/narrow layouts, file/page navigation, denial-default approval previews, actual partial receipts and both direct-provider patch/continuation flows. Light/dark rendered fixtures were inspected. Golden snapshots for this commit were generated in the isolated snapshot; shared-workspace permission/subscription work is excluded.
