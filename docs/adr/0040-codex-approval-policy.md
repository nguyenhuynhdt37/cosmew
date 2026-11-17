# ADR 0040 — Codex approval policy, Tree-sitter command analysis, request_permissions

Date: 2026-11-17. Status: accepted (wave 1 plan W1, user decisions D1–D3 of 2026-11-17). **Partly superseded by [ADR 0053](0053-codex-sandbox-and-approval-alignment.md)** (2026-11-17): the stdin deviation and the `unverified-command`/`shell-parser-unavailable` fail-closed kind below no longer apply; sandbox and approvals follow Codex exactly.

## Context

Futryn asked before every command and every write (`default` mode). Codex, the reference for Futryn's permission model (AGENTS.md), runs ordinary commands inside the sandbox and approves writes inside writable roots without a prompt (`on-request`), and asks only for dangerous commands and sandbox escalations. Reference: openai/codex @ `090be4df0724cdef5758e6a0934ba557af8b6bbe`, read 2026-11-17 — `core/src/exec_policy.rs:868-950` (`render_decision_for_unmatched_command_for_platform`), `shell-command/src/command_safety/is_dangerous_command.rs`, `shell-command/src/bash.rs`, `core/src/safety.rs` (`assess_patch_safety`), `core/src/unified_exec/stdin_approval.rs`, `core/src/tools/handlers/shell_spec.rs:141-176` (`request_permissions`). OpenCode (`sst/opencode` @ `0ac0d7ee`, `packages/core/src/plugin/agent.ts`) keeps `.env` reads on ask.

## Decision

**Approval policy** `untrusted | on-request | never` (`ApprovalPolicy` in contracts). The Claude-style modes stay the UI names and map onto policies: `default`→`untrusted`, `acceptEdits`→`untrusted` + edits approved, `auto`→`on-request`, `bypassPermissions`→`never` (still sandboxed), `plan`→read-only. The default mode is now `auto` (`DEFAULT_PERMISSION_MODE`, plan D3). `FUTRYN_APPROVAL_POLICY` selects the starting mode; the legacy `FUTRYN_SANDBOX_ESCALATION=never` means `never`; an unknown value fails closed to `untrusted`. There is no `danger-full-access` (plan D2).

**One approval table** (`decideApproval` in `@futryn/contracts`, re-exported by `@futryn/security`). `@futryn/security` names the reason (`evaluateExec`/`evaluateWrite`/`evaluateStdin`/`evaluateRead`), `APPROVAL_KIND_FOR_REASON` maps it to a kind, and `FutrynClient.requestPermission` applies project rules first (deny > ask > allow), then the table:

| kind | untrusted | on-request | never |
|---|---|---|---|
| ordinary sandboxed command (`execute`) | ask | allow | allow |
| non-empty stdin to an owned session (`stdin`) *(ADR 0053: follows `execute`)* | ask | allow | allow |
| dangerous command | ask | ask | deny |
| network / other escalation (writes outside writable roots, `request_permissions`) | ask | ask | deny |
| write inside writable roots (`edit`) | ask (acceptEdits: allow) | allow | allow |
| secret-file read | ask | ask | deny |

Under `never` an `ask` project rule is refused instead of shown (Codex `prompt_is_rejected_by_policy`): `never` never prompts. Hard denies (outside workspace, `.git`, Futryn state, protected paths) are unchanged and come first.

**Shell parsing — a port of Codex, not a Futryn denylist.** `web-tree-sitter` + `tree-sitter-bash` WASM (plan D1) back two parsers ported from Codex `shell-command/src/bash.rs` (`packages/tools/src/exec/shell-parse.ts`):

- `try_parse_word_only_commands_sequence` is an **allowlist**: only `program, list, pipeline, command, command_name, word, string, string_content, raw_string, number, concatenation` nodes, the tokens `&& || ; | " '`, and literal words. Anything else — subshells, compound statements, redirects, heredocs, herestrings, expansions, substitutions, assignments, functions, control flow — leaves the whole script **unparsed**.
- `exec_command` runs `<shell> -c <cmd>`. As in Codex `commands_for_exec_policy`, a parsed script is judged per sub-command; a single `bash|zsh|sh -c|-lc <script>` sub-command (exactly that form) is unwrapped only when its script parses too; anything else is one opaque command `[<shell>, -c, <cmd>]`.
- Project rules: deny/ask rules apply if **any** sub-command (or, for an unparsed script, the full text or any of its text segments) matches; an allow rule applies only if **every** parsed sub-command matches, and **never** to an unparsed script — so `untrusted` always asks for unparsed scripts.
- ~~Hardening over bare Codex~~ **superseded by ADR 0053**: a script that fails to parse as a plain word-only sequence, carries malformed syntax, invokes shells with uninspected flags/extra operands (`bash -ec`, `sh -c ... extra`, `--rcfile`), uses `eval`/`source`/`.`/`xargs`, or uses unknown wrapper options is still named `unverified-command`, but it is kind `execute` like Codex: `untrusted` asks, `on-request`/`never` run it inside the sandbox. Allow rules still never match it; deny/ask rules judge its text.
- The dangerous heuristic is Codex `is_dangerous_command.rs` plus allowlisted wrapper grammars (`sudo`, `env`, `nohup`, `exec`, `command`, `nice`, `timeout`): `rm` with `-f`/`--force` before `--`, a `trap` action, and the literal commands (`parse_shell_lc_literal_commands`) of an exact `bash|zsh|sh -c|-lc <script>`; more than 8 wrappers → `other`. A parser that cannot load is named `shell-parser-unavailable` (kind `execute` since ADR 0053).

