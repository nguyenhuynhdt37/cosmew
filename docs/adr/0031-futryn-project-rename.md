# ADR 0031 — Futryn project/repository name and fyn command

Accepted 2026-11-16 by explicit user request. Project: **Futryn**; repository: `nguyenhuynhdt37/futryn`; short CLI: **fyn**. `futryn` is an equivalent executable. The existing local checkout directory may retain its old name; CLI workspace selection always uses the caller's current directory.

Root package is `futryn`; private workspace packages and all consumers use `@futryn/*`. Bun's lockfile records the same approved external dependencies and versions. Run `bun install --frozen-lockfile --ignore-scripts`, then `bun run link:cli` to register the CLI with Bun. Its global bin directory (normally ~/.bun/bin) must be on PATH. Both `fyn` and `futryn` enter the existing CLI/TUI without adding a second dispatcher or changing cwd. The old `hannes` command remains an alias.

Help, prompts, runtime guidance and UI product labels use Futryn; the line-oriented prompt is `fyn>`. Historical ADRs and upstream evidence are not rewritten. `FutrynError` is canonical; `HannesError` is a compatibility alias to the same constructor, preserving instanceof. Wire error JSON remains unchanged. Package names are private workspace identities, not published package migrations. Contract version 1.12 and SQLite schema4 remain unchanged.

## Existing data and security

`FUTRYN_HOME` takes precedence over compatible `HANNES_HOME`. Without an override, use ~/.futryn when present; otherwise reuse existing ~/.hannes in place; new users get ~/.futryn. No automatic move, merge, copy, deletion or grant restoration. If both exist, ~/.futryn is selected; use an explicit environment override to select the older state. Configured directories still pass the same private-directory/symlink/ownership checks.

Keep the `hannes.provider-auth.v1` OS keyring service so existing credentials remain accessible. Keep persisted backend IDs such as `hannes`, policy reason codes and historical receipt contents; these are not product labels. FUTRYN_PROJECT_CONTEXT_MAX_BYTES is the canonical project-context override, with HANNES_PROJECT_CONTEXT_MAX_BYTES as fallback. Existing opt-in testing environment variables remain compatible.

Write policy protects both .futryn and .hannes and their temporary-file namespaces. Project exploration excludes both state directory names. Native subscription deny configuration includes both state roots. Tool permissions, scope hashes, audit, recovery rules and production exec_command gate remain unchanged.

## Verification

`tests/contracts/project-branding.test.ts` covers package/bin identity; executable symlink resolution from a separate project; FUTRYN_HOME and HANNES_HOME startup; state precedence without migration; error alias identity; and protected-path deny checks. Existing TUI goldens and apply_patch security tests remain applicable. A local global-link smoke test runs fyn --help from /tmp, not the repository. GitHub rename is verified against the remote repository identity, followed by updating origin and pushing dev. No new dependency or application feature is introduced.

Verification on 2026-11-16: `bun run typecheck` and `bun run lint` passed. `bun test tests`: **498 pass, 5 skip, 0 fail**, 83,678 assertions across 44 files. Skips require explicit native-vault/installed-runtime host configuration. Focused branding/TUI-golden/apply_patch run: **22 pass, 0 fail**. Global `fyn --help` and `futryn --help` resolve from /tmp; no authenticated provider call was made.
