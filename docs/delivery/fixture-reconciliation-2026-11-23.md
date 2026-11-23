# Canonical state, context and terminal fixture reconciliation

Date: 2026-11-23. Test-only corrections from the 2026-11-22 audit; no public contract, production policy, dependency or migration changes.

- Memory end-to-end fixtures now create their config, SDK state and `FileMemories` entries under the same isolated `home/.cosmew` root. The previous `.futryn` store diverged from the host's canonical memory lookup after ADR 0106 and caused five missing-entry/context failures. Legacy state adoption remains separately covered by the compatibility/migration suites; ordinary memory tests no longer accidentally depend on a removed lookup fallback.
- Project-context fixtures use `COSMEW_PROJECT_CONTEXT_MAX_BYTES`, matching ADR 0106. Invalid input and an exact 2,048-byte configured budget are still asserted. No legacy environment-variable fallback was restored.
- The native PTY project-context scenario reconstructs the current VT screen with the existing bounded `TerminalScreen` helper. Ink updates can split an answer across cursor/erase sequences, so searching the append-only raw stream for `Hello fixture` was not reliable evidence of whether the answer appeared. Consent selection, typed drafts, completed replies and the exit confirmation now drive synchronization through observed screen state rather than arbitrary sleeps. The real HTTP request assertions still prove one current project snapshot per turn, refresh after editing instructions, no prior marker in the next request, and successful two-step Ctrl+C shutdown. Startup timeout and process-exit diagnostics remain bounded.
- Runtime-removal checks assert exactly one required notice per removal/defaults event while tolerating independent startup notices. The fixture deliberately enqueues a temporary legacy-root adoption notice, reproducing the extra-message situation seen in the aggregate suite. All account/credential deletion, API-account preservation, settings/schema, failed-cleanup retry and one-time notice assertions remain. The previous exact total of three notices passed in isolation but failed when another startup channel queued a fourth notice.
- The theme conflict cases now consistently enforce the existing documented priority: OSC 11, then terminal `COLORFGBG`, then `COSMEW_THEME_MODE`, then dark. Both environment-conflict directions are covered; explicit saved light/dark themes still win. No theme implementation changed. See ADR 0066 and the current TUI specification for terminal-background precedence, with Cosmew variable naming from ADR 0106.

Verification command:

```sh
bun test tests/end-to-end/memories.test.ts tests/end-to-end/project-context.test.ts tests/contracts/runtime-removal-migration.test.ts apps/tui/src/theme/phase-f.test.ts
```

Before: 18 pass / 8 fail (migration exact-count failure is aggregate-order dependent). After final synchronization and deterministic additional-notice coverage: **26 pass / 0 fail / 227 assertions**, 8.29 s on macOS/Bun. Scoped formatting and diff checks pass. User-state guard remains enabled. HTTP providers are local fixtures; the PTY is real, but this does not certify a live provider or another OS.
