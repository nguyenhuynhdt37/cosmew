# GitHub-style themes and theme picker — design

Date: 2026-11-28 · Status: draft, waiting for approval

## Intent

Replace Cosmew's current set of themes with the GitHub (Primer) set and give `/theme` the
GitHub "Appearance" model: one theme, or a day/night pair that follows the system. Every theme
has a full preview in the picker. Performance is the top priority: moving the cursor through the
list must stay instant however long the transcript is.

## What exists today (2026-11-28)

- `apps/tui/src/theme/presets.ts`: Auto/Dark/Light, `*-daltonized`, `*-ansi`, Midnight,
  Parchment. Most tokens are derived from a 3-colour triplet (`deriveTokensFromTriplet`).
- `ThemeEngine` (`apps/tui/src/theme/theme.ts`): `previewTheme()` sets a preview id and calls
  `notify()`. `ThemeProvider` (`apps/tui/src/ink/theme/index.tsx`) bumps a revision and builds a
  new context value, so ~41 files using `useTheme()` re-render, including the whole transcript
  behind the dialog. This is the root cause of slow preview.
- `ThemesDialog` (`apps/tui/src/ink/features/themes/index.tsx`): a 5-row list plus a small
  preview (status line, code block, diff).
- `appearanceSchema` (`packages/contracts/src/models.ts`, contract 1.71): `theme`, `mode`
  (`dark|light|system`), wallpaper, animations, syntaxHighlighting, sidebar. Stored by the
  user-settings AppearanceStore (`apps/cli/src/bootstrap/user-settings.ts`).

## Goals

1. Nine GitHub themes with hand-written tokens from Primer: Light default, Light high contrast,
   Light colorblind (protanopia & deuteranopia), Light tritanopia, Dark default, Dark high
   contrast, Dark colorblind, Dark tritanopia, Dark dimmed.
2. Picker modes like GitHub: **Single theme**, **Sync with system** (separate light theme and
   dark theme, switched by the detected terminal background). Auto stays as the default.
3. Full preview per theme inside the dialog: transcript sample (`❯ prompt`, `⏺ answer`,
   `⏺ Update(path)` + diff), markdown heading/code, status colours (success/warning/error/info),
   syntax-highlighted code, a selection/border sample.
4. Moving the cursor re-renders only the dialog. The app behind it does not change until Enter.

## Non-goals

- GitHub's web UI layout (cards in a grid, browser look). The picker stays a Cosmew panel.
- Custom/user theme editing, wallpapers, new token keys beyond what the preview needs.
- Matching GitHub's colours on 16-colour terminals; ANSI themes cover those.

## Anti-goals (failure even if it "works")

- Any keypress in the picker that re-renders transcript items.
- A theme switch that leaves part of the screen in the old colours after Enter.
- Losing a user's stored theme on upgrade (old ids must map to a new theme, never to an error).
- Pulling `@primer/primitives` in as a runtime dependency.

## Approaches

| | How | Trade-off |
|---|---|---|
| **A (chosen)** | Preview renders inside the dialog under a nested, dialog-local theme context built from the highlighted manifest. The engine's active theme only changes on Enter. | Instant regardless of transcript size; the screen behind does not show the theme while browsing (same as GitHub's preview cards). |
| B | Keep whole-app live preview; memoize transcript items by theme revision, cache ANSI codes, debounce repaint ~50 ms. | Feels like today, more work, still slows with very long transcripts. |
| C | A for the dialog + debounced (~150 ms) whole-app repaint after the cursor rests. | Best of both visually, keeps part of B's cost and complexity. |

The user picked **A**. Precomputing tokens and ANSI escape codes per theme (from B) is also
done because it is cheap.

## Design

