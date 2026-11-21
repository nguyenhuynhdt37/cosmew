# /config Theme, First-run Onboarding and Sandbox Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution here:** each task is one Codex run (`codex exec -m gpt-6.1-sol -c model_reasoning_effort='"medium"' -s workspace-write`), sequential. The coordinator (Claude) writes each brief from its task, then runs `bun run typecheck`, `bun run lint` and the tests itself and feeds failures back.

**Goal:** Make `/config` (with a Claude-style Theme row), first-run onboarding and the sandbox UX/defaults match Claude Code 2.1.330, with the three decisions below.

**Architecture:** Reuse what exists: the settings overlay (`apps/tui/src/ink/features/settings`), the theme picker, the startup gate (`apps/tui/src/ink/features/startup-gate`), the Connect flow, the sandbox backend and permission settings (`packages/security/src/settings.ts`, `apps/cli/src/bootstrap/permission-settings.ts`). New work is a user-settings-backed appearance store, a first-run onboarding sequence in the gate, a `/sandbox` command, and sandbox execution fixes. TUI stays SDK-only; the CLI remains the composition root.

**Tech Stack:** Bun 1.4.4, TypeScript, React 19, Ink 8, Bun SQLite, existing keymap/theme/permission code.

**Spec:** Audit "A/B/C" of 2026-11-21 (Claude Code 2.1.330 binary offsets cited there; the strings are re-extracted in Task 1 of each area), `docs/delivery/tui-v4/spec.md`, ADR 0061, ADR 0014 as amended by 0075. Each ADR below becomes the spec for its tasks.

## Decisions (user, 2026-11-21)

1. **Sandbox default = like Claude Code:** `sandbox.enabled=false`, `autoAllowBashIfSandboxed=false`, `allowUnsandboxedCommands=true`, ask for each command under regular permissions. This supersedes the default part of ADR 0061; the sandbox backend, rules and `/sandbox` stay.
2. **Appearance (theme etc.) moves into user `~/.cosmew/settings.json`**, replacing the SQLite appearance row; existing values are imported once.
3. **First-run onboarding lets the user into the TUI without signing in**; the mandatory account generation check at every launch is dropped, replaced by verification on the first send.

## Global Constraints

- Contract stays 1.40 (additive optional fields only); ADRs use the next free numbers (check `docs/adr/`).
- No new dependency. Persisted provider IDs, SQLite schema, keyring identity unchanged; the SQLite appearance data is read for import and left in place (no destructive migration).
- User settings file is user-level only; a workspace never supplies appearance, onboarding or sandbox-default values. Repository `settings.json` stays untrusted until approved by hash (ADR 0061).
- Permission invariant stays: validate → normalize → evaluate policy → persist intent → revalidate → execute → record. Turning the sandbox off never skips the permission prompt (regular permissions apply). A failing sandbox never silently falls back for commands that require it.
- Keys only through the central keymap. Fresh-install behavior is tested with an empty temporary HOME (never the real `~/.cosmew`).
- Run tests sequentially, never in parallel with another test run. Do not touch `apps/tui/src/input/mouse-input.ts` or `apps/tui/src/ink/hooks/use-terminal-wheel.tsx`. Shared dirty tree: never stash/reset/commit others' hunks.
- Docs updated in the same change (README, CLAUDE.md, ADRs, keys/status docs); unverified items are "Needs verification".

## Review Focus

- Existing users upgrading keep working: an old install with explicit sandbox settings keeps them; one with none gets the new defaults and is told once (notice), not silently changed. Pinned in Task 4.
- Unsandboxed run when the sandbox backend is broken or missing (explicitly approved command) must run; a command that requires the sandbox must fail closed. Pinned in Task 3.
- Corrupt, unreadable or read-only `~/.cosmew/settings.json`: appearance and onboarding fall back to defaults without crashing and without losing permission/sandbox keys on the next write. Pinned in Task 2.
- Onboarding interrupted (Ctrl+C, terminal closed) between steps: no half-written completion flag; next launch resumes at the first incomplete step. Pinned in Task 6.
- First send with no account or a failing account: the user gets a clear sign-in/verify prompt, the typed prompt is kept, no billable request is made without credentials. Pinned in Task 7.

---

### Task 1: `/config` Theme row, picker and the `theme=` bug

**Files:**
- Modify: `apps/tui/src/ink/features/settings/logic.ts` (row at ~line 12), `apps/tui/src/ink/features/settings/index.tsx`, `apps/tui/src/ink/features/commands.ts` (`/config key=value`, ~lines 65-81)
- Test: `apps/tui/src/ink/features/settings/settings.test.tsx` (existing file or its sibling), `apps/tui/src/ink/features/commands` tests

