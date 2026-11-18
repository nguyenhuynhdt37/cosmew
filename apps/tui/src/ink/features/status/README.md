# Pha 1: tui-chrome

Exports (import each feature's index):

- `Header({status, version, width?, preview?, stateLabel?, reactiveEffectsEnabled?})`, `useHeader()`.
- `Welcome({status, width?, greeting?})`, `useWelcome()`.
- `StatusLine({status, context, usage, runningAgents?, branch?, width?})`, `useStatusLine(draft?)`.
- `ContextMeter({context, width?})`, `useContextMeter(draft?)`, `contextPercent`.
- `StartupGate({state, width?})`, `useStartupGate({onReady, onExit, openOverlay, overlayOpen})`.
- `Usage({state, width?, visibleRows?})`, `useUsage({kind?, draft?, onClose, isActive?})`; kinds usage/context/status. Pure report helpers exported here retain old report data and provider limits.

Phase 2 wiring: keep the startup hook mounted for the interactive session; render the gate instead of chat until phase off. Do not mount it in the non-TTY single frame. Shell Esc/exit must call state.exit(), then await state.shutdown() before teardown. onReady runs the requested initial command once (report command errors separately from account verification); connect/models callbacks route through the dialogs agent's components using the host overlay router. The phase-0 contract currently has no named dialog registry; this callback avoids fabricating one. Pass overlayOpen for the actual shared dialog lifecycle. Disable background/global commands while gated; only connect/models may open then. Consent enables tools as in the old gate but does not change security permissions. onReady alone unlocks chat. Gate cleanup aborts checks and revokes consent.

Place StatusLine below composer. Only composer owns Shift+Tab, avoiding duplicate preset changes. Use status report/refresh to populate the SDK Git snapshot: status line only reads the cache after consent. Header accepts existing companion state labels and theme-preview flag from the host. Pass width from the shell for resize. Usage supports D details, R refresh, arrows/page keys, Enter close; shell owns Esc. Reports retain billing coverage, quotas, cache/reasoning counts, model breakdown, project context, terminal capabilities, historical measurements and source caveats. Text uses phase-0 sanitization/wrapping/theme tokens.

Evidence: hermetic Ink tests in chrome.test.tsx, no live-provider or PTY compatibility claim. Full parity/visual acceptance remains phase 2/3 work.
