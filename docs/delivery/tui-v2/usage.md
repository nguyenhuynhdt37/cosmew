# TUI V2 usage and architecture

Run `bun run tui` (or installed `fyn tui`). Approve the folder at startup; tool
permissions are separate. No Docker or daemon is needed for the interface.

- Wheel / PageUp / PageDown scroll the conversation. Empty-prompt Home jumps to the
  start; End follows live output. New output while reading appears in the footer.
- Ctrl+O toggles detailed transcript output; Ctrl+R keeps the existing reasoning toggle.
  Click a tool/reasoning header for individual expansion.
- Ctrl+J, Alt+Enter and supported Shift+Enter insert newlines. Enter submits.
  Typing while working creates a draft; Enter steers/queues through the existing SDK.
- Alt+Left/Right (or terminal Ctrl+Left/Right sequences) move by words. Ctrl+W deletes
  the preceding word, Ctrl+U deletes to line start. Shift+Left/Right selects text;
  typing, paste, Backspace and Delete replace the selection at grapheme boundaries.
- Up/Down navigate lines, then prompt history at the edges. Alt+R searches history;
  type a query, Alt+R finds older matches, Enter accepts, Escape restores the draft.
- Slash and file autocomplete retain existing Tab/Enter behavior. Bracketed paste
  stays literal and bounded by the existing 1 MiB guard. `!` uses the existing
  sandbox/approval dispatcher; it never becomes steering input.
- Drag selects transcript text across screens. Streaming continues behind the frozen
  selection; release requests copy. Ctrl+C retries copying, Escape returns to live view.
- `/diff` is a side panel at 140+ columns and a modal below that. Left/Right or Tab
  change files; arrows/pages scroll; A/S/U/N select layers, R refreshes, C copies
  displayed changes, Escape returns to chat. No staging or automatic Git-per-frame.
- `/resume` searches real sessions. Draft and scroll position survive switching
  between up to 20 sessions within the running TUI. Drafts are not written to disk;
  a process restart restores committed session history and follows the bottom.

Rendering path: session events → mutable transcript items + explicit dirty IDs →
exact Fenwick height index → viewport message selection → bounded LRU layouts →
Canvas → ANSI changed rows. The cache has at most 256 entries and 2,000,000 weighted
storage units (UTF-16 text bytes plus approximate span/row overhead). This is a
bounded accounting policy, not a claim that JavaScript heap usage equals 2 MB.
Cold load/width changes measure all message heights once. Theme/render-option changes
also invalidate layouts. Stream events invalidate the current item; typing invalidates
neither transcript heights nor history layouts. A single huge message is still the
layout unit. Source history and the persistent journal are never truncated by this cache.

The frame scheduler keeps one pending frame and a set of dirty regions. Provider
bursts coalesce for 16 ms; input advances the deadline to the next event-loop turn.
Visible status ticks at 1 second, optional welcome animation at 80 ms; idle chat and
unfocused animation have no frame timer. A separate five-second system-theme probe
only requests a frame on a real mode change. Output backpressure pauses paints until
stdout drains, retaining current state rather than queuing rendered frames.

Canvas still composes the fixed screen, and ANSI diffs emit changed rows. Region
tracking does not claim separate retained canvases for every panel. Transcript caches
and status/context caches remove the measured history-sized work. Explicit `/usage`
remains a fresh durable read; status usage is invalidated on lifecycle changes.
The composer context estimate adds local draft-byte overhead; streaming context
refresh is throttled to one second and never presented as exact token accounting.

See [engineering report](report.md), [public UX comparison](references.md), and
[ADR 0039](../../adr/0039-tui-v2-virtualized-transcript.md).
