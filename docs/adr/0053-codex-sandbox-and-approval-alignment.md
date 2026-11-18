# ADR 0053 — Sandbox and approvals follow Codex exactly

Date: 2026-11-17. Status: accepted (user decision after the S0 Next.js UAT, `docs/delivery/wave-2/uat-nextjs.md`: "follow Codex exactly on permissions and sandbox; remove Futryn's extra controls that are stricter than Codex").

## Context

The UAT (a Futryn agent building a Next.js app under the macOS Seatbelt sandbox, 76 tool calls, 26 approval prompts in 5 turns) found controls that Codex does not have and that broke ordinary work: `next build` failed reading a parent repository's `.git`, dev servers could not listen on localhost, FSEvents file watchers could not start, npm could not use any cache, harmless commands the parser could not split were asked about, and `sandbox_permissions: "require_escalated"` (the Codex field every Codex-trained model sends) was refused.

Reference: openai/codex @ `090be4df0724cdef5758e6a0934ba557af8b6bbe`, cloned read-only to `/tmp/ref-codex` and read 2026-11-17:

- `codex-rs/core/src/exec_policy.rs:868-950` `render_decision_for_unmatched_command_for_platform`: a dangerous command prompts (`never`: forbidden); otherwise `never` allows, `untrusted` (`UnlessTrusted`) prompts, `on-request` in a restricted sandbox allows unless the call requests a sandbox override. Nothing asks because a command is "unparsed".
- `codex-rs/sandboxing/src/seatbelt.rs:310-345` (`dynamic_network_policy_for_network`) and `seatbelt_network_policy.sbpl`: the local-binding rules `(allow network-bind (local ip "*:*"))`, `(allow network-inbound (local ip "localhost:*"))`, `(allow network-outbound (remote ip "localhost:*"))`.
- `codex-rs/sandboxing/src/seatbelt.rs` (`protected_metadata_names`, write-side `.git` exclusion) and `seatbelt_base_policy.sbpl`: `.git` is protected against writes only; the base policy reads the whole filesystem.
- `codex-rs/core/src/safety.rs` (`assess_patch_safety`) and `core/src/unified_exec/stdin_approval.rs`: input to a running command stays in the launch sandbox.
- `sandbox_permissions` `use_default | with_additional_permissions | require_escalated` and `sandboxing/src/denial.rs` (`is_likely_sandbox_denied`): after a sandbox denial Codex lets the model ask for the command to be re-run without the sandbox, after approval.

## Decision

The following are Codex behavior now; the stricter Futryn controls they replace are deleted from code and docs.

