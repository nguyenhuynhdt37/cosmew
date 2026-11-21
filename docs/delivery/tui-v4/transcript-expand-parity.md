# Transcript item expansion

## Claude Code evidence

Inspected the installed Claude Code 2.1.330 binary at
`~/.local/share/claude/versions/2.1.330` on 2026-11-21. Revision fingerprint
SHA-256 `f7c5093b9dd6560d08af28bc27b123fb55091deae3180ac39df199522da86815`.
Used Python `re.finditer` against an mmap of the binary and bounded byte ranges around matches.
Offsets below are zero-based byte offsets.

| Offset | Static evidence |
| ---: | --- |
| 145540190, 326995451 | Fullscreen help says “Click to expand collapsed tool results”. Adjacent help says selection auto-copies and describes a selection modifier. |
| 145534974, 326789175 | Literal “(ctrl+o to expand)” in diagnostic display. At 299137339 a separate hint resolves the live `app:toggleTranscript` chord and renders “(${key} to expand)”. |
| 292821065 | The default binding maps `ctrl+o` to `app:toggleTranscript`. |
| 292822057, 329082096 | `chat:thinkingToggle` is a Chat action, registered in the prompt controller. The default is Meta+T. This is evidence of a thinking setting action. |
| 292823636, 292823672 | Transcript keymap actions `transcript:toggleShowAll` and `transcript:exit`. Searches for quoted `messages:`, `transcript:` and `chat:` actions did not identify a per-item expansion action. Unquoted `messages:` matches also include JS property names. The action list at 292833491 also contains `chat:attentionUp` and `chat:attentionDown`. The feature filter at 309559458 returns false for both. The scan did not link either to transcript expansion. |
| 327165746, 327175757, 327176866 | Measured virtual rows receive `expanded`, `clickable` and an item click callback. The row click handler honors hyperlink default actions and forwards `cellIsBlank`. Its controller ignores blank cells, opens a closed row immediately, and delays an expanded-row click while selection is dragging. |

**Needs verification** — live Claude behavior for clicking a thinking row, clicking an open item to collapse, clicking an edit or multi-tool group, terminal selection timing and any keyboard-only per-item action. Cosmew uses its existing terminal mouse parser and measured controls. Its focus keys are Cosmew bindings.

## Cosmew behavior

- Plain SGR left-click on a measured label toggles merged groups, standalone tool titles, and reasoning. Modified clicks and wheel reports keep their existing routing. Clicking a tool or reasoning label while it is still receiving events shows the live tail. Ordinary tool result text stays outside the label hit target.
- With an empty prompt, Alt+Up and Alt+Down focus an activity row. Alt+Enter toggles it. The footer and `?` display the configured bindings when applicable. Use PgUp or the wheel to reach earlier activity. The focus keys also work on truncated output controls in the detailed viewer.
- Per-item expansion survives scrolling, tool updates and Ctrl+O. `/clear` resets it. Ctrl+O opens the details directly. Large receipts retain a head/tail preview and offer a separate control for the full captured output. Full output uses the existing scroll viewport.
- The combined “click or ctrl+o to expand” hint is Cosmew wording based on two separate upstream references. Large diffs fold in the middle of each file. The full-output control reveals all captured diff rows.

**Needs verification** — plain-click drag timing on native terminal label text and platform-specific default Alt key encoding. The Ink tests exercise Shift-modified clicks and existing wheel routing. The native transcript PTY case waits for a fresh summary line, sends an SGR click and requires a fresh, complete bash receipt. See test results below.

## Verification

Typecheck and lint passed. The focused TUI run had 384 passes and four skips across 35 files.
It covers SGR and remapped keys, edited-file diffs, running bash and thinking, denied and failed tools,
full-output reveal, scroll persistence, and clearing the session. Existing snapshots passed.

`tests/end-to-end/tui-ink-pty.test.ts` passed two cases. Port-zero listen returned `EADDRINUSE`
before six cases reached the terminal: diff controls, consent and tools, resize, CLI permission
flags, continuous provider streaming, and the transcript SGR/search case. Native SGR receipt
acceptance remains **Needs verification**.

The implementation is in the TUI transcript activity and viewport components, the integrated shell,
the central keymap, and composer help and footer. The tests are in the fullscreen and keys
Ink suites and `tests/end-to-end/tui-ink-pty.test.ts`.
