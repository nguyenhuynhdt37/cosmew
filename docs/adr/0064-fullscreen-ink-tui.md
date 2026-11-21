# ADR 0064 — Fullscreen Ink TUI

Date: 2026-11-19. Status: superseded by 0065, then reinstated and extended by [0066](0066-claude-code-fullscreen-layout.md). No contract bump, no new dependency, no provider or security API change.

## Problem

The interactive Ink shell was a content-height column. It used terminal columns and ignored rows, so the composer and status followed the transcript instead of sitting on the bottom row. A real 80×24 frame of the trust screen was 10 lines. Dialogs were appended under the full background and could push the permission choices off a short terminal.

ADR 0059 and ADR 0060, and the TUI v3 plan/contract, chose normal scrollback and no alternate buffer, with settled transcript rows in Ink `<Static>`. The user request on 2026-11-19 ("giao diện ko full màn nhìn khó dùng") replaces that scrollback choice for the interactive TTY.

## Decision

1. When `stdout.rows` is a positive number, the interactive shell is a column of that height and the current width. Header stays at the top. The transcript, welcome, plan, notices and subagents share a bounded viewport. The composer and status stay at the bottom. A short terminal drops hints, clamps the composer to one row, and clips the header and status instead of producing a negative height.
2. The same viewport holds an overlay. The background stays mounted but is not painted under the dialog, so a permission or question dialog cannot stack on the full transcript and push its controls off screen. Page Up / Page Down scroll the viewport. The composer draft, keymap, startup consent and account check are unchanged.
3. Interactive `render` sets Ink 8's public `alternateScreen` option. Ink writes the enter sequence and writes the leave sequence on unmount; the existing exit path still unmounts on a normal exit and on SIGINT/SIGTERM. Non-TTY output stays one `renderToString` frame and does not emit terminal control sequences.
4. `<Static>` is not used in that fullscreen tree. Ink replays accumulated static output on every alternate-screen clear, which would duplicate the transcript. The viewport scrolls with Ink's public `contentOffsetY` and `overflowY="hidden"`. The transcript is a tail window (one screen of items, Page Up pulls in older items, capped) and a streaming answer still uses `liveTail`. History inspection and tests that do not report rows keep the previous Static layout. `ink-testing-library` streams have no `rows`, so those tests stay content-sized. A missing row count does not fall back to the host terminal.

## Boundaries

`apps/tui` still depends only on the SDK. Core, contracts, archive and provider adapters are unchanged. No new UI package. Repository settings are not touched.

Linux and Windows terminals, and live provider rendering, are **Needs verification**. This ADR does not claim Product MVP or Claude/Codex parity.

## Verification

`apps/tui/src/ink/testing/fullscreen.test.tsx` renders real Ink frames on a sized stdout: 80×24 trust and ready frames, composer below a blank region, resize to 120×40 and 20×8, a 10-row permission dialog that still shows deny and the reason field, and a scroll viewport whose tail does not repeat static history. `tests/end-to-end/tui-ink-pty.test.ts` is a native PTY: alternate-screen enter then leave, 80×24 consent, resize, narrow input, and process exit 0. One macOS PTY is not evidence for every terminal.
