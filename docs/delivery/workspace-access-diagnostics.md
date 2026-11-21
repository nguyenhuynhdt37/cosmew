# Workspace access and sandbox-off diagnostics

Date: 2026-11-22. No public contract, permission-policy or dependency change.

## Observed Next.js session

Read-only inspection of the existing fyn conversation journal found 23 successful
`read` calls, 11 successful `glob` calls and 19 successful `grep` calls. There
were no tool results with `status: denied`. The single search failure was
`NOT_FOUND` for `node_modules/create-next-app`; running a generator through `npx`
does not establish that it is installed in the application's node_modules.
Normal shell calls earlier in the conversation succeeded. The later review
request explicitly asked for read-only review and did not run build commands.
The user-level sandbox setting was disabled. No settings, grants or conversation
records were changed during inspection; no credentials or raw prompts copied.

This evidence supports a missing path and a confusing analysis-mode presentation,
not a sandbox denial of ordinary workspace reads in that conversation. It does
not establish the outcome of every other session or any unrecorded operation.

## Changes

- Show `Review · read-only · /chat to implement` or the Plan equivalent in the
  composer. Session analysis mode stays visible independently of sandbox and
  permission-mode footer labels. `/chat` returns to normal agent work while
  retaining the user's current permission and sandbox settings.
- `NOT_FOUND` explicitly identifies a missing path, distinguishes it from
  permission denial and suggests locating the path with Glob.
- Outside-working-directory denials explain that disabling the OS sandbox does
  not grant file-tool access. They direct the user to grant a trusted additional
  directory or open the intended workspace; they do not expose outside content
  or automatically approve/write settings. The read-path suggestion uses the
  same explanation.

The underlying rules remain ADR 0061 / ADR 0067 / ADR 0081: Read/Search operate in
the project and trusted additional directories. Review/Plan still restrict
execution and mutation; hard filesystem denies and explicit rules still apply.

## Verification

New regression tests first failed for missing diagnostics and invisible Review
mode, then passed: **4 tests, 34 assertions**. The real-filesystem dispatcher
matrix covers sandbox enabled/disabled, read-only analysis, existing workspace
files, trusted additional directories, missing generator paths and outside-root
content refusal. Ink tests at 40/80 columns cover visible analysis mode and
`/chat` without changing sandbox state or submitting provider work.

Additional permission, coding-tool, working-root and session-mode checks:
**62 pass, 0 fail** across five files. Composer/status/fullscreen and mode-banner
checks: **71 pass, 0 fail** across four files. Repository typecheck,
unused checks, Prettier and diff check passed. No OS-sandbox or paid-provider
compatibility claim follows from these diagnostic tests.

## Superseded outside-path policy (ADR 0092)

The hard outside-working-directory refusal described above has been replaced by per-operation approval. Existing/missing-path diagnostics and Review/Plan visibility remain. Sandbox off permits OS-level access for approved commands; file tools separately ask for external paths. No settings are auto-trusted or rewritten.
