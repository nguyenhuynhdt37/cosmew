# External command cwd approval audit

Date: 2026-11-22. Committed baseline: `578f6f1` (includes the external-cwd
implementation introduced in f15a197). Compared with the existing, uncommitted
external-cwd approval draft in the shared working tree. This audit adds tests and
evidence; it does not commit/push that draft or invoke an authenticated provider.

## Confirmed behavior

A real controlled npm script under a temporary directory outside the project,
with `Bash(npm test:*)` allowed and sandbox disabled, ran on the committed baseline
without asking. The negative regression observed `{status: "ok", prompts: 0,
canary: true}` instead of `{status: "denied", prompts: 1, canary: false}`.
The script writes only a temporary canary, npm runs offline and all files are
removed by test cleanup. This confirms a missing external-cwd consent gate, not
an OS sandbox escape. An allowed npm script executes code from its selected cwd.

The same controlled test on the current draft refuses before approval. After an
explicit Once approval it writes the canary with sandbox off. With macOS
Seatbelt on, explicit approval still results in `SANDBOX_DENIED` and no canary:
`cwdRoots` does not extend the OS writable roots.

| Path | Committed baseline | Current draft |
| --- | --- | --- |
| default/acceptEdits, sandbox off, Bash Allow | Can launch without asking | Explicit external-cwd prompt |
| default/acceptEdits, sandbox off, no Allow | Ordinary command prompt already required | External-cwd prompt; no Always |
| sandbox on, auto-allow enabled | Can launch without asking | External-cwd prompt; sandbox retained |
| sandbox on, auto-allow disabled, no Allow | Ordinary command prompt already required | External-cwd prompt |
| sandbox on, auto-allow disabled, Bash Allow | Can launch without asking | External-cwd prompt |
| bypassPermissions | Can launch without asking | External-cwd prompt, or deny when no prompt UI |
| plan | Refuses execution already | Still refuses execution |
| saved Bash Always rule | Can answer an external-cwd request | Ignored for external-cwd consent |
| Once/session answers | Ordinary grant policy | Once does not authorize a repeat; session binds exact command/cwd/sandbox |
| removed additional directory | Old approval/grant can remain usable | Revalidation refuses / requests new external scope |
| write_stdin with non-empty input | Ordinary auto-allow/bypass can answer | External-cwd prompt; Plan refuses |
| empty stdin poll / interrupt | Transport, not new command authority | Remain available, including Plan |
| headless runner with Bash Allow | Can execute external cwd without a TTY | Denies without prompting or executing |

The current draft records the canonical external directory in the prompt,
offers only Once/Session, ignores Allow rules and automatic permission modes for
this consent, and refuses a fabricated Always resolution with POLICY. Deny rules,
Git/state protections, revocation and sandbox failure checks remain in force.
Trusted additionalDirectories are working directories, not unapproved external
cwd values. Permission rules for ordinary in-root commands are unchanged.

## Verification

The additional `cwd audit` tests in `tests/security/permission-modes.test.ts`
exercise the complete 4-mode x sandbox-on/off x auto-allow-on/off x Allow-on/off
matrix, real npm side effects, Once/session scope, noninteractive permission
handling in all modes and rejection of Always in bypass.

- Same 45 tests on committed production code in a separate managed worktree:
  **9 passed, 36 failed**. The failures include missing prompt details/Always
  restrictions, not 36 independent execution exploits. All Plan cases refuse.
- Current draft, five focused suites: **141 passed, 0 failed**, 880 assertions.
  Includes permission modes, command grants/revalidation, outside file/shell
  access, headless `runExec` integration and 80/36-column permission UI tests.
- The strengthened real sandbox test also explicitly verifies SANDBOX_DENIED:
  **2 passed**, covering sandbox off and on.
- `bun run lint`: passed (types/unused checks, formatting and whitespace).
- Test preload redirects HOME/state into temporary directories and checks hashes
  of real user settings/state at teardown. One repeat failed this guard because
  the real provider-auth.sqlite changed during the run. Two pre-existing Bun
  processes (one in this repository, one in orca/projects/test) held that DB;
  the guard alone cannot identify the writer. The TUI fixture uses in-memory
  ports. No live process was killed or user DB restored/modified to clear the
  guard. A separate UI rerun passed 10 tests, then the complete five-suite rerun
  passed 141 tests with no guard violation. This does not establish that real
  user state stayed unchanged across the entire audit interval.

## Limits and next steps

This gate covers the canonical `exec_command.workdir` and the recorded launch
cwd of `write_stdin`. It does not turn shell parsing into a filesystem sandbox:
a command already permitted inside a working directory can itself change cwd,
start subprocesses or access paths with its OS permissions when the sandbox is
off. Do not describe this fix as confining every `cd` or npm script to the project.

No installed-binary hash, live Grok request, real entitlement or Linux sandbox
compatibility was verified here. The planned full-suite/install-hash/live-Grok
pass remains separate. No additional commit or push was made by this audit.
