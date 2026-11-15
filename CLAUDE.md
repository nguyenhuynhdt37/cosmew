# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hannes / FUTRYN is a TypeScript + Bun coding-agent harness. The active slice is **Provider & Authentication (PA1) + FUTRYN TUI (TUI1)**, plus the SUB1 subscription-runtime exception ([ADR 0008](docs/adr/0008-subscription-runtime-auth.md)). Everything else (shell/filesystem tools, MCP, plugins, subagents, compaction, GUI) is **Not implemented**; empty `packages/*` directories (`tools`, `mcp`, `extensions`, `agents`, `workspace`, `code-intel`, `compat-*`, `testkit`) and `apps/{server,web,desktop}` are placeholders, not evidence of features. Do not fill them or add packages outside the allowed slice. Never claim "Product MVP complete": live authenticated generation is not verified.

`AGENTS.md` (Vietnamese) is authoritative for scope rules; read it and the ADRs in `docs/adr/` before extending the slice.

## Commands

Requires Bun 1.4.4. No build step; Bun runs the TS workspace directly.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run hannes            # CLI (apps/cli/src/index.ts); bare interactive run opens the TUI
bun run futryn            # full-screen TUI (same as `hannes tui`)
bun run typecheck         # tsc --noEmit
bun run lint              # tsc with noUnusedLocals/Parameters + git diff --check
bun test tests            # all tests
bun test tests/contracts/theme-engine.test.ts          # single file
UPDATE_GOLDEN=1 bun test tests/contracts/tui-golden.test.ts   # re-record rendered frames; review the diff first
bun test tests/contracts -t "name substring"           # single test by name
bun run test:integration  # provider adapters + tests/security
bun run test:e2e          # tests/end-to-end (PTY/CLI flows)
```

Optional, touches real OS keyring / network (opt-in via env): `HANNES_VERIFY_KEYRING=1 bun scripts/verify-keyring.ts`, `HANNES_TEST_KEYRING=1 bun test tests/end-to-end/provider-cli.test.ts`, `HANNES_LIVE_PUBLIC=1 bun scripts/smoke-public-catalogs.ts`. `model doctor --generate` makes a billable request.

## Architecture

Workspace packages (`@hannes/*`, resolved via bun workspaces, `moduleResolution: bundler`): `contracts`, `models`, `security`, `persistence`, `core`, `sdk`, `apps/tui`, `apps/cli`.

Dependency rules ([docs/architecture/dependency-rules.md](docs/architecture/dependency-rules.md)) are a DAG enforced by review, not tooling:
- Every package may depend on `contracts`; `contracts` depends on no Hannes package and exports no foreign SDK types.
- `core`, `models`, `security`, `persistence`, `sdk` depend on nothing else in Hannes. They meet only through injected ports.
- `apps/tui` depends on `sdk` only (UI talks command/event protocol). `apps/cli` is the **composition root**: it is the only place that wires models + security + persistence + core + tui (`apps/cli/src/bootstrap/startup.ts` builds the `Application`).
- Never deep-import another package's `src/` files; use its `index.ts`. Public contract changes need an ADR + migration/versioning + consumer updates.

Ownership: `core` orchestrates (agent loop in `packages/core/src/agent`, context builder); `security` decides permissions, holds secrets/OAuth/subscription policy and audit; `persistence` owns all durable SQLite writes (`~/.hannes/provider-auth.sqlite`); `models` only adapts provider wire formats (`providers/{anthropic,openai-compatible,router9}`, catalog, streaming, usage); adapters convert, never decide.

Credentials: API keys live in separate OS keyring entries or as environment-variable *references*; there is no plaintext fallback. Failed/cancelled logins must remove stored credentials. Account/provider switching starts fresh context (see ADR 0009 for the continuation rules).

Subscription auth (`apps/cli/src/subscriptions`, `packages/models/src/subscription.ts`, `packages/security/src/subscription-policy.ts`) delegates to official vendor CLIs (Codex, Copilot CLI, Gemini CLI, Qwen Code) with a separate profile and credential vault and **rejects every tool/permission request**. It is not a delegated-task scheduler.

TUI (`apps/tui/src`, see [ADR 0015](docs/adr/0015-tui-feature-modules.md)): `app.tsx` is only the composition root. Each function is a folder under `features/<name>/` with `types.ts` (state), `logic.ts` (pure functions), `view.ts` (rendering), `controller.ts` (keys + state) and `index.ts` (only public entry). Features never import the app; they get a `TuiHost` from `core/feature.ts`, and cross-feature flows go through `host.features` (`AccountWorkflow`, `ModelWorkflow`). Overlays implement `OverlayFeature` and are registered in `FutrynTuiApp.registerFeatures`. Shared UI lives in `ui/` (`Modal` for dialog frames, `Canvas`, list/text-field helpers); build new dialogs with `Modal` rather than hand-assembling borders. Import from `@hannes/tui` (the `src/index.ts` barrel), not `src/app`. Slash commands are canonical per ADR 0013 (`SLASH_COMMANDS`, shared by autocomplete and CLI help) and routed by `features/commands`; unsupported backends must print an explicit "Not implemented" diagnostic instead of faking success.

Startup gate (ADR 0014): the TUI requires per-session workspace-folder consent, then verifies the selected account/model with a small (possibly billable) request; on failure the user picks another account or signs in.

## Conventions specific to this repo

- Permission invariant (docs/architecture/dependency-rules.md): validate → normalize target → evaluate policy → persist intent → revalidate → execute → record. Nothing may bypass the permission engine, including builtin tools, plugins, MCP, SDK and recovery.
- New dependencies require evaluation (name, version, license, provenance, Bun/OS compat, threat surface) and a catalog update in `docs/delivery/dependency-catalog.md` / `provider-auth-dependencies.md` *before* installing.
- Tests must be meaningful (invariants, cancellation, failure modes); do not use mock success to prove compatibility. Fixtures are in `tests/fixtures.ts` and `tests/subscription-fixtures/`. Live provider verification is recorded separately from fixture evidence.
- Update docs in the same change (docs are mostly Vietnamese; ADR/acceptance files under `docs/delivery` record evidence). Upstream research must record URL/path, access date, revision and evidence limits; prefer "Needs verification" over guessing.
- Logs must be redacted; never commit credentials or sensitive prompt output.
