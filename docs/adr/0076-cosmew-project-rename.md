# ADR 0076 — Cosmew project rename and astronaut-cat brand

Status: Accepted; executable aliases superseded by [ADR 0103](0103-cosmew-only-cli-and-repository.md)
Date: 2026-11-21  
Decision owner: Futryn project maintainers

## Context

The project is now branded **Cosmew**, with a terminal-native pixel astronaut cat. The previous public names were Futryn and Hannes, with `fyn` as the short CLI. The repository already has persistent provider credentials, sessions, settings, aliases, and historical ADRs that must remain usable.

## Decision

Cosmew is the canonical product, root package, executable, workspace scope (`@cosmew/*`), state root (`~/.cosmew`), project settings root (`.cosmew/`), and environment prefix (`COSMEW_*`). The canonical public contract version is `1.40`.

Compatibility remains explicit and additive:

- `fyn`, `futryn`, and `hannes` invoke the same CLI dispatcher as `cosmew`.
- `@futryn/*` workspace aliases resolve to the corresponding `@cosmew/*` packages.
- `FUTRYN_HOME` and `HANNES_HOME` remain read-only environment fallbacks after `COSMEW_HOME`.
- If no override is set, state discovery selects `~/.cosmew`, then an existing `~/.futryn`, then an existing `~/.hannes`; it never copies, merges, deletes, or rewrites credential databases.
- Existing `.futryn/` and `.hannes/` project settings remain readable as untrusted compatibility roots; `.cosmew/` takes precedence when present.
- `CosmewError` is canonical. `FutrynError` and `HannesError` are aliases to the same constructor, and serialized error codes remain unchanged.
- The `hannes.provider-auth.v1` OS keyring service identity, provider IDs, SQLite schema/table names, event names, policy reason codes, and persisted session identifiers remain unchanged.

The TUI uses a compact dot-matrix astronaut cat and reuses its deterministic frames in the declarative wallpaper renderer. Reduced-motion and narrow-terminal fallbacks remain supported.

## Consequences

New code and documentation use Cosmew names. Historical ADR titles and quoted decisions remain unchanged so the decision history stays truthful. Existing command scripts and state continue to work through compatibility paths. A future major release may remove aliases only through a separate accepted ADR with migration evidence.

## Verification

`bun install --frozen-lockfile --ignore-scripts`, `bun run typecheck`, and `bun test tests` must pass. No provider credentials or state databases are migrated as part of this rename.
