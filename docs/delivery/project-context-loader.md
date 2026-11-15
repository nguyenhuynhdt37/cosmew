# Task 01 — Project Context Loader

Implemented scope: automatic project instructions only. No RAG, LSP, MCP, memory, shell/file-write tools, new dependencies or live model-understanding claim. [Design, source research, scope and migration: ADR 0019](../adr/0019-project-context-loader.md).

## Use and precedence

Start `hannes tui` inside the project and approve the displayed folder. The approved folder is the discovery boundary; FUTRYN never searches its unapproved parents or home-directory instructions. Guidance loads before each conversational model request. Startup connectivity probes, noninteractive output and unapproved clients do not read project instructions.

For each directory from the approved canonical root to the configured working directory:

1. Prefer `AGENTS.override.md`; otherwise use `AGENTS.md`.
2. An existing unsafe, unreadable or empty override is not silently replaced with the ordinary file.
3. Sources are ordered root -> cwd. Deeper applicable guidance wins conflicting ancestor guidance in that scope. The current explicit user request and host/security rules retain higher authority.

The normal CLI working directory is its approved root. Embedders that have approved a broader root can call `app.createFutrynClient(root, {workingDirectory: 'packages/example'})`. Only the ancestor chain is scanned, not unrelated nested trees. Outside/symlink-escaping working directories are rejected with diagnostics. Discovery is capped at 32 directories; over-deep chains are skipped instead of silently omitting local overrides.

## Bounds and refresh

Default complete injected-message budget: 32 KiB. Default per-file raw read: 16 KiB. Both have a 64 KiB ceiling. Configure CLI/TUI with `HANNES_PROJECT_CONTEXT_MAX_BYTES=16384 hannes tui`, or pass `{maxBytes, maxFileBytes}` to createFutrynClient. Zero disables loading; invalid/out-of-range values are rejected. Metadata and JSON escaping count against the injected-message budget. Truncation respects UTF-8 boundaries. Binary/invalid UTF-8, denied and inaccessible files are skipped with diagnostics; automatic loading does not ask for new secret-file permissions.

Every turn rereads and revalidates the candidates. Edits of the same size and mtime, deletion, and newly created overrides are therefore detected. One snapshot is reused within that turn's tool rounds. The injected user-context message is never added to stored history, so repeated turns, resume, account forks and model changes do not accumulate old instructions. No watcher or persistent cache is introduced.

Sources track requested and canonical relative paths, scope, byte sizes, truncation and SHA-256 of the delivered redacted prefix. This hash is not a full-file hash for oversized documents. Metadata fingerprints exclude load timestamps. `/context` reports source metadata, budget and diagnostics; a completed chat shows a note when instructions were skipped/limited. The SDK projectContext() method returns metadata without raw instruction text. Estimates include the injected bytes once; they remain local heuristics.

## Changed modules

| Module | Change |
| --- | --- |
| contracts | Optional injected ports, bounded snapshot/report/options; contract 1.7, no storage migration. |
| workspace | Canonical root/cwd chain, override selection, aggregate UTF-8 budget, provenance/hash/fingerprint and fresh loads. Filesystem metadata distinguishes inaccessible from absent. |
| tools/security | Instruction-only raw reads share existing policy, audit and redaction; skip new ask-required access, recheck grants, and normalize Windows state-directory comparisons. No new tool descriptor. |
| core | Load via port and prepend one transient user-context Message; no filesystem/SDK imports. |
| CLI composition | Per-approved-workspace loader and reader wiring; validated options/env configuration; existing new/resume/fork routes preserved. |
| Codex host guidance | Reuse supplied project context rather than instructing redundant rereads; project text is still user-scoped. |
| SDK/TUI | Content-free source reports, diagnostic notes and `/context` details; injected bytes enter the local estimate once. |

## Deterministic acceptance evidence

`tests/security/project-context.test.ts` covers root/nested/override discovery, no-file/empty behavior, same-size/same-mtime edit and deletion, full-message budget and UTF-8 truncation, inaccessible/binary/invalid text, symlink/outside/secret/state denial, alias deduplication, grant revocation, redaction of partial known secrets and cancellation. Windows path-policy strings are checked separately; this is not native Windows filesystem acceptance.

`tests/end-to-end/project-context.test.ts` captures real HTTP fixture requests and verifies one current user-context block, no system/developer promotion, no stale rule in subsequent/resumed requests, no project context in durable history, correct nested order, configuration, account/model routing, and permission denial despite malicious project text. It covers Chat Completions, Responses, Anthropic and Gemini fixtures. `tests/end-to-end/subscriptions.test.ts` verifies the Codex fixture receives the current rule once as user data, never as developer instructions.

The actual PTY test launches FUTRYN in a temporary project, approves the folder, sends an architecture question, checks the fixture request contains `TASK01_PTY_V1` exactly once, edits AGENTS.md to `TASK01_PTY_V2`, sends another question and verifies only V2 is delivered. This demonstrates delivery/refresh, not model understanding. The existing thinking/model-change PTY fixture now explicitly uses its temporary project cwd, so it no longer implicitly reads this repository's own AGENTS.md when asserting an instruction-free context of zero.

Verified 2026-11-15: `bun run lint` passed; `bun test tests` reported **278 pass, 5 skip, 0 fail** across 26 files. The five skipped checks require native vault/installed-provider or interactive login acceptance and are not counted as verified. Existing provider/chat tests and the deterministic PTY acceptance passed. No live model-understanding evaluation was performed.
