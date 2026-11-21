# Outside-workspace approval parity

Requested 2026-11-22: replace unconditional working-directory refusal with
Claude-like approval. This explicit user instruction supersedes the hard boundary
in the prior project instructions and ADR 0067. ADR 0092 records the final design.

File tools normalize external paths without granting authority, then use the
existing dispatcher permission path. Default and acceptEdits ask for external
reads/writes; explicit rules, user answers and bypass mode can allow them.
Workspace/additional-directory normal behavior is retained. Review/Plan,
read-only children, hard protected paths, deny rules, secret handling and
revalidation remain. Search approval scopes to the requested file/directory,
with per-result rules and symlink containment. LSP results cannot reveal snippets
from an unapproved external location merely because resolution is possible.

An external Bash cwd is normalized and bound into its normal command approval.
Runtime cwd authority is limited to that invocation; it never expands the OS
sandbox's write roots. Unsandboxed execution has normal OS filesystem access.
Instructions/project-context discovery remain project-scoped. No repository
settings are automatically written/trusted and no directory is silently granted.

Implementation/checklist:

- Regression tests for external Read/Search/Write/Edit/apply_patch/cwd, approval
  denial, acceptEdits, bypass, Plan/read-only, explicit rules and cancellation.
- Normalize canonical external read/write targets using narrow per-operation
  roots; preserve directory-relative no-follow writes and exact grant scope.
- Add outside-read/search prompts and write scope/mode handling; revalidate
  target, permission and grant revocations before execution.
- Cover LSP rename targets and external-result snippets; preserve service launch
  confinement and sandbox failure behavior.
- Update descriptors, project instructions, public contract/consumers and ADR0092.
- Run focused security/native/SDK tests, typecheck/lint and integration suites.

## Verification (2026-11-22)

Implemented the checklist above; final decision: ADR 0092, contract 1.46.

Final focused acceptance: `bun test` on outside-workspace-approval,
permission-modes, skills, checkpoints, read-tools, file-edit, lsp and
project-context: **103 passed, 2 skipped, 0 failed** (774 assertions).
The skipped tests require a real installed TypeScript language server.
Typecheck, formatting of the changed implementation files and diff checks pass.

The broad run is not green: it observed core iterator/recovery failures and
module-loader errors for CONTEXT_COMPACTION_FRACTION while shared core/contracts
files were changing. A fresh focused process loads those modules and passes the
acceptance above. A separate provider-cli run also observed AUTH/BUDGET being
reported as PROTOCOL. These results do not establish whole-project acceptance.
No user settings, trust hashes or conversation state were changed.