**The dangerous-command check is a heuristic; the OS sandbox remains the hard boundary** (workspace-write, `.git` not writable, Futryn state denied, home hidden, no external network unless approved). Dynamic/unparsed constructs such as `rm $(echo -rf) /`, `bash <<<'rm -rf x'`, `echo $(date) > out` run inside the sandbox under `on-request`/`never` (ADR 0053, as Codex).

**Prefix rules.** The approval dialog's existing "don't ask again" action saves `Bash(<prefix>:*)` as a project allow rule; allow rules judge each sub-command separately, so `Bash(npm test:*)` never covers `npm test && rm -rf build`.

**request_permissions** `{reason?, permissions: {network?: {enabled}, file_system?: {write?: string[]}}}` — Codex's schema, not the plan's draft shape, so models trained on Codex call it correctly. It always asks; `never` refuses it. "Allow once" grants for the rest of the running turn (bound to the client's turn id), "for session" until the session ends or grants are revoked. A network grant turns later `exec_command` calls that ask for network into ordinary command decisions (dangerous commands still ask); a write grant makes writes under those project-relative paths ordinary edits when the sandbox is read-only. Read access and paths outside the project are refused without a prompt (no access outside the approved workspace exists).

**stdin — ~~documented deviation from Codex~~ superseded by ADR 0053 (now identical to Codex: input stays in the launch sandbox; `untrusted` asks, `on-request`/`never` allow).** The text below is history. Codex (`stdin_approval.rs`) lets plain input inside the launch sandbox through and reviews only retained grants and policy drift. Futryn keeps ADR 0034's stricter rule, independent of the program: an empty poll and an interrupt are transport (allowed); any non-empty input asks under `untrusted` and `on-request` and is refused under `never` (reason `stdin-input-approval-required`); a "session" answer covers later input to that one session only. A first attempt to classify typed input as a shell command line was withdrawn after a second security review: it cannot be made sound (input split across writes, terminal line editing and control characters, `!` history expansion, pagers/editors that spawn shells, pipelines hiding the receiving program). Retained network and sandbox drift still ask as before.

**Review history (2026-11-17).** Two rounds of security review found bypasses in an intermediate Futryn design that tried to extend Codex's heuristic into a denylist walker (non-literal words dropped, `-ec` forms, heredoc/pipe-fed shells, wrapper options, redirects on enclosing statements). That walker was withdrawn in favour of the exact Codex design above; each review example is a regression test (`tests/security/approval-policy.test.ts`, "security review regressions").

## Consequences

- Fewer prompts: the sandbox (Seatbelt/bubblewrap/Docker) is now the main boundary for ordinary commands; every existing sandbox test still runs, and the policy matrix is pinned by tests.
- Fixture suites that exercise the approval dialog start in `untrusted` (`tests/preload.ts` sets `FUTRYN_APPROVAL_POLICY=untrusted` unless already set); the default is tested explicitly.
- Deviation from Codex (`shell-command/src/shell_detect.rs:39` detects the shell by file stem): a `-c|-lc` script is unwrapped for project rules only when the shell word is exactly `bash`/`zsh`/`sh`, or an absolute path whose real path is a `bash`/`zsh`/`sh`/`dash` in `/bin`, `/usr/bin`, `/usr/local/bin` or `/opt/homebrew/bin` and not inside the workspace. A repository-planted `./bash -lc "npm test"` stays one sub-command as written, so `Bash(npm test:*)` never allows it (test: "a -c script is unwrapped only for a bare or system shell").
- Remaining differences from Codex: no exec-policy rule files (`execpolicy/` `.rules`); project rules replace them. Codex `prefix_rule` proposals from the model are still refused (`UNSUPPORTED`); the dialog suggests the prefix. `request_permissions` cannot grant writable roots outside the workspace or extra writable roots to the command sandbox (only to Futryn's file tools). `untrusted` has no known-safe command list (Codex at this revision also prompts for every unmatched command).

## Evidence

`tests/security/approval-policy.test.ts` (classification incl. Codex's test vectors, 3 policies × commands/network/writes/secrets/outside paths through the production chain, never-never-prompts, deny-rule precedence, per-sub-command allow rules, read-only sandbox writes, request_permissions turn/session/revoke/deny/outside paths), `tests/end-to-end/approval-policy.test.ts` (default `on-request`: `bun test` and an edit run without a prompt, `rm -rf` asks; real Seatbelt `rg` on macOS).
