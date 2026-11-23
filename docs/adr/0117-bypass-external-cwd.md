# ADR 0117 — Bypass external command cwd with sandbox off

Accepted 2026-11-22. Shared contract 1.62; no SQLite migration or dependency change.

The maintainer requested that bypass plus sandbox off stop asking merely because a shell command runs outside the project's working directories, while keeping explicit ask/deny rules, repository settings trust and existing hard denials. This supersedes that specific mandatory approval in ADR 0092.

The SDK now lets `bypassPermissions` answer an external command-cwd permission request when the dispatcher identifies the effective command sandbox as `disabled`. The decision still runs through validation, canonicalization, policy, SDK rule/mode evaluation, revalidation, audit and redaction. Owned unsandboxed terminal input receives the same sandbox metadata when the current trusted sandbox setting is off. Polls and interrupts remain transport. No working directory is added to settings and no repository settings are written or trusted.

Default/acceptEdits still prompt outside working directories, even with Bash allow rules. Plan, Bash deny rules and protected Git/state paths still refuse execution. Explicit ask rules reaching SDK permission evaluation prompt in bypass instead of being auto-answered by the mode. Sandboxed external cwd, sandbox escape and sandbox exclusions retain their existing distinct behavior; turning sandbox off is not inferred from an individual model request. No sandbox failure falls back to host execution. Headless bypass can run external unsandboxed commands, but requests that still require interaction are refused without a TTY.

This changes the public SDK permission decision semantics and versions consumers to contract 1.62. Wire fields and event shapes are unchanged.

Evidence: official Claude Code documentation, retrieved 2026-11-22:

- https://code.claude.com/docs/en/permission-modes#actions-no-mode-auto-approves: explicit ask rules remain interactive in bypass; configurable outside-directory read restrictions and critical-removal checks are exceptions.
- https://code.claude.com/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode: bypass skips routine permission checks.
- https://code.claude.com/docs/en/permissions#working-directories: working-directory controls and optional outside-directory restrictions.

These are live documentation references, not pinned Claude source revisions. Exact external Bash cwd behavior in an authenticated installed Claude CLI, version-specific exceptions and full Claude parity remain **Needs verification**. This change implements the maintainer's chosen scope rather than claiming all Claude permission behavior is identical.

The regression test failed before the change: an external unsandboxed `printf` in bypass produced one prompt and did not execute. Afterward the same production dispatcher/SDK chain runs an actual Bash write into a temporary external directory with zero prompts, handles owned terminal input without a cwd-only prompt, and refuses to write files when explicit ask/deny rules apply. The existing matrix continues to cover default/acceptEdits/plan, sandbox enabled/disabled, Bash allow rules, grants, headless operation, protected paths and mode changes. Existing native cases check OS containment separately from fixture launches.

Validation: permission/security/SDK regression set: 187 pass, 0 fail across 9 files. A separate actual headless CLI/native Bash regression passes for external cwd execution and ask/deny refusal without a TTY (1 pass, 20 assertions). Broader headless/skills/subagents/memory run: 28 pass, 5 fail; failures concern missing memory fixtures, not external cwd or permission approval assertions. Repository typecheck still reports the previously observed `provider-reasoning-replay.test.ts` private `account` access and missing `ModelEvent` import. No live provider call or user state/settings mutation was performed.
