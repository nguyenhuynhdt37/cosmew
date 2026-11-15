# FUTRYN TUI & Theme Engine — Upstream Research, Keyboard Mapping & Library Evaluation

**Access date:** 2026-11-14
**Scope:** Authorized Stage A–F implementation slice (**TUI1: FUTRYN Terminal UI, Advanced Theme Engine & Live ASCII Wallpapers**) building upon **PA1 (Provider & Authentication)**.

---

## 1. Upstream Repository Investigation

### 1.1 OpenCode (`anomalyco/opencode`)

- **Repository URL:** https://github.com/anomalyco/opencode
- **Inspected commit SHA:** `024a1462f55aa64243b859729b2d0816b42b17e3` (2026-11-14)
- **License:** MIT (`Copyright (c) 2025 opencode`)
- **Inspected paths:**
  - `package.json` (root workspace & dependency catalog)
  - `packages/tui/package.json`
  - `packages/tui/src/app.tsx`
  - `packages/tui/src/routes/home.tsx`
  - `packages/tui/src/routes/session/index.tsx`
  - `packages/tui/src/routes/session/sidebar.tsx`
  - `packages/tui/src/routes/session/permission.tsx`
  - `packages/tui/src/routes/session/composer/index.tsx`
  - `packages/tui/src/context/theme.tsx`
  - `packages/tui/src/component/dialog-theme-list.tsx`
  - `packages/tui/src/component/dialog-model.tsx`
  - `packages/tui/src/component/dialog-session-list.tsx`
  - `packages/tui/src/component/command-palette.tsx`
  - `packages/tui/src/config/keybind.ts`
  - `packages/tui/src/theme/assets/opencode.json` (and built-in theme assets `catppuccin.json`, `dracula.json`, `gruvbox.json`, `kanagawa.json`, `nord.json`, `one-dark.json`, `rose-pine.json`, `tokyonight.json`)

#### Key Architectural Findings from OpenCode
1. **Route & Layout Structure (`app.tsx`, `routes/home.tsx`, `routes/session/index.tsx`)**:
   - Two primary routes: `home` (Welcome screen with centered ASCII branding, status summary, recent sessions, and prompt composer) and `session` (Active chat transcript on the left, collapsible `Sidebar` on the right at width `32`–`36` cols when terminal width $\ge 100$, and pinned `Prompt` composer at the bottom).
   - Overlays/Dialogs (`DialogSelect`, `CommandPaletteDialog`, `DialogThemeList`, `DialogModel`, `DialogSessionList`, `PermissionPrompt`) render above the active route in a modal stack with `Esc` dismissing the top-most overlay or reverting uncommitted previews.
2. **Theme System (`context/theme.tsx`, `theme/assets/*.json`, `component/dialog-theme-list.tsx`)**:
   - OpenCode theme JSON files contain two top-level objects:
     - `defs`: Named color palette primitives (e.g. `darkStep1`..`darkStep12`, `lightStep1`..`lightStep12`, `darkAccent`, etc.).
     - `theme`: Semantic token map (`primary`, `secondary`, `accent`, `error`, `warning`, `success`, `info`, `text`, `textMuted`, `background`, `backgroundPanel`, `backgroundElement`, `border`, `borderActive`, `borderSubtle`, `diffAdded`, `diffRemoved`, `diffContext`, `markdownHeading`, `markdownCode`, `syntaxKeyword`, `syntaxString`, `syntaxComment`, `syntaxFunction`, etc.), where each token is either a hex string or `{ dark: "<def-or-hex>", light: "<def-or-hex>" }`.
   - `DialogThemeList` previews themes live on selection movement (`onMove` / `onFilter`) and restores the initial theme in `onCleanup` if the dialog closes without confirmation (`Enter`).
3. **Permission & Diff UX (`routes/session/permission.tsx`, `feature-plugins/system/diff-viewer.tsx`)**:
   - Permission requests display the normalized action, target resource, risk metadata, and explicit approval scopes (`Allow once`, `Allow for session`, `Deny`). Closing or cancelling never grants permission.
   - Diff viewing supports unified and split views depending on terminal width, with file list navigation (`[`, `]`, `n`, `p`) and line-numbered syntax/diff highlighting.

