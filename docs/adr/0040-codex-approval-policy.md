# ADR 0040 — Codex approval policy, Tree-sitter command analysis, request_permissions

Date: 2026-11-17. Status: accepted (wave 1 plan W1, user decisions D1–D3 of 2026-11-17).

## Context

Futryn asked before every command and every write (`default` mode). Codex, the reference for Futryn's permission model (AGENTS.md), runs ordinary commands inside the sandbox and approves writes inside writable roots without a prompt (`on-request`), and asks only for dangerous commands and sandbox escalations. Reference: openai/codex @ `090be4df0724cdef5758e6a0934ba557af8b6bbe`, read 2026-11-17 — `core/src/exec_policy.rs:868-950` (`render_decision_for_unmatched_command_for_platform`), `shell-command/src/command_safety/is_dangerous_command.rs`, `shell-command/src/bash.rs`, `core/src/safety.rs` (`assess_patch_safety`), `core/src/unified_exec/stdin_approval.rs`, `core/src/tools/handlers/shell_spec.rs:141-176` (`request_permissions`). OpenCode (`sst/opencode` @ `0ac0d7ee`, `packages/core/src/plugin/agent.ts`) keeps `.env` reads on ask.

## Decision

**Approval policy** `untrusted | on-request | never` (`ApprovalPolicy` in contracts). The Claude-style modes stay the UI names and map onto policies: `default`→`untrusted`, `acceptEdits`→`untrusted` + edits approved, `auto`→`on-request`, `bypassPermissions`→`never` (still sandboxed), `plan`→read-only. The default mode is now `auto` (`DEFAULT_PERMISSION_MODE`, plan D3). `FUTRYN_APPROVAL_POLICY` selects the starting mode; the legacy `FUTRYN_SANDBOX_ESCALATION=never` means `never`; an unknown value fails closed to `untrusted`. There is no `danger-full-access` (plan D2).

**One approval table** (`decideApproval` in `@futryn/contracts`, re-exported by `@futryn/security`). `@futryn/security` names the reason (`evaluateExec`/`evaluateWrite`/`evaluateStdin`/`evaluateRead`), `APPROVAL_KIND_FOR_REASON` maps it to a kind, and `FutrynClient.requestPermission` applies project rules first (deny > ask > allow), then the table:

| kind | untrusted | on-request | never |
|---|---|---|---|
| ordinary sandboxed command (`execute`), stdin to an owned session | ask | allow | allow |
| dangerous command | ask | ask | deny |
| unverifiable command (`uncertain`) | ask | ask | allow |
| network / other escalation (writes outside writable roots, `request_permissions`) | ask | ask | deny |
| write inside writable roots (`edit`) | ask (acceptEdits: allow) | allow | allow |
| secret-file read | ask | ask | deny |

Under `never` an `ask` project rule is refused instead of shown (Codex `prompt_is_rejected_by_policy`): `never` never prompts. Hard denies (outside workspace, `.git`, Futryn state, protected paths) are unchanged and come first.

**Tree-sitter.** `web-tree-sitter` + `tree-sitter-bash` WASM (plan D1) parse each command (`packages/tools/src/exec/shell-parse.ts`); the literal words of every command node — including inside pipelines, `&&`, control flow and substitutions — are checked with the ported dangerous list: `rm` with `-f`/`--force` (before `--`), also through `sudo`, `env [-i] [NAME=v] [--]`, `trap` actions and nested `sh/bash/zsh -c|-lc` scripts; more than 8 nested wrappers fail closed. Futryn is stricter than Codex where the command cannot be verified: a parse error, `$(…)`/backticks/process substitution, `eval`, a dynamic program name (`$cmd`) or a non-literal `sh -c` script is `uncertain` and asks under `untrusted`/`on-request` (Codex lets these run silently unless a literal dangerous command is found). A parser that cannot load makes every command `uncertain` (fail closed).

**Prefix rules.** The approval dialog's existing "don't ask again" action saves `Bash(<prefix>:*)` as a project allow rule; allow rules judge each sub-command separately, so `Bash(npm test:*)` never covers `npm test && rm -rf build`.

**request_permissions** `{reason?, permissions: {network?: {enabled}, file_system?: {write?: string[]}}}` — Codex's schema, not the plan's draft shape, so models trained on Codex call it correctly. It always asks; `never` refuses it. "Allow once" grants for the rest of the running turn (bound to the client's turn id), "for session" until the session ends or grants are revoked. A network grant turns later `exec_command` calls that ask for network into ordinary command decisions (dangerous commands still ask); a write grant makes writes under those project-relative paths ordinary edits when the sandbox is read-only. Read access and paths outside the project are refused without a prompt (no access outside the approved workspace exists).

**stdin**: plain input inside the launch sandbox is an ordinary request (`on-request` allows, as Codex `stdin_approval.rs`); retained network and sandbox drift still ask.

## Consequences

- Fewer prompts: the sandbox (Seatbelt/bubblewrap/Docker) is now the main boundary for ordinary commands; every existing sandbox test still runs, and the policy matrix is pinned by tests.
- Fixture suites that exercise the approval dialog start in `untrusted` (`tests/preload.ts` sets `FUTRYN_APPROVAL_POLICY=untrusted` unless already set); the default is tested explicitly.
- Remaining differences from Codex: no exec-policy rule files (`execpolicy/` `.rules`); project rules replace them. Codex `prefix_rule` proposals from the model are still refused (`UNSUPPORTED`); the dialog suggests the prefix. `request_permissions` cannot grant writable roots outside the workspace or extra writable roots to the command sandbox (only to Futryn's file tools). `untrusted` has no known-safe command list (Codex at this revision also prompts for every unmatched command).

## Evidence

`tests/security/approval-policy.test.ts` (classification incl. Codex's test vectors, 3 policies × commands/network/writes/secrets/outside paths through the production chain, never-never-prompts, deny-rule precedence, per-sub-command allow rules, read-only sandbox writes, request_permissions turn/session/revoke/deny/outside paths), `tests/end-to-end/approval-policy.test.ts` (default `on-request`: `bun test` and an edit run without a prompt, `rm -rf` asks; real Seatbelt `rg` on macOS).
