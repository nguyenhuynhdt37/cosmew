# ADR 0006: FUTRYN Terminal UI, SDK Protocol, and Advanced Theme Engine (TUI1)

**Status:** Accepted 2026-11-14
**Scope:** Authorized expansion from PA1 (`contracts`, `models`, `security`, `persistence`, `core`, `apps/cli`) to include **TUI1** (`packages/sdk`, `apps/tui`, and corresponding extensions in `packages/contracts`, `packages/persistence`, `apps/cli`, `tests`, and `docs`). Unrelated subsystems (`tools`, `workspace`, `mcp`, `extensions`, `compat-opencode`, `compat-deepseek`, `code-intel`, `agents`, `apps/server`) remain untouched at their Phase 0 placeholders.

---

## 1. Context

The user authorized building the production-oriented **FUTRYN Terminal UI (TUI)** and **Advanced Theme & Live ASCII Wallpaper Engine** as a complete Product MVP (`TUI1`), using `anomalyco/opencode` (`024a1462f55aa64243b859729b2d0816b42b17e3`) as the primary UI/UX reference and `0toshigami/claude-desktop-themes` (`1ac84ea764028dd1be6f8bc808ca18b622bcad2a`) as the personalization and live ASCII wallpaper reference.

Key architectural constraints from [ADR 0002](0002-contracts-first.md), [ADR 0004](0004-security-boundary.md), [ADR 0005](0005-provider-auth-product.md), and [dependency-rules.md](../architecture/dependency-rules.md):
- `apps/tui` may only depend on `@futryn/sdk` and `@futryn/contracts`. It must never directly import `@futryn/persistence`, `@futryn/models`, `@futryn/security`, `@futryn/core`, or third-party AI SDKs.
- `packages/sdk` may only depend on `@futryn/contracts`.
- `apps/cli` acts as the composition root wiring `persistence`, `security`, `models`, `core`, `sdk`, and `tui`.
- No arbitrary JavaScript or CSS from imported themes may ever be executed.

---

## 2. Decisions

### 2.1 Strict Architectural Ownership & SDK Client Boundary
- `packages/sdk` implements `FutrynClient` (`HannesClient`), a pure protocol/facade client backed by ports injected from the composition root (`apps/cli/src/bootstrap/startup.ts`).
- `apps/tui` communicates exclusively with `FutrynClient` for:
  - Provider, Account, and Model catalog queries, validation, and selection.
  - Session creation, listing, searching, resuming, renaming, deletion, and streaming message turns with `AbortSignal` cancellation.
  - Global and per-project `appearance` configuration persistence and custom theme file storage.
  - Read-only workspace file listing (`@file` references) and Git diff inspection (`/diff`) bounded to the active workspace directory.
  - Permission prompt queue inspection and explicit scoped resolution (`Allow once`, `Allow for session`, `Deny`).

### 2.2 Schema-Validated Design System & Theme Engine
- Every visual component in `apps/tui` consumes a centralized 30-token semantic `ThemeTokens` record validated by Zod (`packages/contracts/src/models.ts`). No component hardcodes hex or ANSI colors.
- Built-in themes (15 total: 5 adapted from Claude Desktop Themes + 10 established terminal palettes with MIT/permissive attribution) are immutable in memory.
- Custom themes and imported themes (FUTRYN native JSON, OpenCode JSON, and Claude Desktop Themes JSON) are validated, converted with an explicit `CompatibilityReport`, and persisted atomically (write-temp + fsync + rename with `0600` permissions) in `~/.hannes/themes/`.
- Malformed or corrupted theme files emit a non-fatal diagnostic event (`ThemeError`) and gracefully fall back to `futryn-default` without preventing startup or interrupting active sessions.

### 2.3 Declarative Terminal-Safe ASCII Wallpaper Engine
- The 12 animated ASCII scenes (`moonlit`, `futryn-spark` [with `clawd` compatibility alias], `cloud-drift`, `honu-lagoon`, `koi-pond`, `jellyfish`, `lantern-night`, `fireflies`, `neon-rain`, `sakura-dusk`, `snow-cabin`, `star-voyage`) are implemented as pure, deterministic TypeScript scene descriptors inside `apps/tui/src/theme/wallpaper.ts`.
- Importing a theme never executes `.js` files or injects DOM CSS.
- The renderer composites the wallpaper layer behind UI panels, applies a configurable center readability `veil` (`0.0`–`0.95`) and minimum contrast floor, supports `smooth` (sub-cell phase shading) and `grid` (cell-aligned) motion modes, respects `reducedMotion`, pauses when unfocused or on narrow/unsupported terminals, and throttles frame rate during active streaming or heavy keyboard input.

### 2.4 Differential Terminal Framebuffer & Terminal Hygiene
- `apps/tui` renders via a 2D cell framebuffer (`CellBuffer`) with differential ANSI output and DEC synchronized updates (`\x1b[?2026h` ... `\x1b[?2026l`), eliminating full-screen redraw flicker.
- Truecolor (24-bit RGB) automatically degrades to 256-color, 16-color ANSI, or monochrome based on detected terminal capabilities (`COLORTERM`, `TERM`, `NO_COLOR`).
- Untrusted model/tool/diff text is sanitized via `terminalText` (stripping C0/C1/CSI/OSC escape sequences) before entering the cell buffer.
- Normal exit, `SIGINT`/`SIGTERM`, and uncaught exceptions deterministically restore terminal raw mode, cursor visibility, focus reporting, and alternate screen buffer.

---

## 3. Consequences & Revisit Conditions

- **Zero new external npm dependencies required:** TUI1 runs on the already audited PA1 dependency set (`bun@1.4.4`, `typescript@7.0.2`, `zod@4.6.7`).
- **Explicit backend capability reporting:** Because general tool execution (`packages/tools`) and remote server transports (`apps/server`) remain unimplemented in PA1/TUI1, the TUI displays real tool-call descriptors/summaries when emitted, provides a working Permission Dialog wired to the SDK permission gate, and clearly labels general shell/filesystem tool execution as `Not implemented in PA1/TUI1 backend` rather than faking tool timelines.
- Future phases introducing `packages/tools` or `apps/server` will plug into `FutrynClient` ports without changing `apps/tui` component contracts.
