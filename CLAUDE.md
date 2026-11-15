# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hannes / FUTRYN is a TypeScript + Bun coding-agent harness. The active slice is **Provider & Authentication (PA1) + FUTRYN TUI (TUI1) + read-only workspace tools (TOOLS1, [ADR 0017](docs/adr/0017-read-only-tools-and-permission-engine.md))**, plus the SUB1 subscription-runtime exception ([ADR 0008](docs/adr/0008-subscription-runtime-auth.md)). Everything else (shell/filesystem tools, MCP, plugins, subagents, compaction, GUI) is **Not implemented**; empty `packages/*` directories (`mcp`, `extensions`, `agents`, `code-intel`, `compat-*`, `testkit`, and the empty builtin files `edit`/`write`/`shell`/`git` under `tools`) and `apps/{server,web,desktop}` are placeholders, not evidence of features. Do not fill them or add packages outside the allowed slice. Never claim "Product MVP complete": live authenticated generation is not verified.

`AGENTS.md` (Vietnamese) is authoritative for scope rules; read it and the ADRs in `docs/adr/` before extending the slice.

Task 03A ([ADR 0022](docs/adr/0022-sandboxed-exec-command-foundation.md)) permits a one-shot sandboxed exec_command foundation. Production execution remains disabled: the macOS candidate cannot guarantee detached descendant cleanup; Linux/Windows are unsupported. Candidate OS tests and injected fixtures are not production availability evidence. No persistent sessions, PTY, write_stdin or write tools.

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

Workspace packages (`@hannes/*`, resolved via bun workspaces, `moduleResolution: bundler`): `contracts`, `models`, `security`, `persistence`, `core`, `sdk`, `tools`, `workspace`, `apps/tui`, `apps/cli`.

Dependency rules ([docs/architecture/dependency-rules.md](docs/architecture/dependency-rules.md)) are a DAG enforced by review, not tooling:
- Every package may depend on `contracts`; `contracts` depends on no Hannes package and exports no foreign SDK types.
- `core`, `models`, `security`, `persistence`, `sdk`, `workspace` depend on nothing else in Hannes. They meet only through injected ports. `tools` may depend on `workspace` and `security` (and later `code-intel`).
- `apps/tui` depends on `sdk` only (UI talks command/event protocol). `apps/cli` is the **composition root**: it is the only place that wires models + security + persistence + core + tools + workspace + tui (`apps/cli/src/bootstrap/startup.ts` builds the `Application`).
- Never deep-import another package's `src/` files; use its `index.ts`. Public contract changes need an ADR + migration/versioning + consumer updates.

Ownership: `core` orchestrates (agent loop in `packages/core/src/agent`, context builder); `security` decides permissions, holds secrets/OAuth/subscription policy and audit; `persistence` owns all durable SQLite writes (`~/.hannes/provider-auth.sqlite`); `models` only adapts provider wire formats (`providers/{anthropic,openai-compatible,router9}`, catalog, streaming, usage); adapters convert, never decide.

Credentials: API keys live in separate OS keyring entries or as environment-variable *references*; there is no plaintext fallback. Failed/cancelled logins must remove stored credentials. Account/provider switching starts fresh context (see ADR 0009 for the continuation rules).

