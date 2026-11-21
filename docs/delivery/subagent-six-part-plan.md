# Subagent improvements — six-part implementation

Requested 2026-11-22. User authorized six agents, GPT-6.1 Sol medium, to implement
items 1–6 of the proposed Cosmew subagent roadmap. The runtime permits three
child workers concurrently, so work runs in two waves. Root owns integration,
public version updates, ADR 0089 and final checks. No commits or settings trust
approvals are part of this work.

| Item | Deliverable | Owner | Wave |
| --- | --- | --- | --- |
| 1 | Bounded/redacted live assistant text, discard/cancellation correctness | task1_live_subagent_text | 1 |
| 2 | Send instructions from child view through SDK and ToolDispatcher | task2_agent_controls | 2 |
| 3 | Direct opening, agent switching, per-tool expansion | task3_agent_navigation | 1 |
| 4 | Opt-in real-provider harness and bounded live attempt | task4_live_provider_validation | 1 |
| 5 | Clear completion/failure/waiting notices without duplicates | task5_task_notifications | 2 |
| 6 | Durable task history; restored tasks do not imply surviving execution | task6_task_history | 2 |

Preserve existing parent/child ownership, permission checks, session isolation,
redaction and shutdown behavior. Opening an inspector must not start model work.
Sending a message is an explicit action; it must not directly invoke a manager
or bypass the dispatcher. Restoring history must not replay commands or resume
processes. Persistence owns durable writes. No external agent runtime.

Meaningful checks cover progress privacy and cancellation, UI navigation and
focus, explicit messaging permissions, notice deduplication, restart/history and
no execution during restoration. Real provider/OS results are reported separately
from fixture success, including blockers and Needs verification boundaries.

Each worker supplied a dedicated `subagents-N-*.md` delivery report. Final root
integration results follow below.

## Delivered behavior

All six worker scopes were implemented and reviewed. Detailed evidence:

1. [Live text](subagents-1-live-text.md): coalesced updates, rollback and cancellation.
2. [Agent controls](subagents-2-controls.md): explicit remappable compose mode,
   SDK ownership/cancellation and actual dispatcher permissions.
3. [Navigation](subagents-3-navigation.md): direct entry, sibling switching,
   per-tool expansion and parent-scoped presentation retention.
4. [Real-provider test](subagents-4-live-provider.md): authenticated ChatGPT API
   lifecycle and idle-parent progress; xAI billing blocker remains explicit.
5. [Notifications](subagents-5-notifications.md): one scoped terminal notice,
   permission waiting and interrupted labels.
6. [Task history](subagents-6-history.md): real SQLite reopen/migration,
   archive bounds, source-runtime ownership and no execution during restoration.

Shared contract is 1.43; SQLite schema is 11. See
[ADR 0089](../adr/0089-subagent-task-management.md). No new dependency.

Root integration additionally connected background lifecycle events to SDK via
an optional `observeSubagentEvents` port. A live child can now update an inspector
while the parent is idle; discarded provisional text is removed. Immutable parent
attribution comes from child metadata. The same handler projects parent-stream
and out-of-turn events, without starting another loop or changing active session.

Notification reset is idempotent within the same session, preventing companion
completion sources from repeating after transcript reset. A real task-start
event re-arms notification delivery for explicit same-ID child resumption.
Full-screen child views own Escape instead of higher-ranked outer dialog
fallbacks; end-to-end `/agents` navigation verifies back and targeted stop.

The permission correction intentionally changes fixtures that relied on
unprompted `agent_message`: the lifecycle fixture now supplies the explicit
trusted launch allow rule for that tool. Production permission tests continue to
exercise prompts/denials/revocation. Schema tests now treat 12 as a future schema.
Two asynchronous TUI fixtures wait for their semantic result instead of assuming
that `idle()` proves an account-verification request has already begun.

## Integration verification — 2026-11-22

- TUI: **581 pass, 4 skip, 0 fail**, 585 tests across 68 files, 8 snapshots.
- Authenticated ChatGPT API / `gpt-6.2-sol`: **1 pass, 17 assertions**, 25.15 s.
  Confirms real spawn, parent continuation, idle-parent progress, child output,
  completion, exact child stop, sibling preservation and parent survival.
- Typecheck, unused checks, repository Prettier and `git diff --check`: passed.
- Core/end-to-end: **1,027 pass, 9 skip, 0 fail**, 1,036 tests across 130 files,
  22,726 assertions. The live-provider harness is one of the default skips.

The first integration run found five failures: two old future-schema expectations,
one lifecycle fixture missing the now-required message permission, and two
asynchronous fixture races. These were corrected without weakening production
permission or read-before-edit checks. The final complete run is authoritative.

Default test runs skip the live-provider test and spend no API credits. xAI
`grok-4.7` returned PROVIDER_BILLING; no xAI success is claimed. Physical terminal
parity, all-provider acceptance, live explicit messaging and cross-OS process
reattachment remain Needs verification. History restoration does not resume work.
