# ADR 0065 — Inline Claude Code layout

Date: 2026-11-19. Status: superseded by [0066](0066-claude-code-fullscreen-layout.md). Originally accepted for implementation by the current user's choice; it superseded ADR 0064's fullscreen and alternate-screen decision. No contract bump, no new dependency, no provider or security API change.

> Superseded by ADR 0066: the capture this ADR relied on was taken in a polluted environment (inherited `CLAUDE_CODE_*` variables forced the reference into inline mode). A clean capture shows the reference is fullscreen. The text below is kept as history.

## Problem

ADR 0064 fixed clipped controls by making the interactive TUI a fullscreen viewport. The user's subsequent 2026-11-19 choice in the [TUI v4 specification](../delivery/tui-v4/claude-code-parity.md) explicitly requests inline rendering like Claude Code. Conversation history must remain in normal terminal scrollback, without a persistent header or an alternate buffer.

## Decision

1. The interactive runtime uses normal Ink rendering without `alternateScreen`. A single append-only `<Static>` owner prints the welcome banner once and commits completed transcript items once. Session resets append new history without replaying previously printed output. Streaming output stays live until completion.
2. A content-height live region follows the static transcript. It holds active output/spinner, todos, notices, menus, dialogs, composer and footer. There is no fullscreen height, transcript tail window, or Page Up / Page Down viewport. The existing explicit history inspection overlay retains its own paging.
3. An open dialog replaces the live composer/footer, with background input disabled and the composer kept mounted to preserve its draft. Shared Panel layout reserves controls before allocating remaining terminal rows to the clipped body. Short-terminal pickers omit descriptions and auxiliary filter/count rows to keep choices visible. Feature dialogs continue to use `useOverlay`; they never start another agent loop or resolve permissions outside the SDK.
4. The persistent product/phase/cwd header and welcome tagline are removed from the integrated shell. The one-time banner has an original three-row Futryn glyph beside the version, model/effort/account and a shortened cwd. Shared Rule, Pointer and presentation theme aliases support the later composer, transcript and dialog phases through the existing ThemeEngine.
5. Startup folder consent, account verification, Esc/shutdown, signal cancellation/draining/unmount and the one-frame non-TTY preview remain. After interactive unmount, an available SDK session gets a dim resume hint. Phase E adds `fyn --resume <id>` as an alias of `fyn resume <id>`; the exit hint uses `fyn --resume <id>`.

## Boundaries

`apps/tui` still depends only on public SDK/contracts. No changes to packages, permissions, settings trust, providers or persistence. Theme aliases are UI-local and do not extend the public theme contract. Existing feature dialogs are adapted through shared UI primitives; phase D can migrate to explicit body/control slots.

## Verification

`apps/tui/src/ink/testing/inline.test.tsx` exercises real Ink with sized streams: static output is emitted once across rerenders, the banner renders at 80/36 columns, permission choices and denial input stay visible at 80×12, and runtime teardown emits a supported resume hint without alternate-screen sequences. Native PTY tests cover consent, SDK interactions, resizing, stream responsiveness and process exit 0 without alternate-screen entry/leave. Non-TTY remains a deterministic single frame. In this environment, the native PTY tests stop before spawning a terminal because the local fixture HTTP servers cannot bind (`EADDRINUSE` on port 0); native execution remains Needs verification. The existing >1000-line transcript test also intermittently reaches its five-second timeout and passes in isolation; transcript rendering performance belongs to phase B.

Source evidence: installed Ink 8.0.0 `build/components/Static.js` and runtime render options, inspected 2026-11-19; the v4 specification records the upstream reference capture and its limits. Linux/Windows terminal behavior and live provider rendering remain **Needs verification**. This ADR does not claim Product MVP completion or complete visual parity; phases B/C/D/E retain their specified work.

Phase F (2026-11-19): dialogs are inline replacements for only the composer/footer and activity spinner. The live transcript tail, subagents, notices and visible todos remain above permission prompts, questions and pickers; input scope still belongs exclusively to the dialog. On short terminals the live tail clips before dialog choices, with bounded context rows. Static remains append-only through opening/answering/closing a dialog. The TUI defaults to Dark when no appearance has been saved; saved Dark/Light/Auto choices still win. Auto reads the terminal's `COLORFGBG` (dark fallback), never macOS `AppleInterfaceStyle`. Semantic palette values and their upstream verification limits are recorded in the specification's Pha F section. Resize consumers share one stream listener, released with the final consumer, instead of adding a listener per transcript row/rule.
