# Phase 1: transcript integration

Exports are public through each feature's `index.tsx`. No SDK, security, core,
shared Ink API, dependencies or legacy renderer changed in this phase.

- `transcript`: `Transcript({items, width?, isActive?, liveItems?, historyKey?,
focusedId?, onFocusChange?, animate?, historyOffset?})`, memoized
  `TranscriptItem({item, width?, focusedId?, expandedIds?, animate?})` and
  `useTranscript()`. The hook returns `items`, `begin(prompt, id?)`,
  `applyEvent(ModelEvent)`, `finish({error?, cancelled?}?)`, `addNotice(text)` and
  `reset(messages?, sessionId?)`. Pure replay/reducer/window helpers are exported.
- `diff`: `ToolDiff({result?, expanded?, width?})` for actual file receipts;
  `Diff({report, width?, maxLines?, isActive?, onRefresh?, onCopy?})` for `/diff`;
  `useDiff()` returns `report`, `error`, `refresh`. Pure receipt and workspace
  serialization helpers are exported.
- `plan`: `Plan({plan, width?, maxItems?, expanded?})`, `usePlan()` returning
  `plan`, `activeLabel`, plus pure glyph/window/active-form helpers.
- `subagents`: `Subagents({agents, width?, isActive?, maxItems?, onInspect?,
onOpenTranscript?})`, `useSubagents()` returning `agents`, `inspect`, `stop`;
  `tokenTotal()` preserves unknown usage. This compact tree complements the
  separate `/agents` dialog; stopping/message workflows belong to its host.
- `notices`: `Notices({notices, width?})`, `useNotices(limit?)` returning `notices`,
  `addNotice`, `clearNotices`, plus pure compaction/background notice formatting.

## Phase 2 wiring

1. Mount hooks under the existing SDK/theme/overlay providers. `Transcript` and
   `Subagents` go in the transcript slot; `Plan` goes in the plan slot. These
   features never enable tools, send a prompt or grant permissions themselves.
2. After startup/consent/auth gates, call `begin` before consuming the public
   `client.sendMessage()` iterator and feed every event to `applyEvent`. Always
   call `finish` on iterator completion/error/abort. Pass a safe error description;
   cancellation should use `cancelled: true`. SDK owns steering acceptance; only
   its delivered `steered` event inserts the steering message. Route shell tool
   events through the same presentation reducer when composer runs `!command`.
3. Reset on session change/recovery. Change `historyKey` on reset, history edits
   or session switch: Ink Static is append-only. Do not mutate supplied items.
   Already archived messages live in terminal scrollback and cannot expand in
   place. For historical expansion mount a **separate inspection overlay** with
   `historyOffset` (messages back from newest) and a bounded `liveItems` page;
   retain the primary transcript mounted behind the overlay's input scope.
4. Only the active feature owns ↑/↓ and Ctrl+O. `isActive` defaults false; the host
   must choose transcript, composer, subagent tree or an overlay, and disable the
   other owners. Transcript chooses the last activity by default and traverses
   activities with ↑/↓; Ctrl+O toggles only the selected reasoning/tool output.
5. Forward `useNotices().notices` to one notice region for background subagent
   delivery; streamed lifecycle notices already belong to the relevant item.
   Manual `/compact` completion should call `addNotice` on the transcript or
   notices hook. Forward `useDiff().error` to a notice/banner and its refresh/copy
   callbacks to the workspace diff overlay. Clipboard remains host-owned.
6. Use `activePlanLabel()` as the running verb where the host wants the plan's
   `activeForm`. `SubagentSummaryView` supplies depth/steps/tool counts and tokens;
   no percentage is invented because the public contract has no total-step goal.

## Validation and limits

Feature-local tests use the Phase 0 `ink/testing` harness and real public SDK
with hermetic ports. They cover ordered stream/replay, discarded responses,
steering, cancellation, bounded tool output, focused folding/input scopes,
memory citations including split streaming tags and fenced examples, real Ink
Static output over 1,000 lines, bounded inspection of 1,500 messages, receipt
status/partial failure/diagnostics, workspace filtering/navigation/copy, checklist
states, child progress/transcript, and notices. Rendering uses theme color
capability, Ink cell wrapping and `useWindowSize` for terminal resize.

Real PTY resize, visual review, live-provider behavior and latency benchmarking
remain **Needs verification** in Phase 2. Completed history is rendered once into
Static scrollback; the live tail defaults to eight messages. Streaming output is
bounded at 262,144 characters; Markdown/Diff bounds come from Phase 0. No claim
of full TUI parity or provider compatibility is made here.

No Phase 0 API change is required. Phase 2 needs focus arbitration, inspection
paging, session reset keys and host-owned command/cancellation lifecycle wiring.

## Pha 2 integration (2026-11-18)

