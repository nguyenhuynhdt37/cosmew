# Cosmew Full Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Cosmew the canonical product, package, CLI, state, and TUI brand while preserving old commands and user state through explicit compatibility aliases.

**Architecture:** Keep one CLI/TUI composition root and one package dependency graph. Rename internal workspace identities and imports to `@cosmew/*`, centralize compatibility resolution for commands, environment variables, settings roots, and state directories, and leave persisted provider/session identifiers untouched. Add a terminal-native astronaut-cat renderer shared by the header and declarative wallpaper engine.

**Tech Stack:** Bun 1.4.4, TypeScript, React 19, Ink 8, Bun SQLite, existing theme/wallpaper renderer, Bun test runner, Prettier.

**Spec:** `docs/superpowers/specs/2026-11-21-cosmew-rename-design.md`

## Global Constraints

- Cosmew is canonical; `fyn`, `futryn`, and `hannes` remain compatibility executables.
- `COSMEW_HOME` and `COSMEW_*` are canonical; `FUTRYN_*` then `HANNES_*` are read-only fallbacks.
- State discovery is deterministic (`COSMEW_HOME` → `FUTRYN_HOME` → `HANNES_HOME`; otherwise `~/.cosmew` → `~/.futryn` → `~/.hannes`) and never copies or merges credentials.
- Persisted provider IDs, SQLite schema/table names, keyring service identity, event names, and error codes remain unchanged.
- `CosmewError` is canonical; `FutrynError` and `HannesError` remain aliases to the same constructor.
- The public contract version advances from `1.39` to `1.40`.
- No new dependency, raster asset, external agent runtime, or public package publication is introduced.
- Do not commit or reset the pre-existing dirty working tree; verify changes with scoped diffs.

## Review Focus

- A user with only `~/.futryn` or `~/.hannes` must start Cosmew without a database copy or credential rewrite. Test in Task 1.
- Conflicting `COSMEW_HOME`, `FUTRYN_HOME`, and `HANNES_HOME` values must follow the documented precedence. Test in Task 1.
- Existing `fyn`, `futryn`, and `hannes` invocations must reach the same CLI dispatcher and help output. Test in Task 2.
- A reduced-motion or narrow terminal must render a stable, readable mascot without changing transcript layout. Test in Task 4.
- Historical persisted error/event values must remain parseable after the contract bump. Test in Task 5.

### Task 1: Canonical naming, state roots, and error compatibility

**Files:**
- Modify: `apps/cli/src/bootstrap/paths.ts`
- Modify: `apps/cli/src/bootstrap/host-config.ts`
- Modify: `apps/cli/src/bootstrap/permission-settings.ts`
- Modify: `packages/security/src/tool-policy.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/models.ts`
- Create: `tests/contracts/cosmew-compatibility.test.ts`

**Interfaces:**
- Produce `defaultStateDirectory(environment, home)` with Cosmew-first precedence and legacy fallback.
- Produce canonical `CosmewError` and identity aliases `FutrynError`/`HannesError`.
- Produce contract version `1.40` for headless envelopes.

- [ ] **Step 1: Add failing compatibility tests** for state precedence, no-copy selection, error-constructor identity, and contract version `1.40`.
- [ ] **Step 2: Run `bun test tests/contracts/cosmew-compatibility.test.ts`** and confirm failures identify the missing Cosmew behavior.
- [ ] **Step 3: Implement the canonical state/env/error helpers** without changing persisted schema or keyring service names.
- [ ] **Step 4: Update security path protection and project settings discovery** to recognize `.cosmew` alongside `.futryn` and `.hannes`, preserving deny behavior.
- [ ] **Step 5: Run the focused compatibility test** and confirm it passes.

### Task 2: Rename the workspace package graph and CLI surface

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `apps/cli/package.json`
- Modify: `apps/tui/package.json`
- Modify: `packages/*/package.json`
- Modify: all TypeScript imports currently using `@futryn/*`
- Modify: `apps/cli/src/index.ts`, `apps/cli/src/exec.ts`, and CLI bootstrap entry points
- Modify: `scripts/*.ts`, `tests/**/*.ts`

**Interfaces:**
- Produce package identities `cosmew` and `@cosmew/*` throughout the workspace.
- Produce canonical `cosmew` scripts/bin entries plus compatibility `fyn`, `futryn`, and `hannes` entries.
- Keep a single CLI entry point and dispatcher.

- [ ] **Step 1: Add CLI branding tests** asserting canonical `cosmew --help` and all three legacy aliases resolve to the same entry point.
- [ ] **Step 2: Run the focused CLI branding tests** and capture the expected failures.
- [ ] **Step 3: Rename package metadata and internal imports** with a scoped, reviewable codemod; preserve non-product third-party scopes and historical text fixtures.
- [ ] **Step 4: Add root workspace alias dependencies** using Bun's `workspace:@cosmew/<name>@*` form for `@futryn/*`, so old package imports resolve to the renamed private workspaces without duplicate implementations.
- [ ] **Step 5: Update Bun workspace lock metadata** and package scripts/binaries so `bun install --frozen-lockfile --ignore-scripts` remains valid.
- [ ] **Step 6: Run `bun install --frozen-lockfile --ignore-scripts` and `bun run typecheck`**; fix only rename-related failures.
- [ ] **Step 7: Run the CLI branding tests** and confirm canonical plus compatibility invocations pass.

