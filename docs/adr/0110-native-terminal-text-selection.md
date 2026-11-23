# ADR 0110 — Native terminal text selection

Accepted: 2026-11-22. UI/input behavior only; no shared event/SDK wire change or dependency.

## Problem

Cosmew enables xterm 1000/1006 mouse reporting for wheel navigation and clickable controls. Terminals then send drag/button events to the app instead of providing ordinary text selection. ADR 0079 documented terminal-specific modifier overrides, but these are not discoverable and differ across emulators.

## Decision

Add the remappable Global action `app:toggleTextSelection`, default Ctrl+Q. Selection mode explicitly disables Cosmew-owned mouse reporting while keeping Ink's raw keyboard input, running requests, pending approvals, session and draft intact. The terminal owns drag selection and Cmd+C (macOS) or its usual copy shortcut. Ctrl+Q restores mouse interaction. Mode is session-only and does not write settings. `/copy [N]` remains available for whole-response/code-block copying.

Keep decoding/consuming trailing mouse reports even while reporting is off, but suppress their wheel/click callbacks so they cannot enter a draft or activate a control. Suspending the terminal/editor must not reenable mouse reporting while selection mode remains active. Cleanup leaves reporting disabled. The app does not add a competing stdin reader or import private Ink APIs.

A persistent hint describes active selection mode, including while a dialog is open. Its row is deducted from dialog layout. The mode does not freeze or cancel model work; streaming text can still change while the terminal selection is active. `/copy` is preferable for a complete response during ongoing streaming.

F6 was considered but Ink's public input API does not expose function keys consistently. Ctrl+X M was rejected by a test: the existing permission dialog uses Ctrl+X to revoke grants. Ctrl+Q passed the same pending-approval/draft test without revocation.

## Verification

Transport tests verify exact 1000/1006 disable/enable bytes, unchanged raw-mode ownership, ignored trailing mouse events, preserved Unicode/keyboard input, editor suspend/resume and disposal. UI tests exercise the real remappable key router, pending approvals, draft preservation and a still-running model response. The native macOS PTY checks that toggling selection emits mouse-disable sequences without leaving the alternate screen or ending the app, then restores reporting and normal operation.

Source reference inspected 2026-11-22: installed Ink 8.0.0 public README/useApp/suspendTerminal and useInput notes (`apps/tui/node_modules/ink/readme.md`). xterm tracking reference: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking. Actual OS-native drag/Cmd+C behavior in Orca and every emulator remains **Needs verification**; protocol and PTY assertions do not simulate a physical mouse selection. No live user processes, clipboard contents or user databases were modified by this task.

Final checks: typecheck, scoped formatting and diff checks passed. Mouse decoder/keymap/Ink integration: **49 passed, 0 failed**, 1,267 assertions. Native PTY: **1 passed, 0 failed**, 38 assertions. An earlier combined run hit the unchanged real-user-state guard while the live Cosmew database changed; the guard stayed enabled, no database was restored, and the final focused runs passed with the guard enabled.
