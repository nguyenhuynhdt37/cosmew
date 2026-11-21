# ADR 0079 — Terminal mouse wheel in the fullscreen transcript

Date: 2026-11-21. Status: accepted. Extends ADR 0066's scrolling decision; no SDK/event contract change, package edge or dependency.

## Problem

The TUI used the alternate screen and handled PageUp/PageDown, but did not request mouse reporting. Wheel/trackpad gestures were handled by the terminal, exposing its previous scrollback. Keyboard paging tests did not exercise this path.

## Decision

- During interactive raw input, request normal mouse reporting (DECSET 1000) and SGR coordinates (1006). Decode wheel-up/down into three-row transcript movement. Keep the composer/footer pinned and fetch older transcript windows at the top. Initially ignored clicks; the interaction extension below adds scoped left-press controls. Motion, horizontal wheel and releases remain ignored; mouse cannot approve a dialog. An open overlay disables transcript wheel navigation.
- `apps/tui/src/input/mouse-input.ts` exposes a private stdin facade over public `read`/`setRawMode` methods. Ink remains the sole stdin reader. Do not patch the original stream, install a competing data listener, change flowing mode or import Ink internals. Consume mouse reports before Ink's keyboard/paste parser; preserve other bytes. The incremental decoder bounds pending CSI data, accepts SGR and legacy X10, and treats bracketed paste/OSC/DCS content as data rather than wheel events.
- Tie mouse reporting to Ink's raw-mode ownership. `suspendTerminal` disables it before an external editor or scrollback dump, and resumes it with raw input. Runtime teardown disables reporting, including on errors. Non-TTY output neither creates the facade nor writes mouse control sequences.
- Selection uses the terminal's native mouse override (typically Shift+drag). The terminal's own scrollbar and forced native scrolling are still owned by the emulator. This adds wheel navigation, not app-owned text selection or a scrollbar.

## Evidence and limits

- Ink public APIs: [v8.0.0 readme](https://github.com/vadimdemedes/ink/blob/v8.0.0/readme.md), consulted 2026-11-21 via Context7. Installed `apps/tui/node_modules/ink/build/components/App.js` uses `readable`/`read()` and suspends/resumes through `setRawMode`; it offers no public mouse hook. The facade does not import this private file.
- Protocol reference: [xterm mouse tracking](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking). Implementation is covered by literal SGR/X10 fixtures, split/coalesced input, delayed reports, Unicode, click/release filtering, bracketed paste and terminal strings.
- Real Ink sized-stream tests assert wheel up/down changes transcript position without modifying a draft or moving the pinned composer, and a permission remains pending after mouse events. Native macOS PTY tests exercise wheel reports, mouse enable/disable ordering across a scrollback dump, input after resume and clean exit. These use synthetic SDK ports, not provider generation.
- Physical trackpad gestures and native selection on each terminal emulator, Linux/Windows and terminal scrollbars: **Needs verification**. A terminal that ignores mouse-reporting modes can still perform its own scrolling; no emulator preference is silently rewritten.

## Diff and shared control extension (2026-11-21)

The same decoder now emits a separate optional plain left-press channel. The wheel-only
subscription remains compatible. Components hit-test current Yoga layout coordinates,
ancestor content offsets and clipping through `useMouseTarget`; they do not add stdin
readers or change mouse reporting modes. InputScope disables background targets.
Wheel over the side diff is excluded from transcript navigation. Shared row clicks
only highlight permission/plan/rewind choices; Enter still confirms. Tabs switch views;
diff file/source/close controls perform their displayed local action. Native selection
modifiers, releases, motion, bracketed paste and terminal strings never activate controls.

Tab explicitly moves from composer to side diff; Escape returns through detail/list
to the preserved prompt. Existing modified keys remain available. Actions and footer
labels use the central user keymap. No public SDK/event contract or dependency changes.
Static Claude Code artifact evidence, checked component inventory and runtime limits:
[diff interaction parity](../delivery/tui-v4/diff-interaction-parity.md).