### Task 3: Rename current product text, environment documentation, and ADR history

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/README.md`
- Modify: current subsystem and delivery docs containing active Futryn/Hannes branding
- Create: `docs/adr/0076-cosmew-project-rename.md`
- Modify: help/prompt/status strings under `apps/cli/src` and `apps/tui/src`

**Interfaces:**
- Produce current user-facing documentation that names Cosmew and documents aliases/migration.
- Preserve historical ADR titles and quoted decisions; link them to ADR 0076 instead of rewriting history.

- [ ] **Step 1: Add a documentation/branding grep check** that fails on active product strings outside explicitly listed historical paths and compatibility constants.
- [ ] **Step 2: Add ADR 0076** with the accepted rename, compatibility boundaries, contract bump, state precedence, and keyring decision.
- [ ] **Step 3: Update active docs, help text, prompt labels, and status copy** to Cosmew; keep legacy names only where they describe compatibility or history.
- [ ] **Step 4: Run the grep check and `git diff --check`**; inspect every exception rather than doing an unrestricted global replacement.

### Task 4: Implement the astronaut-cat dot-matrix mascot

**Files:**
- Create: `apps/tui/src/theme/cosmew-mascot.ts`
- Modify: `apps/tui/src/ink/features/header/index.tsx`
- Modify: `apps/tui/src/theme/wallpaper.ts`
- Modify: `apps/tui/src/theme/theme.ts` only if the renderer needs a shared palette hook
- Test: `apps/tui/src/ink/features/status/chrome.test.tsx`
- Create: `apps/tui/src/theme/cosmew-mascot.test.ts`

**Interfaces:**
- Produce immutable mascot frames/palette and `renderCosmewMascot(options)` (or an equivalent typed renderer) for header and wallpaper use.
- Support `reducedMotion`, narrow widths, theme colors, and deterministic frame selection.

- [ ] **Step 1: Write mascot tests** for frame determinism, reduced-motion freezing, width fallback, and absence of unbounded ANSI/control output.
- [ ] **Step 2: Run the mascot tests** and confirm they fail before the renderer exists.
- [ ] **Step 3: Implement the 7–11 column astronaut-cat dot matrix** using `·`, `•`, `●`, and `█`, with three subtle frames and the active theme palette.
- [ ] **Step 4: Replace the text-only header mark** with the mascot plus Cosmew label while retaining status/model lines and narrow wrapping.
- [ ] **Step 5: Reuse the same frame/palette data in the `futryn-spark` scene** without adding a separate animation loop.
- [ ] **Step 6: Run mascot, header, and relevant TUI golden tests**; review snapshots for terminal width 24 and 80.

### Task 5: Update fixtures, compatibility coverage, and migration verification

**Files:**
- Modify: `tests/contracts/*.test.ts`, `tests/end-to-end/*.test.ts`, `tests/security/*.test.ts` where product strings/imports are asserted
- Modify: TUI snapshots under `apps/tui/src/ink/testing/` and golden frames
- Create or modify: `tests/contracts/cosmew-rename.test.ts`
- Modify: `docs/superpowers/specs/2026-11-21-cosmew-rename-design.md` if implementation decisions change

**Interfaces:**
- Produce coverage for old state roots, old commands, old error aliases, new package names, mascot frames, and contract 1.40 envelopes.

- [ ] **Step 1: Update affected fixtures and snapshots** to the canonical Cosmew output while retaining explicit legacy compatibility assertions.
- [ ] **Step 2: Add a migration smoke test** that opens an existing legacy database in place and asserts settings/session/provider data remains unchanged.
- [ ] **Step 3: Run focused contract, persistence, security, and TUI tests** and resolve rename-only failures.
- [ ] **Step 4: Run `bun run lint` and `bun test tests`**; record pass/skip counts and any environment-gated skips.
- [ ] **Step 5: Run `bun run cosmew --help` and each legacy alias from a temporary directory** without making authenticated provider calls.

### Task 6: Final review and delivery check

**Files:**
- Review only: all files changed by Tasks 1–5

- [ ] **Step 1: Run `rg` for stale active Futryn/Hannes branding and inspect every match.**
- [ ] **Step 2: Run `git diff --check`, `bun run typecheck`, `bun run lint`, and `bun test tests`.**
- [ ] **Step 3: Verify no credentials, state databases, or generated secrets were changed.**
- [ ] **Step 4: Summarize canonical commands, compatibility aliases, migration precedence, mascot behavior, and test evidence.**

No automatic commit is included because the repository already contains unrelated user changes; changes must remain reviewable in scoped diffs.
