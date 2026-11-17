# ADR 0043 — Sandboxed language-server code intelligence

Date: 2026-11-17. Status: implemented in wave 1 (contract 1.19).

## Context and decision

`@futryn/code-intel` owns LSP JSON-RPC framing, the client and lazy manager. It
depends only on contracts/workspace. Tools call its public entrypoint; the CLI
composition root injects a `ServiceProcess` launcher through the native command
runtime. No project binary runs outside the sandbox and no missing/failed sandbox
falls back to a host process. No language server is installed automatically.

The registry offers `lsp` only when helper execution is available. Operations are
`goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`,
`goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`.
Coordinates at the tool boundary are 1-based code-point columns; the client
converts to/from LSP UTF-16 positions. Locations resolve through workspace/read
policy; denied paths are omitted, ask-required paths do not quote source text,
and external locations provide path/line metadata only. Malformed peer responses
fail the call rather than become executable instructions.

A table discovers TypeScript/JavaScript, Python, Go and Rust servers in the
project's `node_modules/.bin` or trusted host PATH. TypeScript 7's installed
`tsc --lsp --stdio` is tried before `typescript-language-server --stdio`.
`basedpyright-langserver`/`pyright-langserver`, `gopls`, `rust-analyzer` are optional.
Nearest project markers determine a root; one client is shared per language/root.
Missing binaries produce explicit installation guidance, not an empty success.

## Process and protocol ownership

Native `spawnService` launches in a fixed read-only, no-network sandbox with
private HOME/TMP. Secret-looking files are masked for helpers even when ordinary
commands use the less restrictive secret setting. A fixed trusted `/bin/sh`
supervisor remains the process-group leader and kills its group on exit, so an
LSP leader cannot leave ordinary same-group descendants after exiting. The
supervisor is not replaced by the server command: another statement and EXIT trap
follow it. This retains group ownership until cleanup instead of signaling a
possibly reused group ID after the leader was reaped. Existing macOS limitation:
deliberate `setsid`/session escapes remain **unconfirmed**, not certified killed.
Runtime shutdown closes admission and terminates helpers before scratch cleanup.

The manager closes admission/aborts initialization at shutdown, owns initializing
peers and terminates late completions. Requests have a 10-second deadline, cancel
with `$/cancelRequest`, and failed peers restart with exponential backoff at most
three times. Initialization has its own 30-second cap. Idle servers stop after
10 minutes. JSON-RPC framing bounds headers to 8 KiB and bodies to 64 MiB, rejects
invalid/duplicate Content-Length and non-object messages, and terminates protocol
violations. Server `workspace/applyEdit` is explicitly refused; unimplemented
server services never execute tools, shell or network.

At most 128 documents are retained per client, with `didClose` on eviction/deletion.
Diagnostics are accepted only for open documents; supplied versions must equal
the current version. Entries require valid ranges/message/severity, and each
publication is bounded. A coalesced recursive watcher re-syncs only previously
opened files after checking current read rules and skipping vendor/ignored
folders. Deleted, retargeted, denied or closed documents lose their lease. A host
without recursive watching falls back to sync-before-request; that fallback is
not proof that file watching works on that OS.

## Writes and diagnostics

`lsp_rename` authorizes its source read before contacting the server. The returned
WorkspaceEdit is validated, resource create/move/delete operations are refused,
paths must remain in the workspace, and every edit range must be in bounds,
ordered and not split a surrogate pair. The source snapshot must still match the
request text. All target files then enter the normal multi-file patch plan,
read/write policy, review diff, target revalidation and apply receipt. It never
uses the server's applyEdit as an alternate write path.

After a successful edit/write/patch, new ERROR diagnostics are added to its JSON
receipt and shown below the change in the transcript. No server means no invented
validation. The current comparison is a **multiset of message/source/code**:
line movement does not relabel old errors, but fixing an old error while adding
the same message elsewhere can suppress that new error. This is not full
range-aware old/new error translation. Results cap at 20 new errors per file,
wait at most three seconds and debounce pushes for 150 ms. Diagnostics are
receipt/transcript data; a standalone SDK `diagnostics.reported` notification is
**not implemented** in this wave.

Project Read deny/ask rules are combined with builtin hard denies for direct
reads, automatic instructions, returned grep/glob/listing/suggestion data and
LSP source snippets. The trusted ripgrep backend can scan data internally before
output filtering (the existing design); its results still pass current policy
before reaching the model. The fallback worker prefilters denied/ask paths and
rechecks returned hits. Project rules are not a per-file OS sandbox for a
malicious language server: helper sandbox, no network, secret masking and output
redaction remain separate defenses.

## Evidence and limits

Read 2026-11-17, behavior ported without source copying:

- OpenCode v1.19.5 `packages/opencode/src/lsp/*`, `tool/lsp.ts`, `tool/edit.ts`:
  https://github.com/sst/opencode/tree/v1.19.5/packages/opencode/src/lsp
- LSP 3.17 base protocol/document sync/rename:
  https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- Local installed TypeScript 7 implementation and its shipped LSP documentation;
  the opt-in test below exercises actual installed behavior rather than inferring
  compatibility from the package version.

`tests/contracts/lsp-rpc.test.ts`, `tests/end-to-end/lsp.test.ts` cover framing,
nine operations, Unicode, source/target permissions, malformed edits, cancellation,
timeout, restart cap, diagnostics, watcher, late-init shutdown and real macOS
Seatbelt helper isolation/secret masking/descendant cleanup. Fixture launchers
in protocol tests intentionally do not claim native-sandbox evidence.

Parent verification on 2026-11-17:
`FUTRYN_TEST_REAL_LSP=1 bun test tests/end-to-end/lsp.test.ts -t 'real installed TypeScript LSP'`
passed with actual native-sandbox initialize, definition and rename assertions.
This is real local TypeScript LSP evidence, not authenticated model generation.
Python/Go/Rust servers, Linux bubblewrap and Windows remain **Needs verification**;
Windows helper execution is unavailable. Final suite counts are in
[wave acceptance](../delivery/wave-1/acceptance.md).
