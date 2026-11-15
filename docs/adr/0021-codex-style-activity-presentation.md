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
