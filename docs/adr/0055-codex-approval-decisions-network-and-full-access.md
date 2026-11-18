# ADR 0055 — Codex approval decisions, `network_access`, and Full Access presets

Date: 2026-11-18. Status: accepted.

## Context

ADR 0053 aligned the default `workspace-write` + `on-request` behavior with Codex, but four gaps remained relative to `openai/codex` @ `090be4df0724cdef5758e6a0934ba557af8b6bbe` (read-only clone at `/tmp/ref-codex`, inspected 2026-11-17/18):

- Prompts could not distinguish `Approved` (`once`), `ApprovedForSession` (`session`), and persistent project amendments (`always`) uniformly across commands, network requests, and `require_escalated`; `require_escalated` forcibly revoked session answers (`UnifiedExecApprovalKey` in Codex includes `sandbox_permissions` and remembers session approvals per command/cwd/sandbox), and `request_permissions` network grants were not implicitly applied to plain `exec_command` calls (`core/src/tools/handlers/mod.rs:303-363` `implicit_granted_permissions`, `core/src/session/mod.rs:3831-3857`).
- Users could not pre-enable external network inside the `workspace-write` sandbox (`protocol/src/config_types.rs` `SandboxWorkspaceWrite::network_access`).
- `danger-full-access` (`SandboxMode::DangerFullAccess`) and Codex's three approval presets (`utils/approval-presets/src/lib.rs`: `read-only`, `auto` / Default, `full-access`) were missing from the runtime, TUI, `~/.futryn/config.toml`, and `fyn exec` (`utils/cli/src/shared_options.rs`).
- SDK `status()` did not report the active preset, session sandbox mode, or configured sandbox network, and the shared contract needed to record the additive permission schema changes.

## Decision

1. **Codex-parity prompt decisions (`once` / `session` / `always` / `deny`).**
   - `PermissionPromptRequest` carries `decisions` (`['once', 'session']` or `['once', 'session', 'always']`) and `alwaysRule` (`status` adds `approved_always`). `FutrynClient.resolvePermission` enforces `decisions` and persists `alwaysRule` into the workspace's Allow rules before settling `always`. Adding an Allow rule is a relaxation and keeps active session grants intact; restrictive rule edits (`ask`, `deny`, or removing `allow`) still revoke session grants and deny pending prompts.
   - Project command rules gain `Network(...)` and `Unsandboxed(...)` alongside `Bash(...)`. A plain `Bash` allow rule never authorizes network or unsandboxed execution; `Bash` (and, when network or Full Access is active, `Network`/`Unsandboxed`) `deny` and `ask` rules still judge every command first. Dangerous commands (`forced-rm`) are suggested only as exact rules, never prefix wildcards, even when combined with network or escalation.
   - `request_permissions` offers `once` (turn-scoped) and `session` (whole-session, surviving across turns until `/clear`, account switch, or grant revocation), matching Codex `PermissionGrantScope::{Turn, Session}`. While a network grant is active, sandboxed `exec_command` calls receive network automatically (`implicit_granted_permissions`) and `write_stdin` to that terminal does not re-prompt.
   - `require_escalated` (`unsandboxed-escalation`) answered with `session` is remembered in `SessionGrants` for that exact command, canonical directory, runtime, and execution key (like Codex `UnifiedExecApprovalKey`); a plain sandboxed run of the same command text still runs inside the sandbox. Answering `always` saves `Unsandboxed(<prefix>:*)` (or exact for interpreters/dangerous commands) for the project.

2. **Pre-configured sandbox network (`network_access` and `FUTRYN_SANDBOX_NETWORK`).**
   - User-level `~/.futryn/config.toml` (never read from a workspace) supports `[sandbox_workspace_write] network_access = true` (`packages/models/src/host-config.ts` `loadHostPermissions`), overridden by `FUTRYN_SANDBOX_NETWORK=1|true|0|false`.
   - When enabled in `workspace-write` mode, sandboxed commands run with outbound network without prompting and `request_permissions` for network alone returns immediately. Filesystem boundaries remain intact: writes outside the workspace, writes to `.git`, and access to Futryn's state directory stay blocked by the OS sandbox and `ToolDispatcher`.

