# ADR 0081: Sandbox defaults like Claude Code

Date: 2026-11-21. Status: accepted. Supersedes **only default values** in ADR 0061.

User decision: follow Claude Code 2.1.330 schema defaults: `enabled=false`,
`autoAllowBashIfSandboxed=false`, `allowUnsandboxedCommands=true`. Commands use
regular permissions. Deny rules and plan mode still win; disabling containment
never grants permission or bypasses the prompt.

Explicit sandbox keys keep their values and existing trust/precedence behavior.
With no user sandbox block, startup records `sandboxDefaultsNoticeVersion: 1`
in user settings.json, preserving other keys, then displays a one-time notice
that sandbox is now off and `/sandbox` enables it. Invalid/unwritable settings
are left untouched; no recorded-notice claim is made when saving fails.
Repository settings cannot provide the notice marker or defaults.

Trade-off: default shell execution has host filesystem/network access after
permission approval. Enable the sandbox for OS containment. Sandboxed launches
still fail closed; the backend never silently falls back. No dependency or
contract version change.

Upstream evidence: Claude Code 2.1.330 binary audit referenced by
`docs/superpowers/plans/2026-11-21-config-onboarding-sandbox-parity.md`, user
confirmed 2026-11-21. Needs verification: independently reproduce schema defaults
against that exact binary revision; no binary provenance hash is available here.

## User controls (Tasks 5–6)

`/sandbox` and the Settings Sandbox row open Mode | Dependencies | Overrides |
Config. The three Mode choices save enabled/autoAllow pairs true/true, true/false
and false/false. Overrides selects allowUnsandboxedCommands. Exclusions are
idempotent. Writes use the existing user settings writer, preserve all other
keys, report failures and revoke dispatcher/prompt/network grants and pending
approvals. Changes apply to subsequent commands, including during a turn.
Optional `PermissionSettingsPort.updateSandbox` and SDK `updateSandbox` are
additive in contract 1.40; a backend without the port reports UNSUPPORTED.

Dependency reporting uses native discovery without launching a shell: macOS
seatbelt (`/usr/bin/sandbox-exec`) and ripgrep (`rg`); Linux ripgrep, bwrap and
socat (Seatbelt is macOS-only). Presence is not backend self-test/containment
acceptance; execution keeps its separate fail-closed health gate. The optional
SDK backend `sandboxDependencies()` returns a structured report (contract 1.40).
Sandbox off does not probe dependencies.

The status banner counts distinct exec_command/write_stdin SANDBOX_DENIED
outcomes per user turn, resetting at the next model or user-shell turn; hidden
while sandbox is off. Native unsandboxed exits cannot set sandboxDenied.
Needs verification: complete OS violation monitoring (including denied operations
that leave no failing exit/output), Linux live containment/network bridge. The
existing output heuristic can miss violations or misclassify ordinary filesystem
permission failures; the counter is not a count from an OS violation monitor.

Upstream wording rechecked 2026-11-21 against local
`~/.local/share/claude/versions/2.1.330`, SHA-256
`f7c5093b9dd6560d08af28bc27b123fb55091deae3180ac39df199522da86815`:
Mode labels at byte 147549656 onward; dependencies prefix at 140515344;
banner near 328900871 selects `operation` / `operations`. Claude's live banner
expires after five seconds and adds shortcut details; Cosmew intentionally uses
the requested current-turn count, without advertising an unimplemented OS log
inspector. This observation verifies strings, not Claude's schema defaults.

## Bash permission prompts

With the sandbox off, an ordinary Bash prompt focuses **Yes** and puts the
`/sandbox` hint in the footer. Escapes and exclusions while the sandbox is on
show **NO SANDBOX**, warn about full user permissions, and focus **No**.
`dangerouslyDisableSandbox` offers once and session only. Exclusions keep
their existing exact-command rule option. Sandboxed prompts retain their
existing presentation. The optional `commandSandbox` field is additive
within contract 1.43. [Tools and permissions](../contracts/tools-and-permissions.md)