---

### 1.2 Claude Desktop Themes (`0toshigami/claude-desktop-themes`)

- **Repository URL:** https://github.com/0toshigami/claude-desktop-themes
- **Inspected commit SHA:** `1ac84ea764028dd1be6f8bc808ca18b622bcad2a` (Release `0.8.0`, 2026-11-11)
- **License:** MIT (`Copyright (c) 2026 0toshigami`)
- **Inspected paths:**
  - `README.md`, `LICENSE`
  - `types/index.d.ts`
  - `hooks/themes.ts`, `hooks/register.tsx`
  - `extension/src/core.js`, `extension/src/engine.js`
  - `extension/src/scenes/*.js` (`moonlit.js`, `clawd.js`, `cloud-drift.js`, `honu-lagoon.js`, `koi-pond.js`, `jellyfish.js`, `lantern-night.js`, `fireflies.js`, `neon-rain.js`, `sakura-dusk.js`, `snow-cabin.js`, `star-voyage.js`)
  - `themes/*.css` (`_base.css`, `_wallpaper.css`, `sunset-cloud.css`, `sakura.css`, `terminal.css`, `night-sea.css`, `old-paper.css`)
  - `skills/make-theme/SKILL.md`

#### Key Technical Findings from Claude Desktop Themes
1. **Color Derivation Model (`extension/src/core.js`, `hooks/themes.ts`)**:
   - Each theme specifies three core hex colors (`bg`, `text`, `accent`) plus optional `vars` (`cds-radius*`, `cds-shadow*`, `wall-sky`, `wall-halo`, `wall-glass`, `wall-rim`, `wall-greet`), `font`, `deco` (SVG preview snippet), `wallpaper` (scene ID), and `css`.
   - From `[bg, text, accent]`, `varsOf(t)` derives surface elevation ramps (`mix(bg, text, 0.04..0.14)`), muted/subtle text (`mix(text, bg, 0.25..0.55)`), borders (`mix(bg, text, 0.14..0.28)`), and luminance-based dark/light mode (`luma(rgb(bg)) > 0.5 ? 'light' : 'dark'`).
2. **Built-in Color Themes (5 Presets)**:
   - `sunset-cloud`: `bg: #2b2030`, `text: #f7e8e2`, `accent: #ff8a6b` (Dark violet dusk with warm coral glow).
   - `sakura`: `bg: #fff4f6`, `text: #4b2a35`, `accent: #e0567f` (Light cherry-blossom pink with deep plum ink).
   - `terminal`: `bg: #0a110c`, `text: #b9f6c6`, `accent: #39e87a` (Dark CRT green phosphor tube with sharp square borders).
   - `night-sea`: `bg: #0f1a2c`, `text: #dce6fa`, `accent: #5aaeff` (Deep ocean night blue with starlight and sky-blue wave accents).
   - `old-paper`: `bg: #f2e9d6`, `text: #3a2f22`, `accent: #a5522c` (Light warm ivory parchment with walnut ink and terracotta accent).
3. **Live ASCII Wallpaper Scenes (12 Presets)**:
   - Rendered via a 2-layer architecture:
     1. `cell(x, y, cols, rows, t)`: Background field generator returning `{ ch?, fg, bg?, a, floor? }` for stars, water ripples, hills, rain, snow, buildings, or sun/moon discs.
     2. `sprites(cols, rows, t)`: Foreground animated multi-frame ASCII sprites (`art` + `pal` or procedural `field(gx, gy)`) with optional drop `shadow`, radial `glow`, and loose-character `halo`.
   - **Readability protection (`engine.js`)**: A central column dimmer (`keep(col, px)`) and configurable backdrop `veil` (`0`..`0.95`) attenuate decorative glyph contrast behind the active chat transcript so text remains 100% legible.
   - **Reactive state hooks (`engine.js`, `themes/*.css`)**: Listens for `thinking`, `waiting` (permission), `tool`, `error`, and `done` events (lasting 1.2s for transient events) while respecting `prefers-reduced-motion`.