3. **Full Access (`danger-full-access` + `never`), presets, user defaults, and `fyn exec`.**
   - `CommandSandbox.mode` and `NativeCommandRuntime` support `'danger-full-access'`, running commands with `unsandboxed: true` and open network without prompts. Runtimes that cannot run unsandboxed (Docker) refuse (`SANDBOX_UNAVAILABLE`), never silently downgrading. A failing sandbox in `read-only` or `workspace-write` still fails closed (`SANDBOX_FAILED`).
   - Codex presets (`PERMISSION_PRESETS`: `read-only` = `read-only` + `on-request`, `auto` = `workspace-write` + `on-request`, `full-access` = `danger-full-access` + `never`) are exposed in SDK (`permissionPreset`, `setPermissionPreset`, `cyclePermissionPreset`), `/permissions` (Mode tab, requiring double-Enter confirmation with `FULL_ACCESS_WARNING` for Full Access; `/permissions read-only|auto|full-access`), and `Shift+Tab` (showing `FULL_ACCESS_WARNING` on Full Access). Presets are session-only and reset on `/new`/`/clear` or account switch.
   - `~/.futryn/config.toml` supports top-level `sandbox_mode` and `approval_policy` (Codex names; invalid values fail closed to `read-only` / `untrusted` with diagnostics), overridden by `FUTRYN_SANDBOX_MODE` / `FUTRYN_APPROVAL_POLICY` and CLI flags.
   - `fyn exec` accepts `--sandbox|-s read-only|workspace-write|danger-full-access`, `--approval|-a` / `--ask-for-approval`, `--full-auto`, and `--dangerously-bypass-approvals-and-sandbox`, writing `FULL_ACCESS_WARNING` to `stderr` whenever `danger-full-access` is active.
   - Project `deny` rules win in every mode and preset (including Full Access), and `ToolDispatcher` writes full `requested`/`decided`/`completed` audit records for every call.

4. **SDK status and Contract 1.27.**
   - `FutrynClient.status()` adds `sandboxMode`, `permissionPreset`, and `sandboxNetwork`, rendered in `/status` and `/settings`.
   - `CONTRACT_VERSION` advances from `1.26` to **`1.27`** for the expanded `CommandSandbox.mode`, `PermissionResolutionScope` (`always`), `PermissionPromptRequest` (`decisions`, `alwaysRule`, `approved_always`), `PERMISSION_RULE_TOOLS` (`Network`, `Unsandboxed`), and preset schemas.

## Superseded

- ADR 0053 item 6 ("no allow rule or session grant can answer it... a `session` answer is revoked and the prompt scope is unique per call") and Superseded note ("`danger-full-access` as a session mode is still not implemented"): replaced by items 1 and 3 above.

## Consequences and differences from Codex

- **Rule storage format:** Codex writes persistent command amendments to Starlark `.rules` files (`execpolicy`); Futryn stores project rules in SQLite settings using its existing typed rule grammar (`Bash(...)`, `Network(...)`, `Unsandboxed(...)`, `Edit(...)`, `Read(...)`, `WebFetch(...)`).
- **Dangerous heuristic under `never`:** As in Codex `exec_policy.rs:897-905`, parsed/matched `forced-rm` commands remain forbidden under `approval_policy = never` (including Full Access) unless explicitly allowed by a project Allow rule.
- **Built-in secret-file read gate and workspace path normalization:** Futryn's `read`/`write`/`edit`/`apply_patch` tools still normalize paths inside the workspace root and gate `.env`/key reads through `evaluateRead` (`ask`, or refused under `never` without a `Read(...)` allow rule); Full Access removes the OS command sandbox and command/network prompts.
- **Platform verification:** macOS Seatbelt and real unsandboxed Full Access execution are verified locally (`tests/security/codex-sandbox-alignment.test.ts`, `tests/security/approval-policy.test.ts`, `tests/end-to-end/headless-exec.test.ts`). Linux bubblewrap remains Needs verification.
