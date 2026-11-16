# ADR 0039 — TUI V2 indexed transcript and event-driven frames

Date: 2026-11-17. Status: accepted for implementation by the TUI V2 master task.

Retain Bun/TypeScript, Canvas, ANSI row diffs, SDK events and existing security boundaries.
Measured baseline at 120×40 on M1 Pro: 5,000 messages require 340 ms median layout,
versus approximately 1.3 ms Canvas and 0.23 ms ANSI diff. Replacing the UI framework
would not address the measured cause. A flat formatted history cache would retain
unbounded styled rows and continue scanning history; choose an exact height index
with bounded LRU message layouts instead.

TranscriptLayout owns ordered message identities, revisions, a Fenwick height index,
and a cache bounded by both entries and weighted text storage. Cold load and width changes measure
all messages once for exact scroll height. Routine frames select intersecting messages
by indexed offsets; explicit dirty IDs update only changed entries. Stable item/row
anchors survive append, expansion, and width changes; -1 remains bottom-follow mode.
Cold/resize work is disclosed separately from steady-state latency. Source history is
never truncated. Large single-message layout remains a separate limitation.

Selection freezes a lazily rendered document only on explicit selection, preserving
redacted text across screens without retaining a full formatted history every frame.
The runtime coalesces dirty reasons into one pending frame, lets input preempt a delayed
provider frame, and schedules only visible animation/status work. Output backpressure
pauses frame writes, not domain event consumption; approval/completion state remains
in the SDK and chat controller. Async local UI mutations notify the scheduler.

Context meter refreshes on state events rather than serializing history per keystroke;
draft byte overhead is added locally and labelled estimated. No provider, journal,
permission, diff collection or persistence schema changes. Session drafts/positions
are process-local; durable draft persistence requires a separate privacy contract.

Fullscreen is the supported interactive renderer. Classic scrollback requires a
separate append-only writer/selection contract and is not exposed as a fake mode.
Windows command execution remains fail-closed under ADR 0035; terminal portability
does not imply Windows sandbox support. No dependencies, daemon, Docker, subagents,
MCP or plugins added to Futryn.

Implementation and evidence: [delivery](../delivery/tui-v2/report.md).

Local TUI diagnostic API version: private package `@futryn/tui` moves to 0.2.0.
Snapshot consumers use `totalLines` and the lazy `freeze()` document instead of
assuming `TranscriptViewport.lines` contains history. The deprecated viewport
`allLines` export remains available as an explicit lazy full-document diagnostic.
All in-repository consumers are migrated. Wire/event/settings contract stays 1.18;
there is no persisted data migration or recovery format change.
