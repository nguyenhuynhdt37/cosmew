# ADR 0106 — Cosmew state only

Status: Accepted
Date: 2026-11-22

## Context

ADR 0076 and ADR 0103 kept `~/.futryn`, `~/.hannes`, `FUTRYN_*` and `HANNES_*` as read-only fallbacks and forbade copying state. A live machine therefore kept sessions, settings and MCP config in `~/.futryn` because `~/.cosmew` did not exist. The maintainer asked for that legacy state to move to Cosmew and for the running project to stop selecting the old names.

## Decision

- `COSMEW_HOME`, when set, is the only environment override. `FUTRYN_HOME`, `HANNES_HOME` and the other `FUTRYN_*` / `HANNES_*` configuration fallbacks are not read.
- If `COSMEW_HOME` is unset and `~/.cosmew` is absent, startup renames an existing `~/.futryn`, otherwise `~/.hannes`, to `~/.cosmew`. The same one-time rename applies to a project `.futryn` or `.hannes` settings root. Rename keeps file inodes. Nothing is copied or merged.
- If `.cosmew` already exists, a leftover legacy directory is left in place and is not read.
- If another process has `provider-auth.sqlite` open, startup refuses the move and does not create an empty `.cosmew`.
- Skill and agent discovery reads `.cosmew`, `.claude` and `.agents` only.
- OS keyring service identity, persisted backend ids, theme ids and existing Git worktree branch names stay unchanged. This is not a credential rewrite and not an event-contract change.

This supersedes the legacy-discovery sentences of ADR 0076 and ADR 0103. Historical ADR text is unchanged.