---

## 2. OpenCode Fidelity & Verified Keyboard / Command Mapping

### 2.1 Slash Commands Parity

| Command | Aliases / Arguments | Behavior in FUTRYN TUI |
|---|---|---|
| `/help` | `/?` | Open keyboard & command reference overlay |
| `/connect` | `/login [account]` | Open guided Provider & Account connection wizard overlay |
| `/model` | `/model [model-id]` | Switch active model directly or open Model Picker if no ID given |
| `/models` | `/models [query]` | Open interactive Model Picker with capability filter & search |
| `/accounts` | `/accounts [alias]` | Open Account Switcher / Manager overlay |
| `/themes` | `/themes [tab]` | Open interactive Theme Picker (`Featured`, `Colors`, `Live`, `My Themes`) |
| `/theme` | `/theme [id] \| edit` | Switch theme by ID, or open the interactive **Theme Editor** (`/theme edit`) |
| `/settings` | — | Open Settings & Appearance configuration panel (mode, wallpaper, motion, speed, cellSize, veil, sidebar, syntax) |
| `/sessions` | — | Open Session Picker overlay (search, create, resume, rename, delete) |
| `/new` | — | Start a fresh session in the current workspace |
| `/resume` | `/resume [session-id]` | Resume a previous session by ID or open Session Picker |
| `/diff` | — | Open Workspace Diff Viewer overlay |
| `/status` | — | Display provider, account, model, session revision, security & capability status |
| `/permissions` | — | Open Permission Queue & Active Policy Inspector overlay |
| `/clear` | — | Clear current screen view / start fresh transcript view |

### 2.2 Keyboard Shortcuts Mapping

| Keybinding | Context | Action |
|---|---|---|
| `Ctrl+P` | Global | Toggle Command Palette |
| `Ctrl+O` | Global | Open Session Picker |
| `Ctrl+T` | Global | Open Theme Picker (`/themes`) |
| `Ctrl+B` | Global | Toggle Sidebar visibility |
| `Shift+Tab` | Global / Composer | Cycle Agent Mode (`Chat` $\rightarrow$ `Plan` $\rightarrow$ `Review`) |
| `/` (at start of composer) | Prompt Composer | Open Slash Command autocomplete popup |
| `@` (in composer) | Prompt Composer | Open Workspace `@file` reference autocomplete popup |
| `Up` / `Down` | Overlay / Picker / Popup | Navigate list items (triggers live preview in Theme Picker) |
| `Up` / `Down` | Prompt Composer | Navigate prompt history when at first/last line |
| `PageUp` / `PageDown` | Chat / Diff / Overlay | Scroll transcript or diff viewport |
| `Tab` / `Shift+Tab` | Theme Picker / Editor / Dialogs | Switch category tab (`Featured` / `Colors` / `Live` / `My Themes`) or focus field |
| `Enter` | Prompt Composer / Picker | Submit message or confirm/apply selection |
| `Alt+Enter` / `Ctrl+J` | Prompt Composer | Insert newline in multi-line prompt draft |
| `Esc` | Global (Priority ordered) | 1. Dismiss autocomplete popup $\rightarrow$ 2. Cancel active modal/overlay (restoring previewed theme) $\rightarrow$ 3. Abort active streaming generation $\rightarrow$ 4. Clear current composer draft |
| `Ctrl+C` | Global | Cancel active generation if streaming; otherwise clean exit restoring terminal state |

---

## 3. Theme Compatibility & Conversion Analysis

