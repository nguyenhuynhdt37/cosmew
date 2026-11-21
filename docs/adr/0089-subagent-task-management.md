# ADR 0089 — Live subagent control and durable task history

Date: 2026-11-22. Status: accepted. Shared contract 1.43; SQLite schema 11.

## Context and decision

The user authorized six coordinated improvements: live child text, sending child
instructions, direct navigation, real-provider validation, task notifications,
and inspecting history after restart. Build on ADR 0070 and ADR 0088 instead of
adding an executor, a provider-owned agent runtime or an independent loop.

### Live conversation and navigation

The manager coalesces assistant deltas into existing text steps at 100 ms,
response/tool boundaries and completion. Redact the cumulative response before
bounding its visible step to 4,000 characters; keep at most 64 live steps.
Discarded responses retract their provisional step; cancellation/failure clears
pending timers. Final response steps are not duplicated by an aggregate summary.
Inspection uses the live scheduler projection when available and durable child
messages otherwise. The injected model redaction boundary remains authoritative.
The optional SDK `observeSubagentEvents` composition port carries attributed
background lifecycle updates independently of the parent's send iterator. The
composition root resolves the immutable parent from stored child metadata; SDK
uses the same projection handler for streamed and out-of-turn events. An idle
parent therefore does not prevent progress/discard updates reaching its viewer.

Footer selection opens the task directly; opening from `/tasks` retains a task
list back destination. Left/Right switch owned sibling agents. Main transcript
components provide mouse and keyboard tool expansion, with remappable actions.
Per-panel presentation retention is parent-scoped, bounded to 32 agents and 512
expanded activities per agent. Opening/switching never starts provider work.

### Explicit child instructions

SDK adds `sendSubagentMessage(agentId, message, signal?)` and a composition port
that invokes the existing `agent_message` through ToolDispatcher. Validate child
ownership, bounded nonempty input, tool availability and cancellation. Steer a
running child or explicitly resume a finished child using existing manager
semantics. Merely inspecting history cannot resume it.

`agent_message` now goes through the ordinary approval adapter. The additive
`agent.spawn` prompt capability permits representing its existing execution
capability in permission dialogs; `Tool(agent_message)` deny/ask/allow and mode
rules remain authoritative. Plan/read-only mode denies messaging; approval is
bound to the exact parent, workspace, child and input. Revalidate after approval.
The TUI uses an explicit compose mode so message text cannot trigger navigation
or stop shortcuts. Failed/cancelled sends retain their draft and truthful result;
permission overlays do not turn an unconfirmed send into success.

### Notifications and waiting state

One TUI notification path handles delivered shell/agent completion events and
child notices. Deduplication shares the agent identity across both SDK sources,
is bounded to 512 recent keys, and resets per active session. Missing/foreign
attribution cannot establish ownership. Foreground results remain in the normal
tool transcript. Notices identify success, failure or cancellation and the task
to inspect without redirecting a streaming parent or replacing permission UI.
Resetting a transcript in the same session does not clear task deduplication;
an actual task-start event re-arms the identity for explicitly resumed work.
Permission waiting and interrupted history are presentation labels derived from
existing requests/snapshots, not new execution statuses.

### Durable shell snapshots

Persistence exports `SqliteBackgroundTaskHistory`; SQLite migration 10→11 adds
`background_task_history` keyed by conversation and task ID. Descriptions and
output are redacted before serialization and bounded to 1,024/8,192 characters.
Retain 200 snapshots per conversation and 5,000 globally. Conversation deletion
removes archives transactionally.

The composition registry persists snapshots before completion publication and
tracks the original source runtime, including child shell runtimes. Owned live
state overrides archived history; a received terminal event wins over a stale
runtime snapshot. Only a current live task and its original runtime confer stop
authority. New registries show historical running shells as stopped and orphan
children as interrupted/PROCESS_EXIT. Reading/restoring never relaunches a
command, replays completion delivery, reattaches an OS process or resumes a model.

## Evidence and limits

Each implementation has a delivery report linked from
[the six-part plan](../delivery/subagent-six-part-plan.md). Tests cover progress
redaction/discard/cancellation, main/child UI isolation, navigation and expansion,
message permissions, duplicate/foreign notices, SQLite reopen/migration/retention,
and absence of execution while restoring. Final root integration results are
recorded in that plan.

Authenticated evidence on 2026-11-22: `chatgpt-api` / `gpt-6.2-sol` passed 17
assertions for real background spawn, parent continuation, output/completion,
out-of-turn progress while the parent was idle, targeted cancellation and parent survival. `xai` / `grok-4.7` returned
PROVIDER_BILLING; no xAI success is claimed. The opt-in harness uses Cosmew's own
API/dispatcher loop and a synthetic temporary workspace, with no global
account/model change. See [live report](../delivery/subagents-4-live-provider.md).

This does not certify all providers, physical terminal parity, Linux sandboxing,
process reattachment after crashes or general Product MVP completion. Explicit
message controls and restart behavior have separate fixture/SQLite evidence;
they are not implied by the authenticated lifecycle test. These additional live
acceptance cases remain **Needs verification**. No dependency was added.
