# Task 03 + 04 implementation ledger

Starting branch dev, HEAD d56e11fabb82f638d6602a6628ee5323e064119b.
Pre-existing worktree changes (Agent Loop/providers/apply_patch) were retained, never stage whole dirty files blindly.
Codex upstream fetched 2026-11-17: 090be4df0724cdef5758e6a0934ba557af8b6bbe.

Design: extend existing SDK/controller/view seams and current independent agent, permission dispatcher and native runtime. Reuse SQLite settings transactions. No new framework, dependencies, execution authority, compaction engine or extension subsystem. UI availability is evidence of backend capability only when an actual handler exists. No push.

Implementation plan:
- [x] Audit source-backed matrix; inspect current local terminal and upstream surfaces.
- [x] Composer/input: safe chunked paste, Unicode editing, drafts, streaming isolation; regression tests.
- [x] Commands: one registry for routes/discovery, supported mode workflow and shortcuts; conformance tests.
- [x] Diff: bounded Git helper suppression, staged/unstaged/untracked metadata, authoritative report, refresh/filter navigation; real repository adversarial tests.
- [x] Config: group existing settings/actions with accurate persistence and provenance; validate/reload tests.
- [x] Integration: ensure analysis modes block actual mutations and shell path, structured mode guidance; fixture tests.
- [x] Validation: full tests, typecheck, lint, supported build, terminal acceptance; review final diff, isolate commits and report limitations.

Review focus: malicious Git config, symlink/untrusted file paths, stale stream identity, accepted steering durability, session-only permissions accidentally persisted, delegated ownership, unknown usage treated as zero.
