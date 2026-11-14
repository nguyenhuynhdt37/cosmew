# Fyn mascot concept — 2026-11-14

Original design exploration. Follow-up implementation authorized and completed in the TUI1 UI slice on 2026-11-14; see `docs/delivery/fyn-companion.md` for implementation scope and evidence. `fyn-motion.html` remains a standalone in-conversation motion study, not terminal acceptance evidence. The browser preview is not the terminal implementation.

## Inspected references

- `/Users/huynh/.local/bin/hydefetch`: local installed script, inspected 2026-11-14. Calls `pokemon-colorscripts -r`, then `fastfetch`; `--poke`/`-p` prints Pokémon only. No animation loop. Git revision unavailable for this local installation.
- `/Users/huynh/.local/opt/pokemon-colorscripts/pokemon-colorscripts.py`: local installed source, inspected 2026-11-14. Prints stored ANSI colorscript files; regular/shiny and small/large variants. Git revision unavailable; do not infer exact upstream revision or animation support from other similarly named tools.
- `apps/tui/src/theme/wallpaper.ts`: current working tree, inspected 2026-11-14, including uncommitted user work. Existing `SceneSprite`, `frame`, and deterministic time-based scenes could support a future frame atlas. This does not establish mascot support.
- `docs/adr/0006-futryn-tui-and-theme-engine.md` and `docs/delivery/futryn-tui-upstream-research.md`: existing TUI1 architecture and pinned reference evidence. Semantic theme colors, reduced motion, pause while unfocused, and terminal readability remain requirements.

## Proposed identity

Fyn, a small ember fox with large ears and a chevron-shaped tail. Original silhouette inspired by the readability of terminal block sprites, with curiosity and quiet companionship as personality. Consider a blob flame or lantern spirit as alternatives; fox recommended for expressive ears, eyes, tail, and clear poses.

## Proposed motion system

- Idle: 4–6 breathing frames over 2.4 seconds, blink every 4–7 seconds, occasional tail motion. No attention-seeking full-screen wandering.
- Processing: 6–8 frames over 0.8–1.2 seconds, head tilt and tail curl; label as processing, not a claim about private model reasoning.
- Streaming: 4–6 frames over 0.6–0.9 seconds, soft paw taps. No fabricated percentage or token-to-frame coupling.
- Awaiting approval: raise a paw once, then a low-motion held pose until actual resolution. Never auto-dismiss approval or grant permissions.
- Complete: single 0.8-second hop with brief sparks, settle to idle within 1.8 seconds.
- Error: ear drop and a visible exclamation; hold while the error remains unresolved.
- Cancelled: lower tail and stop active work animation; return to idle on a new real transition.
- Sleep: closed eyes after an idle timeout only; never use inactivity alone to imply that an active provider request finished.

Normal illustrative path: idle → processing → streaming → complete → idle → sleep. Approval, failure, and cancellation are alternate branches, not obligatory phases.

## Future implementation boundary

Proposed sprite atlas: 24×24 logical pixels → roughly 24 columns × 12 rows using half blocks; compact ASCII alternative for narrow terminals. Preview is canvas and does not prove terminal cell aspect ratio, ANSI behavior, color fallback, or host compatibility. A production atlas needs separate terminal-oriented frame authoring and width checks. Start with idle, processing, streaming, and complete; wire other states only to available actual SDK signals. General tool execution remains Not implemented in PA1/TUI1.

Reuse the current framebuffer, semantic tokens, shared animation clock, reduced motion, and focus pause. No new dependency or public contract proposed in this exploration. Any future public contract change needs its own ADR/versioning and consumer updates.
