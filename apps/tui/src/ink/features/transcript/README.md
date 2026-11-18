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