| Source Format | Supported Fields | Conversion to FUTRYN Tokens | Unsupported / Refused Features |
|---|---|---|---|
| **FUTRYN Native JSON (`schemaVersion: 1`)** | Full 30 semantic tokens (`dark` & `light` variants), metadata, optional `wallpaper` preset & animation defaults | Direct 1:1 validated mapping via `themeManifestSchema` | Unknown schema versions (> 1) or unknown keys rejected |
| **OpenCode Theme JSON** (`defs` + `theme`) | `defs` palette dictionary, `theme.*` (`primary`, `secondary`, `accent`, `error`, `warning`, `success`, `info`, `text`, `textMuted`, `background`, `backgroundPanel`, `backgroundElement`, `border`, `borderActive`, `borderSubtle`, `diff*`, `markdown*`, `syntax*`) | Resolves `defs` references for both `dark` and `light` modes and maps all 30 FUTRYN semantic tokens | None — 100% color & syntax fidelity preserved |
| **Claude Desktop Themes JSON** (`id`, `name`, `tagline`, `bg`, `text`, `accent`, `vars`, `font`, `deco`, `wallpaper`, `css`) | `id`, `name`, `tagline`, `bg`, `text`, `accent`, `wallpaper` (if matching one of the 12 built-in safe scenes; `clawd` mapped to `futryn-spark`), `vars['wall-halo']`, `vars['wall-rim']`, `vars['cds-radius']` (mapped to border style: `0px` $\rightarrow$ sharp/square, $>0$ $\rightarrow$ rounded) | Algorithmic derivation of all 30 semantic tokens from `[bg, text, accent]` matching `extension/src/core.js` ramps and contrast rules | **Explicitly reported in `CompatibilityReport` and ignored/refused:** CSS font families (`font`), CSS box-shadows (`cds-shadow-*`), raw SVG `deco`, DOM CSS rules (`css`), and arbitrary `.js` scene code execution |

---

## 4. Library & Renderer Evaluation

| Candidate | Version Inspected | License | Evaluation Decision for TUI1 |
|---|---|---|---|
| `@opentui/core` / `@opentui/solid` | `0.8.4` | MIT | Inspected upstream in `anomalyco/opencode`. `@opentui/core` pulls native platform FFI packages (`bun-ffi-structs`, `@opentui/core-darwin-*`) and `@opentui/solid` pulls `@babel/core` runtime transform chains. To guarantee zero native-ABI fragility, deterministic headless frame testing, and 100% compatibility with `Bun.Terminal` PTY and standard POSIX/Windows terminals without expanding the third-party attack surface, `apps/tui` implements a **Native OpenTUI-Compatible Differential Cell Framebuffer & Reactive Component Engine** directly in TypeScript on Bun, adhering to OpenCode's exact layout/theme/keybind architecture while keeping zero external runtime dependencies in `apps/tui`. |
| `zod` | `4.6.7` | MIT | Already approved and installed in PA1; used for strict runtime validation of all theme manifests, appearance configs, compatibility imports, and SDK payloads. |
| `bun:sqlite` | Built-in (`1.4.4`) | MIT | Already approved in PA1; stores durable `appearance` settings and session transcripts in `~/.hannes/provider-auth.sqlite`. |


## Provider Connect command mapping supersession

## Default visual language (2026-11-15)

The default theme `futryn-default` is monochrome and follows the terminal appearance. Dark terminals get black surfaces and white ink. Light terminals get white surfaces and black ink. Components still read `ThemeTokens` only. Before the first message, the original Fyn art is shown small and centered above a narrow composer card. A live thread uses the full terminal with the same inset on every side, and that same small Fyn sits on the composer. No web CSS, font, or script is loaded.

The older OpenCode-oriented slash/keyboard table above is historical. [Current Claude command audit, upstream revisions/doc hashes and explicit keyboard deviations](provider-connect-acceptance.md) are canonical for the Provider Connect rebuild. `/login`, `/model`, `/theme`, `/config`, `/resume` are primary; prior spellings remain aliases. Ctrl+M was replaced by Ctrl+L because ordinary terminals encode Ctrl+M as Enter. The native cell renderer remains in use; no exact OpenTUI compatibility claim is added.

## Codex chat presentation and miniature Fyn follow-up (2026-11-15)

