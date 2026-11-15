# ADR 0019: Project Context Loader (Task 01)

Accepted 2026-11-15 by the user's explicit Task 01 request. Scope is automatic approved-workspace instruction discovery and transient request injection only. No RAG, LSP, MCP, memory, shell, write tools, new dependencies or package edges.

## Research and current pipeline

Codex source inspected at commit `ee344ca9458351a6ea102795fa73110ad3ede5dc`, accessed 2026-11-15:

- [core/src/agents_md.rs](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/agents_md.rs): root-to-cwd discovery; AGENTS.override.md preferred over AGENTS.md within one directory; bounded content with diagnostics; no trusted project instructions for an untrusted project. Codex can discover a root using configured markers; FUTRYN deliberately uses the already approved workspace boundary instead of probing unapproved ancestors.
- [context/user_instructions.rs](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/context/user_instructions.rs): instruction fragment role is user.
- [context/contextual_user_message.rs](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/core/src/context/contextual_user_message.rs): contextual fragments are distinguished from user authorization.

Source inspection is design evidence, not live model-understanding evidence. Context7's current `/openai/codex` index supplemented the pinned source. No upstream implementation is copied.

FUTRYN: SDK sendMessage -> composition sendTurn -> core Conversation.send -> injected ModelPort. Direct adapters translate Message into provider roles; subscription adapters serialize the same messages as user input. The existing Codex developer instructions are host guidance, not a container for repository text. Existing read/glob/grep use ToolDispatcher -> workspace canonical paths -> security policy -> audited, redacted reads.

## Ownership and contracts

Contract 1.7 adds ProjectContextPort, a bounded snapshot/report and an authorized instruction-reader port. Core optionally loads context once at the start of a user turn. It prepends one user-role message to each model request (including tool rounds), without appending it to durable conversation history. New turns reread/revalidate instructions; no mtime-only cache or stale context history is used. A snapshot is fixed within one turn. Direct API and subscription adapters keep their current role translation; repository content is never placed in system/developer fields.

Workspace owns canonical root/cwd containment, ancestor ordering, document selection, UTF-8 budget assembly and hashes. It receives an injected reader and never imports security/tools. Tools owns an instruction-only bounded raw reader that shares the existing policy, redaction, grants and audit; it is not a new model tool. Automatic discovery skips permission-required targets without prompting or granting them. Composition gates all discovery on folder consent, wires ports and exposes metadata/diagnostics to SDK and /context. No new dependency edge. Persistence schemas are unchanged.

## Discovery, precedence and bounds

- Root is the canonical approved workspace; cwd defaults to that root and can be configured within it. Never search home/global instructions, parents above the approved root, or unrelated nested directories.
- Walk root -> cwd, inclusive, at most 32 directories. Canonicalize cwd and reject escapes, including symlinks. At each directory, AGENTS.override.md replaces AGENTS.md. Fall back to AGENTS.md only when the override is absent; an unsafe/unreadable/empty override is not silently replaced. Deeper applicable instructions win conflicts within their scope; explicit current-user requests and host/security rules remain higher priority.
- Default context budget: 32 KiB; per-file raw read: 16 KiB. Both configurable with a 64 KiB hard ceiling. A zero context budget disables reads. The complete injected message, including metadata, must fit its context budget. UTF-8 prefixes never split code points. Excess, binary, invalid UTF-8, inaccessible and denied files produce explicit metadata diagnostics. Budget exhaustion does not silently claim full coverage.
- Sources record requested relative path, canonical relative target, directory scope, delivered bytes, SHA-256 and truncation. Hashes cover the delivered redacted prefix, not unread bytes of oversized files. Canonical aliases are deduplicated. Fingerprints exclude timestamps and change when effective content/provenance changes. Diagnostics never echo outside-workspace paths or raw instruction content.
- Refresh at every user turn rechecks permissions and catches edits, deletions, newly created overrides and same-size/same-mtime edits. No watcher, memory system or persistent cache.

## Configuration and evidence

Composition createFutrynClient accepts instruction options (workingDirectory, maxBytes, maxFileBytes). HANNES_PROJECT_CONTEXT_MAX_BYTES configures the CLI/TUI budget; invalid/out-of-range configuration is rejected. Diagnostics and loaded source metadata are available in SDK and /context. Existing chat, account/model selection, provider behavior and stored history are preserved.

Acceptance uses temporary projects and captured fixture HTTP requests, including new instructions, nested overrides, repeated turns, edits, byte budgets, permission/symlink denial and cancellation. A real PTY fixture demonstrates opening FUTRYN, approving the folder and sending the rule exactly once, then sending the edited version on the next request. No live model-understanding improvement is claimed.

Implementation evidence (2026-11-15): lint passed; the full suite completed with 278 pass, 5 environment-dependent skips and 0 failures. See [delivery and module details](../delivery/project-context-loader.md) for fixture coverage and acceptance limits.