**Interfaces:**
- Consumes: the picker's normalization path (`client.updateAppearance`, `ThemeEngine` normalization ~`theme.ts:530`).
- Produces: row label `Theme` whose Enter opens the theme picker (`open('theme')`); `/config theme=<id|auto|dark|light>` that goes through the same normalization as the picker (sets both `theme` and `mode`).

- [ ] **Step 1: Write failing tests:** `/config theme=light` from `mode=system` persists `mode='light'` and the theme resolves to light after a fresh `ThemeEngine.initialize()`; `/config theme=auto` sets `mode='system'`; unknown value prints `Unknown theme`; the Config row label is `Theme` and Enter opens the picker overlay; Esc from the picker returns to the config list.
- [ ] **Step 2: Run** the touched test files; confirm failures.
- [ ] **Step 3: Implement** by routing `/config theme=` through the picker's setter and replacing the cycling row with a picker-opening row.
- [ ] **Step 4: Run** the tests, `bun run typecheck`; expect PASS.

### Task 2: Appearance in user `settings.json`

**Files:**
- Modify: `apps/cli/src/bootstrap/permission-settings.ts` (or a new sibling `user-settings.ts` if the file must not own appearance), `packages/security/src/settings.ts` (parser/merge keep unknown top-level keys), `packages/sdk/src/client.ts` (`updateAppearance`/`appearance()` backing port), `apps/cli/src/bootstrap/startup.ts` (inject the port), `packages/persistence/src/index.ts` (read-only import)
- Create: `docs/adr/<next>-user-settings-appearance.md`
- Test: `tests/contracts/user-settings-appearance.test.ts`

