# Cosmew full rename and astronaut-cat brand

## Intent

Make **Cosmew** the canonical product name for the coding agent. The terminal UI will use a compact pixel-art astronaut cat as its mascot, while the codebase, package scope, CLI help, documentation, and new user state use the Cosmew name.

## Goals

- Rename the root package and workspace package scope from `futryn`/`@futryn/*` to `cosmew`/`@cosmew/*`.
- Make `cosmew` the canonical executable and script name.
- Make `COSMEW_*`, `~/.cosmew`, and `.cosmew/` the canonical environment/state/settings names.
- Replace the visible Futryn/Hannes brand in source, help, tests, and current documentation with Cosmew.
- Add a small dot-matrix astronaut-cat mascot to the TUI header and reuse its frames in the existing declarative wallpaper renderer.
- Preserve existing user data, credentials, and invocations through explicit compatibility aliases and state discovery.
- Record the public rename in a new ADR and advance the public contract version from 1.39 to 1.40.

## Non-goals

- No provider IDs, persisted session IDs, SQLite table names, keyring service identity, or event names are rewritten.
- No new image dependency or external raster asset is introduced; the mascot is terminal-native text/pixel art.
- No new agent, provider, or authentication behavior is added.
- No automatic remote package publication or GitHub repository transfer is performed.

## Anti-goals

- Do not delete or silently migrate `~/.futryn`, `~/.hannes`, `.futryn/`, or old command aliases.
- Do not break existing scripts that invoke `fyn`, `futryn`, `hannes`, or import `@futryn/*` during the transition.
- Do not copy or merge credential databases; select one existing state directory by deterministic precedence.
- Do not make the mascot a large animated panel that reduces transcript space on small terminals.

## Approaches considered

1. Hard rename every identifier and remove old names. This produces a clean tree but breaks installed commands, imports, settings, and existing state, so it is rejected.
2. Change only visible branding. This is low risk but leaves the project and public package surface named Futryn, so it does not meet the request.
3. Make Cosmew canonical and retain compatibility aliases. This changes all new public names while preserving old entry points and state discovery. This is the selected approach.

## Design

### Canonical names and compatibility

- Root package: `cosmew`.
- Workspace scope: `@cosmew/*`.
- Canonical commands: `cosmew`, `cosmew tui`, `cosmew chat`, `cosmew exec`.
- Compatibility commands: `fyn`, `futryn`, and `hannes`, all routed to the same CLI entry point.
- Canonical environment prefix: `COSMEW_`. Read legacy `FUTRYN_` and `HANNES_` names when the Cosmew equivalent is absent; write only the Cosmew name in new docs and generated configuration.
- Canonical user state: `~/.cosmew`. If it does not exist, reuse an existing `~/.futryn`, then `~/.hannes`, without copying or merging databases. `COSMEW_HOME` takes precedence, followed by `FUTRYN_HOME` and `HANNES_HOME` for compatibility.
- Canonical project settings: `.cosmew/`. Existing `.futryn/` and `.hannes/` settings remain readable as untrusted compatibility layers, with Cosmew taking precedence.
- Export `CosmewError` as the canonical error class and retain `FutrynError` and `HannesError` as aliases to the same constructor. The serialized error codes do not change.
- Keep the legacy keyring service identity so existing credentials remain addressable.

### Mascot

The header gets a 7–11 column dot-matrix astronaut cat rendered with terminal characters (`·`, `•`, `●`, `█`) and the active theme palette. Three deterministic frames cover idle breathing, eye blink, and a small visor/star shimmer. Reduced motion freezes the first frame. Narrow terminals render only the smallest face mark, and wallpaper rendering reuses the same palette and frame data through `WallpaperEngine`.

### Documentation and history

Current user-facing docs, help text, package metadata, tests, and ADR indexes use Cosmew. Historical ADRs retain their original names and quoted decisions; the rename ADR explains the compatibility boundary. Public JSONL envelopes use contract version 1.40 while preserving event shapes.

### Migration and validation

The migration is additive and deterministic. Tests cover command aliases, package import aliases, environment precedence, state-directory selection, error-constructor identity, reduced-motion mascot rendering, narrow-terminal fallback, and contract-version envelopes. Typecheck, lint, focused TUI tests, persistence migration tests, and the full test suite must pass before completion.

## Remaining builder decisions

- Exact mascot pixel map and three frame patterns.
- Whether the canonical short command is `cosmew` or a shorter alias while keeping `cosmew` as the package-facing command.
- Exact list of historical docs that remain untouched beyond the new ADR.
