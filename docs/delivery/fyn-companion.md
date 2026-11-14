# Fyn — FUTRYN terminal companion

Implemented within the user-authorized TUI1 slice on 2026-11-14. Fyn is an original ember fox with large ears and a chevron tail. UI presentation only: no new domain contracts, dependencies, persisted settings, or package edges.

## Usage

From the repository root, run `bun run tui` (or `hannes tui` when the CLI is installed). The welcome screen shows a theme-colored 28-column × 12-row half-block sprite plus a state label when space permits. Smaller welcome layouts use a three-line ASCII fox. During chat, a compact fox appears immediately above the composer on terminals at least 24 rows high; shorter layouts reserve space for messages and input instead.

Existing `/settings` animation controls govern Fyn: Enabled, Speed, Reduced Motion, Pause When Unfocused, and Reactive Agent Effects. Disabled/reduced motion keeps a static pose while state labels still update. Reactive effects off uses a neutral idle presentation. No wallpaper is required. The existing `themes wallpaper none` command also disables animations; use `bun run hannes themes animation --enabled true` to restore pet motion without a wallpaper on the default color theme.

## Lifecycle and ownership

`apps/tui/src/components/mascot.ts` owns the private presentation clock, state machine, and original block sprite. `apps/tui/src/app.tsx` derives state from its actual SDK-backed turn lifecycle:

| State | Trigger / lifetime |
|---|---|
| ready | Initial state; follows a terminal outcome |
| processing | A submitted turn is awaiting response text |
| replying | Actual text deltas arrive; stays active regardless of elapsed time |
| awaiting approval | SDK queue contains a pending, unexpired approval; no automatic resolution |
| complete | Explicit completed event and successful stream termination; happy eyes and sparkle cue (full sprite can hop), settle within 1.8 seconds |
| error | Request fails or stream ends without completion; held until next turn |
| cancelled | Abort settles / SDK reports cancellation; never celebrates success |
| sleeping | 60 seconds of idle time; ordinary key input wakes Fyn |

Pending approvals override the displayed pose without mutating the queue or granting capabilities. Permission UI demonstration requests remain demonstrations; shell/filesystem tool execution is still **Not implemented** in PA1/TUI1. This feature does not infer hidden model reasoning or claim tool execution from descriptor events.

The existing differential framebuffer handles color degradation and output. The shared 80 ms UI timer advances Fyn even without wallpaper and refreshes provider/state changes while asynchronous submission is pending. Motion is frozen when disabled, reduced, or paused by the existing wallpaper engine's focus policy; lifecycle time still advances so completion does not stick forever with motion off.

## References and evidence

Reference inspection date: 2026-11-14. Local `/Users/huynh/.local/bin/hydefetch` calls `pokemon-colorscripts -r` followed by Fastfetch. The installed `/Users/huynh/.local/opt/pokemon-colorscripts/pokemon-colorscripts.py` prints stored ANSI files; neither inspected code path contains an animation loop. Exact installed upstream revision: **Needs verification**, because no Git metadata was present. The reference informed block-sprite readability; Pokémon assets were not copied. Existing pinned TUI references remain in [TUI1 research](futryn-tui-upstream-research.md).

Validation:

- `bun run typecheck`: passed.
- `bun test tests`: 73 passed, 2 skipped, 0 failed; skipped tests require opt-in native keyring verification.
- `tests/contracts/mascot.test.ts`: lifecycle invariants, approval override, cancellation/completion settling, active-turn sleep prevention, motion freeze, theme palette and bounded glyph output.
- `tests/end-to-end/tui.test.ts`: actual SDK/provider HTTP fixtures for streaming, cancellation, error and success; focus/reduced motion, idle wake, queued approval, small layouts; actual macOS PTY subprocess for animation without wallpaper, monochrome output and Ctrl+C restoration.

PTY evidence verifies subprocess behavior on the test host, not a manual visual review in iTerm/Kitty/Windows Terminal or authenticated live-provider compatibility. Those checks remain **Needs verification**; Product MVP acceptance is unchanged.