Reference: [Codex TUI styles](https://github.com/openai/codex/blob/65a5410f72dac1f4b40862c34ef0a8b71b12834a/codex-rs/tui/styles.md), `tui/src/streaming/render.rs`, `tui/src/bottom_pane/` and `config/src/types.rs`. Accessed 2026-11-15 through Context7's `/openai/codex` current source index; repository HEAD observed as `65a5410f72dac1f4b40862c34ef0a8b71b12834a`. The dynamic documentation index is not guaranteed to match every line of that HEAD. Adopted presentation conventions: left-aligned prompt marker, readable Markdown, quiet metadata, bottom composer and secondary keyboard/status text. FUTRYN keeps its canonical commands, theme tokens and original renderer; this is a visual adaptation, not a claim of full Codex feature parity.

The miniature companion now has a dedicated 14×10 logical-pixel pose instead of averaging the original 28×24 image into an unreadable thumbnail. Its ears, eyes, feet and tail remain inside a fixed canvas across states. Tail/tapping/blink/status animation respects the existing reduced-motion and focus controls. Layout reserves the entire six-row art/label block, falls back to a compact status header when space is limited, and omits the pet when the terminal cannot fit it. Busy feedback uses real processing/replying state and an Esc hint; no invented tool progress or reasoning trace is shown.

Chat prompts and replies share a left edge. The composer has one input frame with metadata outside it, wraps drafts, scrolls its visible rows to the cursor, and bounds autocomplete by available height. Code lines wrap instead of losing their suffix, and the transcript scrollbar stays on the viewport edge. `/login`, `/model` and `/theme` are the welcome shortcuts. Existing real account/model/session/permission flows remain wired through the SDK; unavailable shell/MCP/plugin capabilities remain explicitly unsupported.

Visual QA used rendered framebuffer cells at 100×30 for welcome and a Markdown/code conversation. Those presentation samples contain synthetic text and do not establish live-provider acceptance. Executable regression coverage is in `tests/contracts/chat-presentation.test.ts`; terminal acceptance is covered separately by the actual `Bun.Terminal` provider/login/chat/cancel/logout tests. No dependency or public contract was added.

Verification: `bun run typecheck` and `bun run lint` pass. `HANNES_TEST_KEYRING=1 HANNES_TEST_COPILOT=1 bun test tests`: **128 pass, 0 fail**, 13 files (includes HTTP integration, native keyring, native Copilot-state roundtrip and actual terminal E2E). After the final narrow-layout adjustment, the 12 chat-presentation/TUI tests also pass, including resize down to 20×10. Authenticated live-provider generation was not repeated for these presentation changes.

## Login/model state audit (2026-11-15)

Read [OpenCode local model state](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/context/local.tsx), branch `dev`, on 2026-11-15: separates `catalogReady` from preferences readiness, keys selection by provider/model, and checks reasoning variants against the selected model. Exact upstream commit could not be obtained (GitHub API returned 404); branch evidence only, revision Needs verification.

Read [Codex model metadata](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs), branch `main`, on 2026-11-15: internal context-window metadata is optional. Internal metadata is not evidence that app-server model/list exposes it. Exact commit Needs verification for the same API limitation.

Stronger local protocol evidence: installed official `codex-cli 0.167.0`; ran `codex app-server generate-ts --out /tmp/hannes-codex-protocol`. Generated `v2/Model.ts` has separate `id` and runnable `model`, `hidden`, and reasoning metadata, but no context-window field. Generated `v2/ThreadTokenUsage.ts` has nullable `modelContextWindow`. Generated files stay outside the repository. No user auth/profile files were read and no billed model requests were made. Therefore a first-login unknown limit must remain explicitly unknown until runtime evidence exists; no model-name-based guessed context sizes are added.

Applied locally: choose Codex runnable slug, filter hidden catalog entries, reject switch completion after the source selection changes, cancel/ignore obsolete model-picker discovery, retain source history while reconnecting another account, and separate account labels from composer shortcuts. These changes add no dependency/public schema and do not establish live vendor acceptance.

Verification: `bun run lint` (includes typecheck) and `bun test tests` pass: **197 pass, 5 skip, 0 fail**, 202 tests across 21 files. New regressions exercise late selection completion, dismissed discovery and Codex first-login runnable-slug/hidden-entry handling through real fixture subprocesses. Opt-in native keyring/runtime checks remain skipped; live account login/model entitlement is not claimed.
