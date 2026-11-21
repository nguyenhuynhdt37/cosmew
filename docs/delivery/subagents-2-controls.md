# Explicit child instructions

Contract 1.43 adds `client.sendSubagentMessage(agentId, message, signal?)` and the
optional owning-parent backend port. The result is the actual `agent_message`
`ToolResult`, including errors and delivery details. Unsupported hosts reject;
viewing history never resumes an idle child.

In the full-screen child conversation, `i` (`Footer.footer:messageAgent`) enters
compose mode. Enter sends; Escape cancels compose and retains the draft. The
`AgentCompose` keymap context owns input while composing: `x` is text and arrow
keys cannot switch children or stop work. Its submit/cancel/delete/navigation
bindings and entry binding are remappable through the central keymap.

Only an explicit send steers a running child or asks the existing agent manager
to resume an eligible finished child. Unknown, foreign-parent and closed children
fail truthfully. Text must be nonblank and at most 100,000 characters, matching
the existing tool schema. The SDK checks tools consent and active-parent
ownership; the production port rechecks ownership and invokes the existing tool
port/dispatcher. UI and SDK never call the manager directly.

`agent_message` now consults the approval adapter under capability `agent.spawn`
and rule `Tool(agent_message)`. Default and acceptEdits ask; deny/ask/allow rules
and bypass semantics follow the existing permission engine. Plan/Review,
permission plan and read-only children deny messaging before execution. Other
agent tools retain their existing behavior. Session approvals hash exact input,
parent session and workspace; the prompt shows only the bounded/redacted child
target, never instruction text. Current mode and parent are checked after the
approval await; SDK parent/tools changes abort the pending operation, and rule
revocation settles pending approval through the existing permission engine.

Permission dialogs can replace/unmount the child view. A per-client, per-parent
and child in-memory cache retains drafts, pending sends and actual outcomes for
reopening. It holds at most 32 entries, evicting an idle entry first and aborting
an old pending entry if needed. Parent/tools changes clear stale entries and
abort pending sends. Reopening requires entering compose again, preventing the
Enter used to open a child from resending a retained draft. No drafts are logged
or persisted. Cancellation does not undo instructions already delivered.

Verification: focused SDK tests cover real production dispatcher approval,
consent, deny/revoke, plan denial, exact-message session scopes, cancellation,
parent change and unknown ownership without provider generation. Ink tests cover
explicit completed-child send, stop/navigation isolation, permission replacement,
failed draft retention and successful retry, plus existing history/navigation
behavior. No live-provider or OS compatibility is claimed.