Các mục nối host ở trên được triển khai trong `ink/integrated-shell.tsx` và runtime,
router `ink/features/commands.ts`; API nền version 0.2 trong
[contracts](../../../../../../docs/delivery/tui-v3/contracts.md).
Evidence từng luồng và giới hạn tại
[parity](../../../../../../docs/delivery/tui-v3/parity.md),
`ink/testing/integration.test.tsx`, `tests/end-to-end/tui-ink-pty.test.ts` và
`tests/contracts/sdk-memory-write.test.ts`. Default/golden legacy không đổi.

## TUI v4 phase B (2026-11-19)

Rows 11–17: muted user rows use the presentation background; assistant Markdown
uses a foreground dot and two-column indent. `toolDisplay()` is the pure mapping
for tool titles/status/summary lines. Counts use returned numbered read lines,
search matches, and applied diff receipts; truncated searches identify partial
results. Denied/error outcomes never become applied changes. The running dot
blinks only when animation is enabled. Diff add/remove backgrounds use
`useUiTheme()` tokens, retaining old/new line gutters and diagnostics.

`Spinner` exports `SPINNER_FRAMES`, `FUTRYN_VERBS`, `spinnerTokens`; it cycles the
specified glyphs forward/back, shimmers the verb, and displays elapsed time and
interrupt help. Transcript passes only SDK `usage.outputTokens` (unknown omitted),
never a word/character estimate. `TodoItems` renders acknowledged Update Todos
calls and live `Plan` rows with checkboxes, bold running work, dim/struck settled
work, and no progress bar. `usePlan()` additionally returns `todosVisible` and
`toggleTodos`; `useTodoVisibility()` is separately exported.

Integration completed in phase E:

- `IntegratedShell` shows `Plan` only while the turn is running and
  `plan.todosVisible`, immediately under the single live spinner. Composer
  Ctrl+T calls `plan.toggleTodos`; overlays disable that input.
- `Transcript` / `TranscriptItem` accept `showSpinner` (default true). The shell
  passes false and owns the spinner after notices/subagents, immediately before
  Plan/composer, using the live item's `startedAt` and `usage.outputTokens` with
  a blank row above it. Standalone transcripts retain their spinner.
- Golden frames reviewed and recorded at 80/36 columns; host integration tests
  assert spinner/todo/composer ordering and visibility without durable mutation.
  Synthetic native PTY covers replay, permission, resize and exit; provider/OS
  compatibility remains separate. See the TUI v4 delivery document.

Tests cover each mapped tool, receipt-derived summaries, Bash folding, nonzero
exit/session/denial distinctions, SDK-only usage, acknowledged/denied todos,
terminal-control sanitization, visibility without durable mutation, and diff
hunks whose source resembles file headers. Visual PTY parity, shimmer appearance,
and authenticated provider behavior remain **Needs verification**.

Phase E fix round: Bash collapsed previews show stdout/stderr before dispatcher
metadata. Nonzero exits get an error heading; expansion preserves the full receipt.
Per-tool duration rows are removed; model-facing/storage content is unchanged.

## Phase G3 (TUI v4 transcript, spec section 3-4)

Source of truth: `docs/delivery/tui-v4/spec.md` and the captures in `docs/delivery/tui-v4/reference/live-120x36`;
`reference-frames.test.tsx` compares rendered rows with those captures.

- Normal view: `UserMessage` (`❯ text` on the user-message background, full row, continuation indented 2, `code` spans in
  the path colour), `⏺ ` + Markdown answers, and consecutive tools of a turn merged by `segmentTools` (`summary.ts`) into one
  dim line (`Listed 1 directory`, `Read 2 files`, `Ran 1 shell command · 1 failed`, `Made 2 edits +3 -1`). A single
  successful edit/write, any denied/errored tool with a reason, and non-file tools keep their `⏺ Name(arg)` +
  `  ⎿  ` entry; Update shows `Added 1 line, removed 1 line` and the numbered diff (`DiffView`), Write shows
  `Wrote N lines` and ten rows then `… +N lines`.
- `detailed` (Ctrl+O): every tool one by one with its full result, reasoning open, and a right-aligned `<time> <model>` line
  before each answer. The shell owns the key: `useDetailedTranscript()` returns `{detailed, toggleDetailed}`.
- End of turn: `✻ <past verb> for 8s · done 11:00 PM` from `durationMs`/`finishedAt` (`formatTime` is injectable);
  `interrupted` renders `  ⎿  Interrupted · What should Cosmew do instead?`. Replayed history has no timing, so no line.
- Spinner: `✻ <Verb>… (7s · ↓ 279 tokens · thinking with medium effort)` + optional `  ⎿  Tip: …`; tokens come only from
  SDK usage, effort only while `thinking`. `turnVerb(seed)` keeps the spinner verb and the past-tense verb paired.
- `Plan`, `Subagents` (`⏺ type(description)` / `  ⎿  Running… | Done (N tool uses · tokens · 8s)`) and `Notices`
  (`  ⎿  note`, `⏺ event`, `backgroundCommandNotice`) share the `ResultLine` connector.
- Gaps: hook output lines (`3 PostToolUse hooks ran`, `<Name> says:`) and background-command completion have no SDK event;
  `↓ to manage` has no backend and is not drawn.
