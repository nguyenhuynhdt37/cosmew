# ADR 0015: TUI feature modules and shared UI kit

Accepted 2026-11-15 at the user's request. Internal restructuring of `apps/tui`; no public contract, package boundary, dependency or storage change. `@futryn/tui` still exports the same names, now from `src/index.ts`.

## Decision

`apps/tui/src/app.tsx` was a 2,600-line class holding every overlay's state, key handling and rendering. It is now a composition root (~400 lines) over independent feature modules:

```
src/
  app.tsx        composition root: input routing, frame assembly, lifecycle
  runtime.tsx    TTY loop        input/ terminal key decoding     render/ frame diff, wallpaper, metrics
  core/          the seams features may use (TuiHost, OverlayFeature, layout helpers)
  ui/            shared kit: Modal, Canvas, list navigation, text-field editing, span types
  features/<name>/  types.ts  logic.ts  view.ts  controller.ts  index.ts
```

Each feature owns one function: overlays (`models`, `connect`, `sessions`, `permissions`, `diff`, `themes`, `theme-editor`, `settings`, `effort`, `reports`, `help`, `palette`), the startup gate, the chat screen (`chat`, `composer`, `transcript`, `companion`, `welcome`, `sidebar`, `header`, `context-meter`), and `commands` (slash routing). `types.ts` holds state shapes, `logic.ts` pure functions, `view.ts` rendering, `controller.ts` key handling and state; `index.ts` is the module's only public entry.

Rules:
- A feature never imports the app class or another feature's internals. It receives a `TuiHost` and may call only what that interface exposes. The two real cross-feature flows (switching account → choosing a model) go through the narrow `AccountWorkflow` and `ModelWorkflow` interfaces in `host.features`.
- Overlays implement `OverlayFeature` (`open`, `close`, `handleKey`, `layout`, `render`, optional `interrupt`, `shutdown`). Adding one means adding a folder and registering it in `FutrynTuiApp.registerFeatures`; no switch statements elsewhere change.
- Dialog frames, padding, clipping and selection arithmetic come from `ui/`. Renderers that fit the dialog pattern use `Modal`; flat renderers (theme picker, connect wizard) build on the shared span types.
- Features that read the workspace declare `needsWorkspace`; the app refuses to open them until the folder is approved.

## Behavior changes in the startup gate (amends ADR 0014)

- With no model selected, startup loads the model list (no generation, nothing billed) and opens the picker, instead of spending a generation request first. Dismissing the picker returns to the account chooser rather than re-running a billed check.
- A failing initial slash command is reported as a command error and no longer reopens the account chooser.
- `submitPrompt` sends nothing while the gate is active.
- Workspace reads (`/diff`, `@` file suggestions) stay locked until the user approves the folder, and in non-TTY runs, which cannot ask.
- The chooser cursor is clamped when the account list changes; gate rows can no longer overwrite the footer.

## Evidence and limits

`tests/contracts/tui-golden.test.ts` records 66 rendered frames (every overlay and the chat screen at three terminal sizes) from the pre-refactor code and must match byte for byte; all earlier frames are unchanged. Feature modules are unit-tested against a hand-written `TuiHost` (`startup-gate-module`, `commands-module`). Real-terminal acceptance on iTerm/Kitty/Windows Terminal remains Needs verification, as in the provider-connect acceptance record.