**Interfaces:**
- Produces: `interface AppearanceStore {read(): Appearance; write(patch: Partial<Appearance>): void}` injected into the SDK; settings keys `theme`, `themeMode`, `reducedMotion`, `syntaxHighlighting` (names chosen to match Claude's `theme` where it exists) in `~/.cosmew/settings.json`; one-time import `importLegacyAppearance(sqlite): Partial<Appearance>` run only when the JSON has none.
- Consumes: the Task 1 setter path.

- [ ] **Step 1: Write failing tests (empty temp HOME):** write then read round-trips; a write preserves existing `permissions` and `sandbox` keys byte-for-byte semantically; first launch imports legacy SQLite appearance exactly once and never re-imports after the user changed it; corrupt JSON → defaults, original file left untouched until the next successful write which rebuilds from parsed valid keys and keeps a `.bak`; read-only file → in-memory appearance still works and a notice is returned, no throw; project-level appearance values in `<project>/.cosmew/settings.json` are ignored.
- [ ] **Step 2: Run** `bun test tests/contracts/user-settings-appearance.test.ts`; confirm failures.
- [ ] **Step 3: Implement** the store (atomic write via temp file + rename, mtime-cached read like the existing settings reader), inject into the SDK, keep global/project override semantics the SDK has today for appearance only where it already exists (project override stays SQLite-free: document the chosen behavior in the ADR).
- [ ] **Step 4: Run** the new test, `tests/contracts` theme tests, `bun run typecheck`; expect PASS.

### Task 3: Sandbox execution fixes (explicit unsandboxed run, proxy retry)

**Files:**
- Modify: `packages/tools/src/handlers/command.ts` (~line 21), `packages/tools/src/context.ts` (~217), `packages/tools/src/exec/native.ts` (~354, ~496), `packages/tools/src/exec/proxy.ts` (~98-114)
- Test: `tests/contracts/sandbox-modes.test.ts` (new), existing exec/proxy tests

**Interfaces:**
- Produces: availability check that applies only to sandboxed launches; an explicitly approved unsandboxed command (`dangerouslyDisableSandbox`, excluded command, or `sandbox.enabled=false`) runs even when the backend self-test fails or the binary is missing; `ProxyManager.ensureStarted()` clears a rejected start promise so the next call retries.

- [ ] **Step 1: Write failing tests:** with a backend whose `availability()` reports unavailable, an unsandboxed approved command runs and returns output; a command that requires the sandbox still returns the sandbox-unavailable error (fail closed); a first proxy bind failure followed by a successful bind lets the second call succeed; stdin to a terminal launched unsandboxed follows existing rules.
- [ ] **Step 2: Run** the new file; confirm failures name the guard.
- [ ] **Step 3: Implement** by moving the availability gate behind the sandbox-mode decision and resetting the cached promise on rejection.
- [ ] **Step 4: Run** the new test plus existing exec/permission tests one at a time, `bun run typecheck`; expect PASS.

### Task 4: Claude-style sandbox defaults and upgrade notice

**Files:**
- Modify: `packages/security/src/settings.ts` (~line 204 defaults), `apps/cli/src/bootstrap/startup.ts` (~546), `CLAUDE.md`, `AGENTS.md`, `README.md`
- Create: `docs/adr/<next>-sandbox-defaults-like-claude-code.md` (supersedes only the default values of ADR 0061)
- Test: `tests/security/sandbox-defaults.test.ts`

**Interfaces:**
- Produces: defaults `enabled=false`, `autoAllowBashIfSandboxed=false`, `allowUnsandboxedCommands=true`; `defaultsNotice(settingsFileState): string | undefined` returning a one-time notice when the user has no explicit `sandbox` block and the sandbox is now off.

- [ ] **Step 1: Write failing tests:** no settings → merged sandbox is disabled, auto-allow false, shell commands ask for permission (permission mode `default`); explicit `sandbox.enabled: true` in user settings is preserved; explicit values in a trusted project file still follow the existing trust rules; the notice appears once and is recorded (not repeated); `plan` mode still refuses commands; deny rules still win.
- [ ] **Step 2: Run** the test file; confirm failures.
- [ ] **Step 3: Implement** the default change and the notice; update the three docs and the ADR (record rationale: parity with Claude Code 2.1.330 schema defaults; security trade-off stated).
- [ ] **Step 4: Run** `bun test tests/security`, hermetic command tests (`COSMEW_COMMAND_BACKEND=none` preload), `bun run typecheck`; expect PASS. Update golden/e2e expectations that assumed auto-allow only after reviewing each diff.

### Task 5: `/sandbox` command (Mode, Overrides, Config, exclusions)

**Files:**
- Create: `apps/tui/src/ink/features/sandbox/index.tsx`, `apps/tui/src/ink/features/sandbox/logic.ts`
- Modify: `packages/sdk/src/commands.ts` (register `/sandbox`), `apps/tui/src/ink/features/commands.ts` (route), `apps/tui/src/ink/features/settings/logic.ts` (the Sandbox row opens it), SDK/CLI settings writer used by `/permissions`
- Test: `apps/tui/src/ink/features/sandbox/sandbox.test.tsx`

**Interfaces:**
- Produces: tabs `Mode | Dependencies | Overrides | Config`; Mode options `Sandbox commands, with auto-allow` / `Sandbox commands, with regular permissions` / `No sandbox` mapped to `{enabled, autoAllowBashIfSandboxed}` = `{true,true}` / `{true,false}` / `{false,false}`; Overrides toggles `Allow unsandboxed fallback` (`allowUnsandboxedCommands`) vs `Strict sandbox mode`; Config lists `excludedCommands` and `network.allowedDomains`; `/sandbox exclude <pattern>` adds an exclusion; writes go to the user `settings.json` through the existing settings writer (never a workspace file), revoke session grants like other rule changes.
- Consumes: Task 4 defaults, Task 2 file writer.

- [ ] **Step 1: Write failing tests:** each Mode option writes the expected pair and the panel shows the active one; `/sandbox exclude "npm test"` adds exactly one entry (idempotent) and shows it in Config; Overrides toggle flips `allowUnsandboxedCommands`; writes preserve other keys; a read-only settings file shows an error row instead of throwing; `/sandbox` while a turn is running is allowed and applies to the next command.
- [ ] **Step 2: Run** the test file; confirm failures (command unknown).
- [ ] **Step 3: Implement** the panel as a dialog opened via `useOverlay`, registering the command in `SLASH_COMMANDS`; add help text and `/help` entry.
- [ ] **Step 4: Run** the new test, the command-registry tests, `bun run typecheck`; expect PASS.

### Task 6: Sandbox Dependencies tab and violation banner

**Files:**
- Modify: `packages/tools/src/exec/native.ts` (~351 self-test; expose a structured report), `apps/tui/src/ink/features/sandbox/index.tsx`, `apps/tui/src/ink/features/status/index.tsx` (banner line)
- Test: `apps/tui/src/ink/features/sandbox/dependencies.test.tsx`, `tests/contracts/sandbox-dependencies.test.ts`

**Interfaces:**
- Produces: `sandboxDependencies(): Promise<{platform: string; items: {name: 'seatbelt' | 'ripgrep' | 'bwrap' | 'socat'; ok: boolean; detail?: string}[]}>` (macOS: seatbelt, ripgrep; Linux adds bwrap, socat); message `Sandbox dependencies not available: <names>`; banner text `⧈ Sandbox blocked N operations` with the exact wording re-checked against the Claude 2.1.330 string (`CC@328900912`) and shown only when N > 0 in the current turn.

- [ ] **Step 1: Write failing tests:** fake probes → items and the unavailable message list only missing names; Dependencies tab renders ok/missing rows; banner hidden at 0, shown at N and reset on the next turn; sandbox off → no banner and Dependencies explains it is not needed.
- [ ] **Step 2: Run** the two test files; confirm failures.
- [ ] **Step 3: Implement** the structured report (reuse the existing self-test, no new spawn style) and the banner fed by the existing sandbox violation signal if one exists; if none exists, count denied-operation exits from the sandbox log the backend already captures and mark the rest "Needs verification".
- [ ] **Step 4: Run** the tests, `bun run typecheck`; expect PASS.

### Task 7: First-run onboarding sequence

**Files:**
- Create: `apps/tui/src/ink/features/onboarding/index.tsx`, `apps/tui/src/ink/features/onboarding/logic.ts`, `docs/adr/<next>-first-run-onboarding.md` (amends ADR 0014/0075)
- Modify: `apps/tui/src/ink/features/startup-gate/index.tsx`, `apps/tui/src/ink/integrated-shell.tsx` (gate wiring only), Task 2 store (completion flag `onboardingCompleted: string[]` of finished step ids)
- Test: `apps/tui/src/ink/features/onboarding/onboarding.test.tsx`, `tests/end-to-end/onboarding.test.ts`

**Interfaces:**
- Produces: `type OnboardingStep = 'theme' | 'auth' | 'security'`; `nextStep(done: readonly OnboardingStep[], hasAccount: boolean): OnboardingStep | undefined`; sequence theme (`Let's get started.` + picker + `To change this later, run /theme`, wording from the Claude strings) → auth (reuse Connect; `Skip for now` allowed) → security notes (`Security notes:`, mistakes warning, prompt-injection warning, Enter to continue) → existing trust-folder dialog → TUI. Each step id is saved the moment it finishes; the flag is the set of finished ids, so an interrupted run resumes at the first missing step. No terminal-setup step (`/terminal-setup` stays "Not implemented", recorded as a known gap).
- Consumes: Task 2 store, Task 1 picker, existing Connect feature.

- [ ] **Step 1: Write failing tests:** fresh temp HOME → shows theme first, then auth, then security, then trust; choosing Skip on auth reaches the TUI; Ctrl+C after theme and relaunch → starts at auth; completed flags skip steps; an existing user with an account and a stored theme skips theme/auth but still sees security notes once; `--help`, non-TTY and `exec` runs never show onboarding.
- [ ] **Step 2: Run** the two test files; confirm failures.
- [ ] **Step 3: Implement** the step components, wire them before the existing trust dialog, persist per step, and write the ADR.
- [ ] **Step 4: Run** the tests, `bun run typecheck`; expect PASS. Capture before/after frames at widths 80 and 40.

### Task 8: Lazy account verification on first send

**Files:**
- Modify: `apps/tui/src/ink/features/startup-gate/index.tsx` (drop the mandatory generation check, ~lines 81-88), `apps/tui/src/ink/integrated-shell.tsx` (send path), `packages/sdk/src/client.ts` (a `verifyAccount()` that is idempotent and cached per account/model)
- Test: `apps/tui/src/ink/features/startup-gate/gate.test.tsx`, `tests/end-to-end/first-send.test.ts`

**Interfaces:**
- Produces: `client.verifyAccount(signal?: AbortSignal): Promise<{ok: true} | {ok: false; reason: 'no-account' | 'auth' | 'network' | 'model'}>`; the first `submit` runs it; on failure the draft is kept, an inline message offers sign-in/switch account, and no model request is sent when there is no account.
- Consumes: Task 7 flow; ADR 0075 consent persistence stays.

- [ ] **Step 1: Write failing tests:** launch with a valid account makes **zero** provider requests until the first submit; first submit verifies then sends; no account → the TUI opens, typing works, submit shows the sign-in prompt and keeps the draft; failing verification shows the reason and the account picker; verification result is cached for the session; `exec` (headless) still verifies before running.
- [ ] **Step 2: Run** both test files; confirm failures.
- [ ] **Step 3: Implement** and update the ADR from Task 7 plus CLAUDE.md's "Startup gate" paragraph.
- [ ] **Step 4: Run** the tests, `bun run typecheck`; expect PASS.

### Task 9: Verification

**Files:**
- Test: `tests/end-to-end/tui-ink-pty.test.ts` (fresh-HOME onboarding PTY case), golden frames
- Modify: `docs/delivery/tui-v4/g3-status.md`, `docs/delivery/tui-v4/keys-status.md` (status rows)

**Interfaces:**
- Consumes: all tasks.

- [ ] **Step 1: Add a PTY case** with an empty temp HOME: `fyn` → theme step → skip auth → security → trust → TUI → `/config` shows Theme → `/sandbox` shows Mode `No sandbox` active; assert the process stays alive and no network request is made.
- [ ] **Step 2: Coordinator runs** `bun run typecheck`, `bun run lint`, `bun test tests`, `bun test apps`, one at a time; record pass/skip/fail counts.
- [ ] **Step 3: Manual check by the user** in their terminal: fresh HOME launch, `/config`, `/theme`, `/sandbox`, a shell command under regular permissions, then the old HOME still works.

No automatic commit: the repository holds unrelated user changes; each task is reviewed from a scoped diff.
