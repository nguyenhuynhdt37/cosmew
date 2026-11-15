# Task 03B — supervision acceptance

2026-11-15, macOS 15.8.1 (24H32), Bun 1.4.4. Continuation from `dev/88ff47e`. [ADR 0023](../adr/0023-process-supervision.md), [source research](process-supervision-research.md).

**Production exec_command remains CLOSED on every platform.** Task 03B hardens ownership, local cleanup and truthful reporting. It does not establish enforced whole-tree termination. No Linux/Windows native runtime, helper/dependency, PTY, write_stdin, file-writing tool, MCP or next task is enabled.

## Changes and contract migration

- Tools-private ProcessSupervisor tracks owned runs, forwards cancellation, closes admission and awaits bounded local settlement. No global process registry or production descendant enumeration remains.
- Signals target the original group only while its owned leader has no observed exit. Numeric identifiers remain a best-effort mechanism with no kernel-stable identity proof. No saved-PID retry occurs after observed leader exit.
- Leader exit, requested stop, output EOF/cutoff and unconfirmed descendants are separate observations. Stop settlement is bounded by 1000 ms and post-exit output drainage by 250 ms, subject to event-loop scheduling. Local pipes/timers are released; this is not a receipt for descendant death.
- CLI caches one runtime per client and awaits command-runtime shutdown before subscription/database closure. Concurrent/repeated shutdown is idempotent.
- Contract 1.9 adds optional lifecycle/shutdown fields. Existing injected runtime implementations still compile. Historical results with no lifecycle remain unknown; no database migration or rewrite of stored historical text occurs. Model/TUI timeout text no longer asserts that the tree was killed; pre-launch cancellation does not invent a termination request.

## Actual OS evidence

`tests/security/process-supervision.test.ts` uses real Seatbelt processes on this host and independent `ps` snapshots (PID, start time, command, process group, parent and non-zombie state). Fixture-only cleanup rechecks identity before signalling uniquely marked disposable processes; those checks are not a production containment mechanism or a proof against arbitrary PID reuse.

| Case | Observed / asserted |
| --- | --- |
| Ordinary child, nested shell/pipeline, forked grandchild | Cancellation observes actual leader exit; ordinary group members are independently absent/non-live. |
| Fork + setsid + parent exit + reparenting | Detached child remains live after the runtime returns exit 0 for its leader; process group equals its PID and parent becomes PID 1. Two identity observations confirm survival. |
| Detached child sandbox inheritance | Child's attempted disposable workspace write reports WRITE_DENIED; no file appears. Access confinement persists even though lifetime containment fails. |
| Inherited pipe writer | Leader exit does not imply EOF; capture is cut off and marked truncated rather than waiting indefinitely. |
| Timeout | Stop is requested; observed leader exit is recorded; model and TUI report descendant termination unconfirmed. |
| Runtime shutdown | Active run is cancelled, admission closes, repeated shutdown settles without starting another process. |
| Supervisor crash | A disposable worker is killed through its owned ChildProcess handle. Independently observed ordinary and detached children survive: JS cleanup has no crash guarantee. |
| Rapid exits / stale ownership | Repeated completed runs leave activeCount zero; later shutdown leaves an unrelated disposable sentinel alive. This does not simulate forced PID reuse. |
| Pre-cancellation / failed spawn / repeated runs | No invented exit code or stop request; ownership returns to zero and collectors close. |
| Flood + inherited writer | Retained bytes remain bounded, omitted bytes counted and capture cutoff reported separately. |

`tests/end-to-end/exec-command.test.ts` verifies per-client runtime reuse across two sessions and exactly one owned shutdown across concurrent callers. Existing direct/Codex fixtures exercise permissions, result pairing and stored resume; production descriptors remain read/glob/grep only. These fixtures are not live-provider compatibility evidence.

The shutdown fixture initially lost its command marker because bash could exec its last sleep command. It now waits for a background child, retaining the leader marker. The detached writer explicitly flushes stdout, so buffered Perl output cannot hide the post-detachment denial observation.

## Verification

Focused final run: `bun test tests/security/process-supervision.test.ts tests/end-to-end/exec-command.test.ts` — **18 pass, 0 fail**, 155 assertions. `bun test tests`: **343 pass, 5 skip, 0 fail**, 82149 assertions across 32 files (55.57 s). `bun run typecheck` and `bun run lint` passed. The five skips require native vault/installed-runtime/real-login conditions and are not verified here. New documentation links resolve; nine pre-existing links in the historical repository map point to moved TUI files and remain outside this task.

## Remaining security gate

macOS still has no demonstrated enforceable lifetime boundary for setsid/reparented descendants or abrupt supervisor death. Linux cgroups/PID namespaces are research candidates only. Enabling execution requires real production-path adversarial evidence for lifetime containment, crash cleanup, stable identity, unchanged filesystem/network/secret policy and safe output truncation. Passing tests that confirm survivors keeps the gate closed. Product MVP/live interactive acceptance is not claimed.
