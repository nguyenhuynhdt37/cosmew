# ADR 0103 — Cosmew-only CLI and repository

Status: Accepted
Date: 2026-11-22

## Context

The maintainer requested removal of `fyn` and a consistent Cosmew project identity, including GitHub. ADR 0076 retained executable aliases; these now obscure the canonical command.

## Decision

- `cosmew` is the sole installed executable and root launch script. Remove `fyn`, `futryn`, and `hannes` executable/script aliases. Existing automation must replace those command names with `cosmew` and run `bun run link:cli` again.
- The canonical repository is `https://github.com/nguyenhuynhdt37/cosmew`; update package metadata and the local origin after GitHub confirms the rename. Preserve Git history and push `dev` without force.
- Help, resume instructions and active usage examples use `cosmew`.
- Preserve state discovery, legacy environment variables, workspace package aliases, persisted backend/theme IDs and the `hannes.provider-auth.v1` keyring identity from ADR 0076. No credentials, sessions or settings are copied, merged or deleted.
- Historical decisions and captured audit artifacts retain their original wording. Keep the active checkout directory in place to preserve running session/worktree paths.

This changes the CLI distribution surface, not event/SDK wire contracts or database schema; their versions remain unchanged.

## Verification

Branding tests require the single executable, canonical repository metadata, absence of old launch scripts, startup from another project, preservation of legacy state overrides, and rejection of project Bun preloads before trust. Existing CLI, headless and terminal tests cover help and resume hints. Validate the lockfile without lifecycle scripts and run the quality gate.
