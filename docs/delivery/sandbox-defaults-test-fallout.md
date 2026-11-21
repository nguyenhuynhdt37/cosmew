# ADR 0081 test fallout

2026-11-21. Production defaults remain `enabled=false`,
`autoAllowBashIfSandboxed=false`, `allowUnsandboxedCommands=true`.
No production code was changed in this follow-up. The shared
`tests/sandbox-config.ts` writer creates explicit trusted **user** settings in
fixture state directories; it never writes repository settings.

| # | Test (under tests/) | Traced cause and change | Verification here |
|---|---|---|---|
| 1 | contracts/runtime-removal-migration: migrations v7 + v8 | `takeStartupNotices()` appends the ADR 0081 notice after the two migration notices. Assert all three, the temp-state settings file, and no repeat on either subsequent take or restart. Account/credential/selection/schema assertions remain. | Passed |
| 2 | end-to-end/exec-command: direct API fixture | `make()` only set auto-allow false. With sandbox disabled, the legacy fixture runtime cannot enforce danger-full-access, so preparation refuses before approval. Explicitly enable sandbox, keep auto-allow false, assert the runtime receives read-only containment, retain pairing/redaction/resume checks. | Not executed: fixture binds a port |
| 3 | end-to-end/exec-command: research-only FUTRYN TUI acceptance | Same missing enabled key; the research Seatbelt wrapper is sandbox-only. Same fixture opt-in, retain real probe, approval, source content and directory checks. | Not executed: port + real Seatbelt |
| 4 | end-to-end/exec-command: Escape at execution approval | Same preparation refusal prevented the approval dialog. Explicit sandbox fixture restores the intended denial path; zero process and denied result assertions remain. | Not executed: fixture binds a port |
| 5 | end-to-end/exec-command: CLI reuses its client runtime | Same preparation refusal prevented both approvals/runs. Explicit sandbox fixture; factory/run/shutdown-once assertions unchanged. | Not executed: fixture binds a port |
| 6 | end-to-end/exec-command: !command shell mode | Same refusal instead of dispatcher approval. Explicit sandbox fixture plus runtime containment assertions; denial executes nothing, retry executes once, no model requests. | Not executed: fixture binds a port |
| 7 | end-to-end/tui-modes: interactive CLI/TUI entry | Plan changes tool permissions, not the configured sandbox default. Assert default-off settings and all three default values; retain bypass warnings/conflict rejection. Also check first-launch JSON and one-time stderr notice. Pin COSMEW_HOME so inherited state-root variables cannot redirect writes. | Passed |
| 8 | end-to-end/approval-policy: default mode bun test/rm -rf/edit | Previous assertions assumed default-on auto-allow. Default-off variant now approves each exact command before execution and denies the edit. The fixture explicitly supports danger-full-access. A second variant explicitly enables sandbox + auto-allow and preserves the old no-command-prompt/edit-asks coverage. | Not executed: fixture binds a port |
| 9 | end-to-end/approval-policy: default mode in real Seatbelt | Missing user opt-in disabled sandbox and auto-allow. Explicitly enable both. Also execute touch outside the workspace, assert real exit 1/permission failure and absence of the outside file. The research SeatbeltRuntime reports raw exit/output, unlike NativeCommandRuntime's SANDBOX_DENIED tag. | Not executed: port + real Seatbelt |
| 10 | end-to-end/native-agent: Task 02 F 40-46 | Native runtime can run unsandboxed after ordinary approval, contradicting the test's containment/no-prompt purpose and zero-approval assertion. Explicitly enable sandbox + auto-allow. Keep real failing test, Bash fix, rerun, persisted evidence and verified-result assertions. | Not executed: port + real Seatbelt |
| 11 | end-to-end/headless-exec: exec permission flags | Default-off commands ask and are denied without TTY; bypass would permit unsandboxed execution. Explicit sandbox + auto-allow opts this containment test in. Keep all no-TTY, mode, deny-rule, bypass-warning and outside-write checks. Pin COSMEW_HOME. | Not executed: port + real Seatbelt |
| 12 | end-to-end/tui-ink-pty: Ink transcript parity PTY | No confirmed ADR 0081 defect. Notice writes to stderr before Ink launch; marker lives in state/settings.json, outside transcript messages. Temporary offline reproduction used the same PTY assertions with transport supplied in-process/preload and the notice still present: all 29 assertions passed. Temporary files removed. Original test unchanged; coordinator rerun is needed to diagnose the reported intermittent failure. | Original not executed: fixture binds a port; offline PTY reproduction passed |
| 13 | end-to-end/subagents: explore subagent is read-only | `effectiveSubagentSandbox` already forces enabled/readOnly and blocks escalation, but inherits auto-allow false; the headless child command is denied instead of executed. Only this setup opts into sandbox auto-allow. Keep read-only/network clamp, hidden tools, parent memory exclusion and escalation denial assertions. | Passed |

Additional regression: `exec --json keeps the one-time sandbox notice on stderr
in an isolated state directory` passes without a server. Both launches emit
parseable JSON failure events (no account), only the first emits the notice,
and the marker does not introduce a sandbox block. Existing appearance settings
written by client initialization are permitted alongside that marker.

Validation:

- `bun run typecheck`: passed.
- `bun run lint`: passed.
- Focused permission/settings/sandbox-contract/migration suites: 77 passed,
  one native launch test deliberately filtered after an initial run failed at
  Seatbelt launch in this restricted harness (77 passed / 1 failed).
- Focused transcript footer/legend, CLI flags and explore checks: 9 passed.
- JSON notice and CLI flags checks: 2 passed.

These results do not certify OS containment or the original port-based e2e
suite. The coordinator must rerun `bun test tests` on its unrestricted macOS
Seatbelt machine, especially #12, whose reported failure is not reproduced here.
