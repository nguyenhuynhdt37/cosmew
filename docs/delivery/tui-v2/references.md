# TUI V2 public UX evidence

Inspected 2026-11-17 (Asia/Ho_Chi_Minh). Fresh `git ls-remote ... HEAD` pins:

| Reference | Inspected revision | Public evidence |
|---|---|---|
| Claude Code | `8a17c18509e5b76f8f3029d47d2538c99f6930ed` | [CHANGELOG.md, v2.1.325](https://github.com/anthropics/claude-code/blob/8a17c18509e5b76f8f3029d47d2538c99f6930ed/CHANGELOG.md). Public releases/docs; no access to its private TUI implementation. |
| Codex | `fef47a6769414444b1ce37aa8188b55bf2624f27` | [codex-rs/tui/src/transcript_view.rs](https://github.com/openai/codex/blob/fef47a6769414444b1ce37aa8188b55bf2624f27/codex-rs/tui/src/transcript_view.rs): entry caches, visible rows, content anchors. Design comparison, not copied code. |
| OpenCode | `0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4` | [packages/tui/src/util/scroll.ts](https://github.com/anomalyco/opencode/blob/0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4/packages/tui/src/util/scroll.ts): configurable fixed/accelerated scrolling. Retain predictable fixed wheel steps here. |

Official documentation is rolling, accessed on the date above, not falsely assigned a
Git revision. HTML was accessible via web browsing; direct local `.md` downloads
returned HTTP 403. Old OpenCode `/docs/tui/` redirects to V1; use the latest page below.

| Category | Public documented reference | Futryn decision / evidence |
|---|---|---|
| Fullscreen, composer position, visible-message rendering | [Claude fullscreen](https://code.claude.com/docs/en/fullscreen) | Indexed viewport, fixed composer; exact cold height measurement; bounded styled working set. Tests: transcript-virtualization, tui-performance. |
| Compact/verbose, activity, streaming | [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode) | Retain real event-driven cards; Ctrl+O expands details, Ctrl+R retains reasoning shortcut. No fabricated reasoning or completion. |
| Multiline, word editing, history, paste, shell, queued input | [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode) | Ctrl+J/Alt+Enter/Shift+Enter, graphemes, word keys, Shift selection, Alt+R history search (Ctrl+R compatibility retained); SDK steering/queue and sandboxed `!` retained. |
| Mouse, clipboard, transcript navigation | [Claude fullscreen](https://code.claude.com/docs/en/fullscreen) | Wheel/page, empty-composer Home/End, disclosure clicks, frozen cross-screen copy. Composer click positioning/menu mouse activation remain gaps. |
| Terminal-specific keyboard, tmux, SSH, Windows | [Claude terminal configuration](https://code.claude.com/docs/en/terminal-config) | Portable Ctrl+J fallback, raw decoder tests, focus events, OSC52/native mac clipboard. No host terminal configuration writes. Only macOS PTY executed. |
| Plan, review, status, configuration | [Claude workflows](https://code.claude.com/docs/en/common-workflows), [settings](https://code.claude.com/docs/en/settings) | Retain current real SDK modes/commands/settings; wide diff panel, modal on narrow screens; Git collection unchanged. |
| Resume, session navigation | [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode), [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | Existing searchable session picker and durable reconstruction; add process-local session drafts/scroll positions. No replay. |
| Rewind/checkpoints | [Claude checkpointing](https://code.claude.com/docs/en/checkpointing) | Existing safe fork retained; no workspace snapshot/restore backend added. Rewind unavailable. |
| Background tools and tasks | [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode) | Existing owned command-session IDs/status retained. General task scheduler/subagent navigation unavailable; no pretend task UI. |
| Classic scrollback, alternate layouts | [Claude fullscreen](https://code.claude.com/docs/en/fullscreen), [latest OpenCode TUI](https://opencode.ai/docs/cli/tui/) | Fully supported fullscreen path first. Classic append-only writer requires separate implementation; no misleading toggle. |

This is an evidence-based design comparison, not a claim of full Claude Code parity
or a claim of executing Claude Code/OpenCode interactively on this host.
