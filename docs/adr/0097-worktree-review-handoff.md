# ADR 0097 — Reviewed, guarded worktree handoff

Date: 2026-11-22. Status: accepted. Shared contract: 1.49 (was 1.48).

## Problem

Worktree children normally leave edits uncommitted because their Git common
directory is read-only. The old completion instruction recommended merging the
branch, which can integrate no edits at all. Parent edits must also survive a
handoff reviewed before the parent changes again.

## Decision

The workspace owner prepares a read-only handoff from the worktree's original
base commit to its final tracked working files, including committed, staged and
unstaged changes, plus nonignored untracked files. It reports committed and
uncommitted state separately. Git uses the existing hardened environment, no
hooks/fsmonitor, disabled filters, and no external diff or textconv. File reads
use SecureFiles descriptor-relative traversal; symlinks and nonregular files
are refused. The main checkout is never written by this inspection.

A bounded completion note includes a complete ordinary `apply_patch` JSON input
for supported text files whose current parent content still equals the base.
It includes additions (null preimage), updates and deletions. Renames appear as
an add and delete. The parent reviews this untrusted data and invokes its normal
dispatcher. Approval, protected-path checks, plan/read-only denial, audit,
cancellation and postapproval snapshot revalidation remain unchanged. There is
no host copy/merge executor or permission grant in a completion note.

Contract 1.49 adds optional `expected_files` to `apply_patch`: a mapping from
canonical patch target paths to lowercase SHA-256 UTF-8 content hashes, or null
for missing files. Guard mode requires an exact key set covering every source
and destination. All hashes are checked against verified snapshots before any
approval or write. A changed preimage refuses the entire patch. Optional `expected_modes` adds a matching complete key set of permission bits
(or null for absent files), and requires `expected_files`. Handoffs include both
guards, so a parent chmod also conflicts before a reviewed deletion. Normal patch
matching may reject first (`PATCH_MISMATCH`); otherwise an invalid guard returns
`PATCH_CONFLICT`. After approval, the existing runtime revalidates those same
snapshots, so a later change cannot overwrite the parent. Legacy calls without
guards retain their current behavior. No event, durable schema or dependency
changes are needed; current headless consumers advance to 1.49.

The internal manager receives a read-only handoff callback from composition;
its result precedes the child summary so bounded background notifications keep
the review instructions. Every handoff is redacted before any foreground result,
background summary/event, or notification. If redaction changes the raw review
or its decoded machine JSON patch, the entire automatic patch is suppressed
with a manual-review notice. A redacted after-image is never offered as an
integration patch. Unchanged JSON remains byte-exact, including XML-safe escapes. Finish never deletes a changed worktree, even after a
patch was applied. The parent/user must verify all results before explicitly
removing it. A failed/conflicting/partial apply keeps the source available.

## Bounds and unsupported changes

Inspection considers at most 32 changed paths and emits a complete JSON input
of at most 2,200 characters. It never truncates a patch into invalid syntax.
Omitted paths have a manual-review notice. Base blob reads are limited to 16 KiB;
large resulting patches are omitted. Updates use a contextual hunk around the
changed lines rather than replacing the entire file; context expands until its
old slice is unique or EOF-anchored. Full-file hashes still guard omitted lines.
Regular UTF-8 LF text (including empty files) is supported, including tracked
executable files whose Git executable classification is unchanged, including
restrictive umask modes 0700/0750 as well as 0755. Non-executable
0600/0640/0644/0660/0664 files are accepted: updates preserve the exact parent
mode and preimage mode guards still reject later chmod changes. New text uses
`0644 & ~process.umask()` (SecureFiles absent-file snapshots now honor the host
umask, including CLI startup 0077), never adding executable permission. A
different new-file mode is explicitly described in the review. If the child
file is more restrictive than that parent creation mode, automatic integration
is refused for manual review rather than widening its permissions. Executable
additions and actual executable/mode changes require manual integration.
Binary files, symlinks, other mode changes, BOM,
CRLF and missing-final-newline changes are explicitly left for manual review;
there is no lossy conversion or force-copy. Ignored files are outside the handoff
inventory. Omitted/unsupported changes remain in the worktree and require
ordinary approved read/edit/write operations for supported text or explicit
manual integration. Oversized handoffs are not an automatic batch-import UI.

## Evidence

Source inspected 2026-11-22: `packages/workspace/src/worktrees.ts`,
`packages/agents/src/subagents.ts`, CLI worktree composition,
`packages/tools/src/handlers/apply-patch.ts` and its existing runtime. Audit
trigger: `docs/delivery/product-audit-2026-11-22.md`, item 5. No upstream parity
claim is made.

`tests/security/subagent-worktree.test.ts` uses real temporary Git repositories
and the real dispatcher to integrate committed plus uncommitted content,
untracked/empty files and deletions, and to prove conflict/denial/stale-approval
preservation. It also checks unsupported files and repository filter/external
diff nonexecution. Additional regressions cover a one-line edit in a 150-line
executable file, repeated context, 0664 normalization, restrictive 0600/0700 preservation, private new-file
creation under umask 0077, rejection of permission widening, stale edits outside the
hunk, and foreground/background suppression of secrets in raw and JSON-escaped
patches. Existing apply-patch and subagent lifecycle tests remain
applicable. No provider calls are involved.
