# ADR 0041 — Full `read`: directories, tails, images/PDF, notebooks, did-you-mean, nested AGENTS.md

Date: 2026-11-17. Status: accepted (wave 1 plan W1.5).

## Context

`read` returned only UTF-8 text and failed on directories, media and notebooks. Reference: OpenCode `sst/opencode` @ `0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4` (read 2026-11-17), `packages/core/src/tool/plugin/read.ts`, `packages/core/src/tool/read-filesystem.ts` (`MAX_MEDIA_INGEST_BYTES = 20 MiB`, media types png/jpeg/gif/webp/pdf, list pages, negative offset, did-you-mean, nested `AGENTS.md` after a read); Claude Code's public Read tool behavior for `.ipynb`. No code was copied.

## Decision

All of this stays inside the existing dispatcher pipeline: path resolution in `@futryn/workspace`, `evaluateRead` (deny → ask → allow), approval, revalidation, audit, redaction.

- **Directories** list entries one per line, directories first and marked `/`, paged with `offset`/`limit`; entries the read policy denies (`.git`, Futryn state) are omitted. Secret files are listed by name (as `glob` does) but never read.
- **Negative offset** returns the last N lines of a text file (a directory refuses it).
- **Images and PDFs** are recognised by leading bytes (never by name), up to 20 MiB, and returned as `ToolResult.attachments` (`{mime, data(base64), name}`, contract 1.19) next to a text summary. `Message.attachments` exists on tool messages only. The journal and the TUI transcript receive the result without media; media are stored apart (`tool_attachments`, schema 6), at most 64 MiB per session (oldest dropped first), re-joined to tool messages by call id on resume and fork. Adapters: Anthropic carries media inside `tool_result`; other protocols get one user message after the run of tool results (OpenAI-compatible chat: images only, PDFs replaced by a note). A model whose catalog says `vision: unsupported` gets a note instead of media. Deviation from plan: `vision: unknown` is tried (most catalog entries are unknown; same rule as tools in ADR 0017), not refused. The context-window estimate counts an image as about 1 600 tokens, not its base64 size.
- **Notebooks** (`.ipynb`) render `[n] type (execution k)`, the source and text outputs (stream, `text/plain`, errors); PNG/JPEG outputs become attachments (at most 8, 20 MiB in total). The JSON is data only.
- **Did-you-mean**: a missing path gets at most one suggestion — same name in another case, same stem with another extension, a small typo, or for an absolute path outside the workspace the longest tail that exists inside it — and only if `evaluateRead` is plain allow (never a secret, `.git` or Futryn state, never a path outside the workspace).
- **Nested AGENTS.md**: after a successful read below the working-directory chain, the directories between the file and that chain that hold `AGENTS.override.md`/`AGENTS.md` are remembered for the session (`session_instructions`, schema 6, at most 64) and their contents (through the authorized instruction reader, project-context byte budget) are appended once to that read result. Later turns include them in the project-context user message (marked `nested`), also after a restart. Deviation from plan: they go into the project-context **user** message, not `ModelRequest.instructions`, because repository text never enters the system/developer channel (CLAUDE.md invariant).

## Evidence

`tests/security/read-extended.test.ts` (listing/omissions/paging, tails, did-you-mean incl. secret/.git/outside, media sniffing and 20 MiB bound, secret media still asks, notebooks, vision-unsupported and chat-PDF notes), `tests/end-to-end/read-media.test.ts` (wire format on chat and Anthropic fixture servers, no base64 in transcript or stored message, media and nested AGENTS.md after restart, nested instructions shown once), `tests/contracts/usage-context.test.ts` (schema 6, future schema 7 fails closed).
