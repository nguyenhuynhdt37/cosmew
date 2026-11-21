# OpenCode context and tool output

## Tool output limits and recovery

### Takeaway
OpenCode also truncates outputs. The meaningful difference is recoverability and avoiding a second untracked cut, rather than truncation being intrinsically wrong.

### Cited Findings
- Inspected read-only clone revision `852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252`, commit date 2026-11-18 03:28:37 UTC; source and official live docs accessed 2026-11-19. Generic output defaults are 2,000 lines and 50 KiB. Above either limit, it saves full joined text in `path.join(global.data, "tool-output", "tool_" + id)`, returns a head preview and marker with line coverage and full-output path, and metadata `truncated: true, outputPath`. Retention is seven days. If saving fails, the marker explicitly says full output could not be saved. Results already declaring `metadata.truncated` bypass this generic cut. — [Pinned tool-output.ts](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/tool-output.ts)
- `read` pages by offset/limit, up to 2,000 lines and 50 KiB, with long individual lines bounded to 2,000 characters. A partial page gives an explicit next offset. — [Official tools docs](https://opencode.ai/docs/tools/); [Pinned read producer](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/tool/plugin/read.ts); [Pinned read filesystem](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/tool/read-filesystem.ts)
- Shell captures stdout/stderr in its backing file and returns bounded tail with the output path when truncated. Official docs confirm large output is shortened while complete output stays in a managed file. — [Official shell docs](https://opencode.ai/docs/tools/#shell); [Pinned shell producer](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/tool/plugin/shell.ts)

### Inferences
- Hannes should attach a retrievable output handle/path and byte/line coverage to a preview. For read pages, honor the producer pagination instead of cutting away the middle again in context builder. Do not simply remove all bounds: OpenCode is bounded too.
- Hannes must keep retrieval behind ToolDispatcher and policy checks; upstream storage paths should not be copied as a security bypass.

### Gaps
- These are source/documentation observations, not live quality benchmarks. I did not run a model or the OpenCode app.

## Compaction and continuation

### Takeaway
OpenCode compacts before the next ordinary request and continues work with a new context. Its default 85% threshold is a compaction trigger, not a reason to withdraw tools and force a final answer.

### Cited Findings
- Current defaults: automatic compaction enabled; recent conversation retained approximately 15,000 tokens beside the summary; buffer 15% of input/context window, at least 16,000 tokens where the window permits. Custom buffer percentage/token count is configurable. Summary sees the full current conversation when it fits, for prompt-cache reuse. — [Official compaction docs](https://opencode.ai/docs/compaction/)
- Pinned implementation `calculateCeiling` subtracts max(15% window,16k) by default; `inputWindow` respects the minimum of known input and context limits. It keeps a recent tail from a user boundary so tool-call/result exchanges stay paired. Background summary precomputation is enabled; it starts up to 60k tokens before the threshold, swaps in at the threshold, and retains subsequent messages. If oversized, the summarizer transcript progressively clips/removes tool outputs and older exchanges. — [Pinned compaction.ts](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/session/compaction.ts)
- In `runStep`, `compaction.compact({reason:"auto",...})` runs before the primary request; completed compaction causes `continue` to reload context and build a normal request. Provider context overflow gets one compaction recovery attempt. A separately configured agent step ceiling can end tool use. — [Pinned runner/llm.ts](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/session/runner/llm.ts)

### Inferences
- Fix Hannes's ordering: compact at the chosen threshold, recalculate usage after replacement, continue tools. Reserve a final-answer/error path for unsuccessful compaction or genuine budget exhaustion. The present 85% tool stop preceding a 90% compact trigger is inconsistent with this lifecycle.
- Preserve recent evidence beside the summary; summaries alone lose exact details. Background compaction is a later optimization, not required for the first correctness fix.

### Gaps
- Older OpenCode descriptions of 40k/20k output pruning are not this revision's implementation. No such standalone pruning policy was found in the current compaction module. Do not mix those historical defaults with current V2 behavior.

## Subagent context

### Takeaway
Subagents isolate exploration output from the parent by using fresh child sessions and returning reports.

### Cited Findings
- Current docs explicitly say subagents use fresh context, their own child sessions, and background execution. Parent receives a report when the child goes idle and after later rounds. — [Official agents docs](https://opencode.ai/docs/agents/#modes)
- Implementation derives a parent report from the last child assistant message, instead of copying all child tool output. — [Pinned subagent-report.ts](https://github.com/anomalyco/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/session/execution/subagent-report.ts)

### Inferences
- For broad independent searches, bounded child reports can reduce parent context noise. This is not evidence that increasing the tool-call count improves reasoning.

### Gaps
- Exact report retention/readback behavior was outside this focused audit.
