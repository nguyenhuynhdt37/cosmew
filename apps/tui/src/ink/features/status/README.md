# Pha 1: tui-chrome

Exports (import each feature's index):

- `Header({status, version, width?, preview?, stateLabel?, reactiveEffectsEnabled?})`, `useHeader()`.
- `Welcome({status, width?, greeting?})`, `useWelcome()`.
- `StatusLine({status, context, usage, runningAgents?, branch?, width?})`, `useStatusLine(draft?)`.
- `ContextMeter({context, width?})`, `useContextMeter(draft?)`, `contextPercent`.
- `StartupGate({state, width?})`, `useStartupGate({onReady, onExit, openOverlay, overlayOpen})`.
- `Usage({state, width?, visibleRows?})`, `useUsage({kind?, draft?, onClose, isActive?})`; kinds usage/context/status. Pure report helpers exported here retain old report data and provider limits.

Phase 2 wiring: keep the startup hook mounted for the interactive session; render the gate instead of chat until phase off. Do not mount it in the non-TTY single frame. Shell Esc/exit must call state.exit(), then await state.shutdown() before teardown. onReady runs the requested initial command once (report command errors separately from account verification); connect/models callbacks route through the dialogs agent's components using the host overlay router. The phase-0 contract currently has no named dialog registry; this callback avoids fabricating one. Pass overlayOpen for the actual shared dialog lifecycle. Disable background/global commands while gated; only connect/models may open then. Consent enables tools as in the old gate but does not change security permissions. onReady alone unlocks chat. Gate cleanup aborts checks and revokes consent.

Place StatusLine below composer. The line is two rows: model, effort, permission mode and agents on the first; a ten-cell context bar, tokens and cost on the second. Warnings for bypassPermissions and a disabled sandbox stay on their own rows. Only composer owns Shift+Tab, avoiding duplicate preset changes. Use status report/refresh to populate the SDK Git snapshot: status line only reads the cache after consent. Header accepts existing companion state labels and theme-preview flag from the host. Pass width from the shell for resize. Usage supports D details, R refresh, arrows/page keys, Enter close; shell owns Esc. Reports retain billing coverage, quotas, cache/reasoning counts, model breakdown, project context, terminal capabilities, historical measurements and source caveats. Text uses phase-0 sanitization/wrapping/theme tokens.

Evidence: hermetic Ink tests in chrome.test.tsx, no live-provider or PTY compatibility claim. Full parity/visual acceptance remains phase 2/3 work.

## Pha 2 integration (2026-11-18)

Các mục nối host ở trên được triển khai trong `ink/integrated-shell.tsx` và runtime,
router `ink/features/commands.ts`; API nền version 0.2 trong
[contracts](../../../../../../docs/delivery/tui-v3/contracts.md).
Evidence từng luồng và giới hạn tại
[parity](../../../../../../docs/delivery/tui-v3/parity.md),
`ink/testing/integration.test.tsx`, `tests/end-to-end/tui-ink-pty.test.ts` và
`tests/contracts/sdk-memory-write.test.ts`. Default/golden legacy không đổi.

## TUI v4 phase C

The historical persistent StatusLine described above is now a compatibility
no-op. `ComposerFooter` owns the exact permission mode strings, replacing that
row with temporary messages, a three-column shortcut panel, or a right-aligned
context warning. `contextLeft` only accepts the SDK's `measuredCurrentHistory`
and provider/runtime measurement, subtracts output reserve and uses the existing
90% auto-compaction threshold; stale observations, local estimates and invalid
limits never manufacture a warning. `/usage`, `/context` and `/status` retain
report data. Mode colors reuse phase A's theme aliases (bypass is red).

Phase E removes the inert StatusLine import/render from IntegratedShell.
`useStatusLine` still supplies the one-time welcome banner; the composer owns
the live footer. Host integration and synthetic native PTY verify the two-press
Ctrl+C confirmation without changing startup cancellation or mode policy.

The phase E fix round insets mode, temporary messages and shortcut columns by
two cells; right-aligned context warnings respect the same content inset.