Subscription auth (`apps/cli/src/subscriptions`, `packages/models/src/subscription.ts`, `packages/security/src/subscription-policy.ts`) delegates sign-in to official vendor CLIs (Codex, Copilot CLI, Gemini CLI, Qwen Code, Grok Build — ADR 0026) with a separate profile and credential vault. Execution ownership ([ADR 0029](docs/adr/0029-hannes-owned-agent-and-delegated-backends.md), `executionBackendFor`): direct APIs are `hannes` (Hannes owns the loop and runs every project tool); Codex with folder consent is `codex-bridge` (Codex loop, Hannes tools only); other runtimes are `chat-only`; `delegated` (runtime's own loop and unconfined tools, permission requests routed to Hannes per ADR 0027) only after an explicit per-session `/backend delegated`, never from folder consent alone. Switching account/provider resets mode, delegation and session grants. Not a delegated-task scheduler.

TUI (`apps/tui/src`, see [ADR 0015](docs/adr/0015-tui-feature-modules.md)): `app.tsx` is only the composition root. Each function is a folder under `features/<name>/` with `types.ts` (state), `logic.ts` (pure functions), `view.ts` (rendering), `controller.ts` (keys + state) and `index.ts` (only public entry). Features never import the app; they get a `TuiHost` from `core/feature.ts`, and cross-feature flows go through `host.features` (`AccountWorkflow`, `ModelWorkflow`). Overlays implement `OverlayFeature` and are registered in `FutrynTuiApp.registerFeatures`. Shared UI lives in `ui/` (`Modal` for dialog frames, `Canvas`, list/text-field helpers); build new dialogs with `Modal` rather than hand-assembling borders. Import from `@hannes/tui` (the `src/index.ts` barrel), not `src/app`. Transcript items record `parts` in arrival order (reasoning / text / tool groups / runtime `activity`, [ADR 0021](docs/adr/0021-codex-style-activity-presentation.md)) and render Claude Code style: `> prompt`, `✻ Thought`, `⏺ Bash(cmd)` + `⎿ output`, `⏺ answer` ([ADR 0028](docs/adr/0028-claude-style-transcript-and-permission-rules.md)). `/permissions` with nothing pending manages per-project Allow/Ask/Deny rules (`Bash(npm test:*)`, `Read(src/**)`) and the session mode; rules answer only `ask` decisions, deny > ask > allow > mode. Slash commands are canonical per ADR 0013 (`SLASH_COMMANDS`, shared by autocomplete and CLI help) and routed by `features/commands`; unsupported backends must print an explicit "Not implemented" diagnostic instead of faking success.

Tools (TOOLS1): `core`'s `Conversation` runs a bounded loop (16 tool rounds, 32 executed calls per turn, [ADR 0020](docs/adr/0020-progressive-code-exploration.md)) over an injected `ToolPort`, and sends shared exploration guidance from `core/agent/guidance.ts` via `ModelRequest.instructions` (system/developer channel; never repository text). `@hannes/tools`' `ToolDispatcher` is the only enforcement point: validate → `@hannes/workspace` resolves the path inside the root (outside is denied) → `@hannes/security` `evaluateRead` (deny → ask → allow) → approval via `FutrynClient.requestPermission` → audit (`tool_audit`) → execute → redact. Tools are offered only after `client.setToolsEnabled(true)` (the TUI does it on folder consent); delegated runtimes use their own tools instead and get no Hannes tools (ADR 0029). Provider adapters only convert: malformed or unknown tool calls reach the ToolRouter, which answers the model (`INVALID_INPUT`/`UNKNOWN_TOOL`). `FutrynClient.requestPermission` applies the permission mode to `ask` decisions only; deny rules never change. Grep runs in a Worker with a hard deadline. Do not add write/shell/network tools without a new ADR.

Startup gate (ADR 0014): the TUI requires per-session workspace-folder consent, then verifies the selected account/model with a small (possibly billable) request; on failure the user picks another account or signs in.

## Conventions specific to this repo

- Permission invariant (docs/architecture/dependency-rules.md): validate → normalize target → evaluate policy → persist intent → revalidate → execute → record. Nothing may bypass the permission engine, including builtin tools, plugins, MCP, SDK and recovery.
- New dependencies require evaluation (name, version, license, provenance, Bun/OS compat, threat surface) and a catalog update in `docs/delivery/dependency-catalog.md` / `provider-auth-dependencies.md` *before* installing.
- Tests must be meaningful (invariants, cancellation, failure modes); do not use mock success to prove compatibility. Fixtures are in `tests/fixtures.ts` and `tests/subscription-fixtures/`. Live provider verification is recorded separately from fixture evidence.
- Update docs in the same change (docs are mostly Vietnamese; ADR/acceptance files under `docs/delivery` record evidence). Upstream research must record URL/path, access date, revision and evidence limits; prefer "Needs verification" over guessing.
- Logs must be redacted; never commit credentials or sensitive prompt output.