1. **`.git` is readable, never writable.** The Seatbelt profile allows reading `.git` of the workspace and of every parent directory (a workspace nested in another repository). Writes under the workspace `.git` stay denied.
2. **Loopback inside the default sandbox.** Without a network grant the profile denies network but allows the three Codex local-binding rules above, so a server may bind any local address (Next binds 0.0.0.0) and connect to localhost. External hosts still need the approved `network` permission. _Deviation noted:_ Codex emits these rules only when a managed-network configuration sets `allow_local_binding`; Futryn enables them by default by user decision. Seatbelt's `localhost` matches every address of this host, so connecting to the machine's own LAN address also works; remote hosts do not. Language-server helper sandboxes keep no network at all (`loopback: false`). Linux bubblewrap: not changed (`--unshare-net` leaves `lo` down); Needs verification.
3. **FSEvents.** `com.apple.FSEvents` is added to the Mach services every command may look up. Not in Codex's pinned base policy (it has no entry for it); needed by Turbopack, Vite, watchman and Node's recursive `fs.watch` (verified: Node fails with `EMFILE` without it, works with it).
4. **Tool caches.** Commands get `npm_config_cache`, `npm_config_store_dir`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`, `GOCACHE`, `COREPACK_HOME`, `XDG_*` and the existing `BUN_INSTALL_CACHE_DIR` inside the per-runtime private scratch directory (the profile already makes `scratch/tmp` and `scratch/home` writable, like Codex lets commands write `TMPDIR`). The real home and secrets are never exposed. The scratch directory is now canonicalized with `realpath`: on macOS `$TMPDIR` is under the `/var` symlink and Seatbelt matches real paths, so the writable rule never applied before.
5. **Approval table.** `unverified-command` and `shell-parser-unavailable` (commands the parser cannot split) are kind `execute` instead of `dangerous`; non-empty `write_stdin` input (`stdin`) follows `execute`. Result: `untrusted` asks; `on-request` and `never` run them inside the sandbox. Dangerous-command detection (forced `rm`, `trap`, wrappers) and the dangerous table row are unchanged (`on-request` asks, `never` forbids). Project deny/ask rules still win; an allow rule never matches an unparsed script.
6. **`require_escalated` (Codex `SandboxPermissions::RequireEscalated`).** `exec_command` with `sandbox_permissions: "require_escalated"` (+ `justification`) is a normal, validated request carrying `CommandSandbox.unsandboxed`:
   - `untrusted` and `on-request`: the user is asked. The prompt shows `NO SANDBOX`, says the command runs with the user's full permissions, and shows the model's justification. Kind `escalation`, no allow rule or session grant can answer it (deny and ask rules, and the hard denies, still apply first). Approval covers exactly that command once: a "session" answer is revoked and the prompt scope is unique per call. _(Updated by [ADR 0055](0055-codex-approval-decisions-network-and-full-access.md): `session` remembers that exact command/cwd/sandbox for the session like Codex `UnifiedExecApprovalKey`, and `always` saves a project `Unsandboxed(...)` allow rule.)_
   - `never`: refused without a prompt (`escalation-forbidden`); nothing runs.
   - Approved: the same dispatcher path (validate → path → policy → approval → revalidate → audit → execute → redact) runs that command without the OS sandbox. The audit trail records the decision with reason `unsandboxed-escalation` and the call's target. Runtimes that cannot do it (Docker) refuse (`UNSUPPORTED`).
   - A sandbox that fails to start is still reported as `SANDBOX_FAILED`; it is never replaced by this path, which exists only for an explicitly approved request.
   - When a sandboxed command fails with a likely sandbox denial and escalation is possible (policy is not `never`), the tool result tells the model it may retry with `require_escalated`, or request network with `with_additional_permissions`.
7. Runtime id policy version bumped (`v2` → `v3`), so approvals from before this change do not carry over. `CommandSandbox.unsandboxed` and `CommandRuntimeCapabilities.unsandboxed` are optional additions (contract version unchanged).

## Superseded

- ADR 0040: "`stdin` — documented deviation from Codex" (every non-empty input asks), the `stdin` table row (`ask/ask/deny`), "Hardening over bare Codex" for unparsed scripts (kind `dangerous`) and "unverified fail-closed gate". Replaced by items 5 above.
- ADR 0034: "Futryn has no unsandboxed mode, so it never retries" and `require_escalated ⇒ UNSUPPORTED`; ADR 0034/0035 "no network" and ".git read-only subpath" wording is read as: no _external_ network, `.git` readable. Replaced by items 1, 2 and 6.
- ADR 0035 / AGENTS.md / CLAUDE.md claims of "no unsandboxed mode" for requests: an explicitly approved escalation exists. `danger-full-access` as a session mode is still not implemented _(subsequently implemented in [ADR 0055](0055-codex-approval-decisions-network-and-full-access.md), together with `[sandbox_workspace_write] network_access` and the Read Only / Auto / Full Access presets)_.

## Consequences and limits

- More commands run without a prompt: obfuscated forced removals such as `rm $(echo -rf) dir` are not detected and run inside the workspace-write sandbox, which can delete workspace files (as Codex). The sandbox, not the parse, is the boundary.
- Input to a running shell or REPL is no longer approved per write under `on-request`; it runs inside that session's launch sandbox (and an escalated session was approved when launched).
- Escalated commands run with the runtime's environment (scratch `HOME`/`TMPDIR`, no inherited secrets) but with no filesystem or network restriction.
- Not done / Needs verification: Linux bubblewrap (loopback, parent `.git`, escalation); Windows; the loopback rules are not covered by a Codex test for the default (non-managed) path. Real Seatbelt evidence: `tests/security/codex-sandbox-alignment.test.ts` (macOS 24.6, 2026-11-17).

## Evidence

`tests/security/codex-sandbox-alignment.test.ts` (profile text and real Seatbelt: `.git` own/parent readable and not writable, 0.0.0.0 listen + localhost connect, external refused instantly versus granted, FSEvents watcher, caches in scratch, escalation asks/runs once/never refuses/hint), `tests/security/approval-policy.test.ts` (matrix, escalation chain, deny rules over escalation, stdin, unparsed scripts under real sandbox), `tests/security/native-exec.test.ts`.

## Rủi ro user đã chấp nhận (2026-11-17)

Sau review bảo mật tự động, user chọn ưu tiên "chạy được trước":

- Lệnh trong sandbox kết nối được mọi dịch vụ đang nghe trên localhost (DB local, Docker TCP, Ollama…) mà không cần duyệt mạng.
- Session đã được duyệt chạy ngoài sandbox (`require_escalated`) nhận `write_stdin` không hỏi lại (như Codex); duyệt một shell tương tác là cấp toàn quyền.
- Đọc `.git`: chỉ repo gần nhất bao quanh workspace, không bao giờ `.git` ở thư mục home (832d4ca) — không mất chức năng build/git.
