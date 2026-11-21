# Claude Code context management

Checked 2026-11-19. Evidence is official public documentation, not inspection of private runtime source; no immutable docs revision was exposed. Version gates below are those stated in current docs.

## How does it handle large tool results?

### Takeaway
Claude Code also bounds tool output, but commonly provides retrieval or pagination instead of treating the excerpt as the complete evidence.

### Cited Findings
- Bash streams output to a working file. A valid result above roughly 30,000 characters becomes a session-file path plus a preview up to 2,000 characters; the agent can read/search the file. Saved output is truncated beyond 64 MiB. Failures above roughly 10,000 characters instead get a head/tail excerpt without a file path. — [Official tool reference, output limits](https://code.claude.com/docs/en/tools-reference#output-limits)
- Read defaults to 25,000 tokens per call. Oversized reads receive a partial-page notice or an error directing pagination/search. From v2.1.296, `allow_large: true` sizes text reads against remaining context capacity. — [Official tool reference, large files](https://code.claude.com/docs/en/tools-reference#large-files)

### Inferences
- For Hannes, the useful pattern is explicit partial coverage plus a recoverable source. Simply removing every limit would not reproduce Claude Code's design.
- Full log artifacts should retain exit status, truncation status, source/call ID, and a permission-mediated read/search path. Treat a preview as partial evidence.

### Gaps
- No live Claude Code run was performed. Exact private serialization, cross-tool offload defaults, and behavior on old installed versions remain Needs verification. Bash failure handling shows that even Claude Code does not preserve every result in a retrievable file by default.

## Does context pressure stop work or compact and continue?

### Takeaway
The documented normal behavior is compaction followed by continued work, with explicit protection against repeated useless compaction.

### Cited Findings
- Anthropic describes Claude Code passing history to a model-written summary, retaining architectural decisions, unresolved bugs, and implementation details while discarding redundant output; work continues with compacted context and recently accessed files. It warns aggressive compaction can lose critical details and recommends tuning for recall first. — [Anthropic engineering article, published 2025-09-29](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- Current docs say auto compaction summarizes near context limits; if a huge file or result immediately refills the context after several summaries, it stops with a thrashing error. — [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up)
- Thresholds are model/config dependent: native 1M models currently compact at approximately 967K tokens. `/autocompact`, settings, flags, and environment overrides configure the window. This is not a universal 85% or 90% rule. — [Model configuration](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction)
- Root instructions, memory, plan, and skill metadata are re-injected; up to five recent read/edited files are reread. Nested instructions and path-scoped rules reload on demand. — [What survives compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction)

### Inferences
- Hannes should attempt useful compaction before withdrawing tools, retain the actual active objective and unresolved work, and then resume the same agent loop. Detect no-gain/thrashing explicitly rather than assuming compaction always helps.
- File evidence, summaries, and permission grants are different kinds of state; never reconstruct approval from a summary.

### Gaps
- Public docs describe behavior, not every reserved-token calculation or exact private compaction algorithm. Current docs differ in fine wording from the older engineering article; prefer current docs for current behavior.

## How do subagents preserve context?

### Takeaway
Subagents isolate noisy exploration in a separate window and return a summary, while each child independently supports compaction.

### Cited Findings
- A subagent starts fresh unless forked; either way, its tool calls remain out of the parent's context, with a summary returned. — [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works#manage-context-with-skills-and-subagents)
- Subagent auto-compaction triggers on its own window; compaction events are logged in its transcript. — [Subagent auto-compaction](https://code.claude.com/docs/en/sub-agents#auto-compaction)

### Inferences
- Hannes can use explorers for independent high-volume searches, but delegation alone is not a fix for lost evidence. Child summaries need precise file/symbol references and a way to retrieve underlying evidence.

### Gaps
- No claim that more tool calls, longer latency, or more subagents inherently produces better understanding. Comparing quality requires matched task/model evaluation.