### Palettes
- New presets with explicit `dark`/`light` `ThemeTokens` for every key in `THEME_TOKEN_KEYS`,
  taken from Primer functional colours (`@primer/primitives`, MIT). Values are copied into
  `presets.ts`; record source URL, revision/tag and access date in the ADR and in each preset's
  `attribution`, per repo research rules. Each GitHub theme is single-mode (light themes have
  `defaultMode: 'light'`); `dark`/`light` token sets may be identical for single-mode themes.
- Kept: `auto`, `dark`, `light`, `dark-ansi`, `light-ansi`.
- Removed ids map through `normalizeThemeId` (builder's call, editable):
  `midnight → github-dark-dimmed`, `parchment → github-light`,
  `dark-daltonized → github-dark-colorblind`, `light-daltonized → github-light-colorblind`.
- Tokens are frozen at module load; a per-theme cache of fg/bg escape codes per colour
  capability is built lazily on first use.

### Appearance contract
- Add to `appearanceSchema`/`partialAppearanceSchema`: `syncWithSystem: boolean`
  (default `false`; not `themeMode`, because `settings.json` already uses the `themeMode` key
  for `mode`), `lightTheme` (default `github-light`), `darkTheme`
  (default `github-dark`). In `sync`, the active theme = `darkTheme` when
  `systemDarkPreference` is true, else `lightTheme`; `theme` remains the single-mode choice.
- Contract bump to 1.72, ADR `docs/adr/0127-github-themes-and-sync-appearance.md`,
  settings store must preserve unknown keys as today; old settings without the new keys parse
  to defaults.
- In `sync`, `mode` is stored as `system` (our call). With colour capability `none`, the
  picker still saves the choice; only the preview shows "Terminal colors Off".

### Picker (`/theme`)
```
 Theme                          ◉ Single theme  ○ Sync with system
 ❯ Dark default        ┌ Dark default ─────────────────────────┐
   Dark dimmed         │ ❯ fix the greeting                    │
   Dark high contrast  │ ⏺ Update(src/app.ts)                  │
   Dark colorblind     │   - console.log("Hello, World!")      │
   Light default       │   + console.log("Hello, Cosmew!")     │
   …                   │ ✓ Done · ! Warning · × Error · i Info │
                       └───────────────────────────────────────┘
 Tab switch mode · ↑/↓ preview · Enter select · Esc cancel
```
- Wide terminals: list left, preview right. Narrow (< ~70 cols or few rows): preview below,
  compact sample.
- Sync mode shows two slots ("Day theme", "Night theme"); Enter on a theme assigns it to the
  focused slot; the slot matching the current terminal background is marked.
- Onboarding uses the same component in single mode.
- `Code colors On/Off` toggle stays as the first row.

### Performance mechanism
- `ThemePreviewScope`: a `ThemeContext.Provider` whose value is computed from a manifest +
  mode without touching the engine (pure `readTheme`-like function over frozen tokens).
  Wrapped around the preview only.
- `ThemesDialog` no longer calls `engine.previewTheme()` on highlight; highlight is local
  React state. Enter calls `setTheme`/`updateAppearance` once.
- `ThemeProvider` value stays referentially stable unless the engine actually changes.

## Testing and evidence

- Render-count test: with a transcript of ≥ 200 items open behind `/theme`, pressing ↓ 10
  times causes zero transcript item renders (React Profiler or a counting probe).
- Timing benchmark recorded in delivery docs (keypress → frame), before and after.
- Contrast test: every GitHub theme's foreground/background and status colours meet the
  existing contrast checks.
- Migration test: each removed id loads as its mapped theme; settings without new keys load.
- Sync test: flipping `systemDarkPreference` switches between `lightTheme` and `darkTheme`.
- Golden frames for the picker (wide, narrow, sync), re-recorded with review.

## Left to the builder

- Exact Primer token → Cosmew token mapping for keys Primer has no direct equivalent for
  (`composerBackground`, `sidebarBackground`, `scrollbar`), documented in the ADR.
- Breakpoint numbers for wide/narrow layout.
- Whether `/config` → Theme shows the mode as a separate row or just opens the picker.
