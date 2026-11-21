# ADR 0061 — Claude Code permission modes, settings files and sandbox

> Default values only superseded by [ADR 0081](0081-sandbox-defaults-like-claude-code.md): enabled=false, autoAllowBashIfSandboxed=false, allowUnsandboxedCommands=true. Other decisions below remain in force.

Date: 2026-11-18. Status: accepted (user decision: "switch the permission and sandbox model from Codex to the Claude Code CLI model"). Supersedes [ADR 0053](0053-codex-sandbox-and-approval-alignment.md) and [ADR 0055](0055-codex-approval-decisions-network-and-full-access.md), and the Codex approval policy / `request_permissions` parts of [ADR 0040](0040-codex-approval-policy.md). The command classification (Tree-sitter allowlist parser, dangerous heuristic, banned prefix suggestions) of ADR 0040/0055 stays; the unified-exec terminal of [ADR 0034](0034-unified-exec-terminal-parity.md)/[0035](0035-native-sandbox-default.md) stays with the changed sandbox profile below. Memory write gating of [ADR 0057](0057-user-scoped-project-memories.md) maps to the new modes (see Decision 6).

Contract 1.35 -> **1.36**. SQLite schema unchanged (the settings store gained an optional `trustedProjectSettings` map and a lenient legacy `projectPermissionRules`).

## Context

Futryn followed Codex: `sandbox_mode` (`read-only | workspace-write | danger-full-access`) x `approval_policy` (`untrusted | on-request | never`), three presets (Read Only / Auto / Full Access), `request_permissions`, `sandbox_permissions: require_escalated`, `[sandbox_workspace_write] network_access`, and a home directory that is hidden from commands. The user wants the Claude Code CLI model instead. Evidence and limits: Claude Code documentation as known to the implementer (permissions, settings, sandboxing, `/sandbox`, `claude -p` flags). Nothing here was verified against a running Claude Code; every point that depends on its exact behavior is listed under "Needs verification".

## Decision

1. **Permission modes** (Shift+Tab, `/permissions`, `--permission-mode`, `permissions.defaultMode`): `default`, `acceptEdits`, `plan`, `bypassPermissions`.
   - `default`: reads are free; file edits ask; commands ask unless a rule allows them or they run inside the OS sandbox with `sandbox.autoAllowBashIfSandboxed` (default true); secret-looking reads ask.
   - `acceptEdits`: edits inside the working directory are approved; everything else as `default`.
   - `plan`: edits, commands, network and `dangerouslyDisableSandbox` are refused whatever an allow rule says; reads and web/MCP asks stay.
   - `bypassPermissions` (`--dangerously-skip-permissions`, with a warning): no prompts, including ask rules and secret reads. It can only be entered by starting in it (it joins the Shift+Tab cycle only then). The OS sandbox (when enabled), deny rules and the hard path denials (outside the workspace, `.git`, Futryn state) still apply.
   - Shift+Tab cycles `default -> acceptEdits -> plan`. The mode is session-only and resets with the session; an account switch resets it as before (ADR 0009/0029).
   - Order of decision: deny rule > plan refusal > ask rule > allow rule > mode table (`permissionModeDecision`, contracts). `PermissionKind` is now `read | secret | edit | sandboxed-command | command | escalation | network | other`.
   - Removed: presets (Read Only / Auto / Full Access), `FUTRYN_SANDBOX_MODE`, `FUTRYN_APPROVAL_POLICY`, `FUTRYN_SANDBOX_NETWORK`, `FUTRYN_SANDBOX_ESCALATION`, `sandbox_mode`/`approval_policy`/`[sandbox_workspace_write]` in `config.toml` (still parsed only to print a "no longer supported" diagnostic), `-s/--sandbox`, `-a/--approval/--ask-for-approval`, `--full-auto`, `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `request_permissions`, `sandbox_permissions`, `additional_permissions`, `prefix_rule`, the `Network(...)` and `Unsandboxed(...)` rule tools, `auto` mode, `approvalPolicy`/`sandboxMode`/`permissionPreset`/`sandboxNetwork` in `status()`.

2. **Settings files** (Claude Code layout): `~/.futryn/settings.json` (user; `FUTRYN_HOME` relocates it), `<project>/.futryn/settings.json` (shared) and `<project>/.futryn/settings.local.json` (local). Precedence local > project > user (a launch overlay from `--allowedTools`/`--disallowedTools` is highest). Keys: `permissions.{allow, ask, deny, defaultMode, additionalDirectories}` and `sandbox.{enabled, autoAllowBashIfSandboxed, excludedCommands, allowUnsandboxedCommands, network.allowedDomains}`; unknown keys are kept on write. Lists accumulate across files; scalars take the highest-precedence value. Files must be regular, <= 64 KiB, and (user file) owned by the user.
   - **Rule syntax** as Claude Code: `Bash`, `Bash(npm run test:*)`, `Read(./src/**)`, `Edit(...)` (`Write(...)` is an alias), `WebFetch(domain:example.com)`, `WebSearch`, `mcp__server`, `mcp__server__tool`, `mcp__server__*`, plus Futryn's `Tool(name)` (memory, lsp). Paths: relative to the working directory, `/x` from the project root, `//x` absolute. `Edit` covers every file-changing tool, `Read` every file-reading tool.
   - **Repository files are untrusted (Futryn addition).** `project` and `local` files can always tighten: deny and ask rules, `defaultMode: default|plan`, `sandbox.enabled: true`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false` apply at once. Anything that loosens (allow rules, `defaultMode: acceptEdits|bypassPermissions`, `additionalDirectories`, `sandbox.enabled: false`, `excludedCommands`, `network.allowedDomains`, `allowUnsandboxedCommands: true`, `autoAllowBashIfSandboxed: true`) is ignored until the user approves the exact content: a trust prompt in the TUI lists what the file grants and offers "this session" or "always" (stored by SHA-256 of the content in the settings store, up to 50 hashes per path, so any edit asks again and reverting restores the approval). Without a TTY (`fyn exec`) nothing is asked: the loosening parts are ignored and a `Notice` names them. `/permissions` can approve a pending file explicitly. The sandbox denies commands access to `<root>/.futryn` and tools cannot write it, so neither can plant or alter these files; Futryn itself writes only on a user action and trusts the result only when the file held nothing unapproved before.
   - **Migration:** rules saved per workspace by the previous model (`projectPermissionRules`) move to that project's `settings.local.json` on first start and are trusted; the store entry is removed. `Network(...)`/`Unsandboxed(...)` deny/ask rules become `Bash(...)` rules; allow forms have no equivalent and are dropped with a diagnostic. If the file cannot be written the old rules keep applying and nothing is lost. The stored shape stays lenient so old databases still load.
   - `/permissions` manages allow/ask/deny per scope (add asks which file) and shows modes, pending trust and the sandbox summary. The `always` answer saves a rule to the local file (an allowed domain to `sandbox.network.allowedDomains` of the local file). Adding deny/ask or removing allow revokes session grants and denies pending prompts; adding allow keeps them (unchanged from ADR 0055).

3. **Sandbox** (like `/sandbox`; macOS Seatbelt verified, Linux bubblewrap kept but unverified), enabled by default.
   - Filesystem: writes only in the working directory and `additionalDirectories` plus the command's private `TMPDIR`/`HOME` (no `/tmp`); `.git` is never writable in any root; `.futryn`/`.hannes` inside a root and Futryn's state directory are neither readable nor writable. Reads are allowed everywhere except `Read(...)` deny rules (and `Edit(...)` deny rules for writes, via `denyRead`/`denyWrite` globs), a default sensitive list (`SENSITIVE_HOME_PATHS`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`, gcloud/gh/1password config, `~/.docker/config.json`, `~/.git-credentials`, other agents' state, Keychains, Cookies, Safari, Mail, Messages, browser profiles, `~/.futryn`), and secret-named files (the existing secret rules: `.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc`, ...) anywhere under home except the project. Deviation: secret-named files **inside the project** stay readable by commands unless `FUTRYN_SANDBOX_HIDE_SECRETS=1`, because bun/node/vite read their own `.env` (ADR 0035). This replaces the "home hidden" profile.
   - Network: sandboxed commands have no direct network. Seatbelt allows only loopback; `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` (and lowercase, `NO_PROXY=localhost,127.0.0.1,::1`, `NODE_USE_ENV_PROXY=1`) point at a loopback HTTP/CONNECT proxy that Futryn starts per client (`packages/tools/src/exec/proxy.ts`, Node built-ins only). HTTPS is a CONNECT tunnel without TLS interception, so the decision is per host. A host is allowed by `sandbox.network.allowedDomains` (`example.com` or `*.example.com`), a `WebFetch(domain:...)` allow rule or a session answer; denied by `WebFetch(domain:...)` deny rules or `plan`; otherwise the user is asked (once / this session / always -> `allowedDomains` of the local file; `bypassPermissions` allows without asking; a run without a TTY denies). A once or deny answer is remembered 30 s so one command's connections do not prompt repeatedly; concurrent asks for one host share one prompt. The proxy resolves DNS itself, refuses any hostname that resolves to a private, loopback, link-local or CGNAT address (no rebinding into the LAN or a metadata service) and connects to the pinned address. `localhost` stays direct. Every decision is audited (`sandbox_network`). On Linux bubblewrap runs with `--unshare-net`: commands have no network at all (no socket bridge yet).
   - `autoAllowBashIfSandboxed` (default true): a command that runs inside the sandbox skips the Bash prompt in `default`/`acceptEdits`; deny and ask rules still apply, and the heuristic "dangerous" flag no longer changes the decision (the sandbox is the boundary). Off: every command asks, an allow rule answers.
   - `excludedCommands`: a command whose parsed sub-commands are **all** excluded (`git`, `docker:*`, `npm run *`) runs outside the sandbox with the real environment through the normal permission flow (allow rule or ask; never auto-allowed). Anything unparsed or mixed stays sandboxed. A read-only subagent profile drops excluded commands.
   - Escape hatch: `exec_command` takes `dangerouslyDisableSandbox: true` plus a `justification` (replaces `require_escalated`). It always asks (prompt shows `NO SANDBOX`; allow rules never answer it, deny and ask rules do; only `once`/`session`, never `always`), is refused without a prompt when `allowUnsandboxedCommands` is false or the runtime does not list `unsandboxed`, runs in `bypassPermissions` without a prompt and is refused in `plan`. Such a command (and `sandbox.enabled: false`) runs with the real environment (the F12 behavior of ADR 0055, unchanged). The Docker command backend was removed in ADR 0062.
   - A sandbox that fails to start is `SANDBOX_FAILED`/`SANDBOX_UNAVAILABLE`; there is no silent fallback to no sandbox. Terminal input (`write_stdin`) keeps the launch sandbox of its session and is judged like a command of that kind; a terminal launched unsandboxed is refused input once the sandbox is on again.
   - Native self-test now proves: workspace write works, secret/`.git`/outside-write/credential-directory reads fail while other home reads work, signalling outside processes and LaunchServices fail.

4. **Invariants kept:** one `ToolDispatcher` path for every tool, subagent and MCP call (validate -> normalize -> policy -> persist intent -> revalidate -> execute -> record -> redact); audit; redaction. Subagents (ADR 0058) inherit the session mode, rules and settings because their requests go through the same client; they inherit only `fs.read` session grants; a read-only profile narrows to a read-only OS sandbox (enabled, no extra directories, no excluded commands, no escape hatch).

5. **`fyn exec`** (like `claude -p`): `--permission-mode`, `--dangerously-skip-permissions` (stderr warning), `--allowedTools`, `--disallowedTools` (comma/space separated rules). Without a TTY whatever would ask is denied immediately and no `permission.requested` event is emitted; with a TTY the existing `[y/N]` prompt remains. The flags apply to the launched session only; interactive entry points accept the same flags.

6. **Memory write gating (ADR 0057):** `plan` (and Plan/Review agent mode, and a read-only subagent) refuses write/delete with `MODE_RESTRICTED`; otherwise `agent.state.write` is an `edit`: `default` asks, `acceptEdits` and `bypassPermissions` write, deny rules win. list/read are unchanged.

## Consequences and limits

- `additionalDirectories` extend the command sandbox (and are listed in settings/status). [ADR 0067](0067-working-directories.md) makes the same trusted list a working directory for `read`, `edit`, `write`, `apply_patch`, Grep, Glob and LSP. A path in neither the project nor a granted directory stays refused. The trust gate and the hard denies in this ADR are unchanged.
- Seatbelt cannot prove `setsid` descendants die (unchanged). Programs that ignore the proxy variables (raw sockets, `ssh`, many git-over-ssh flows) have no network, as in Claude Code. Linux has no network at all.
- A hostname is judged, not an IP literal behind it; CONNECT tunnels are not inspected.
- Reads of non-project secrets are blocked by name only under the home directory; secret names outside home (for example `/srv/app/.env`) stay readable.
- The "dangerous command" heuristic remains a display hint; `bypassPermissions` no longer treats it specially (previously `never` refused forced `rm`).
- Contract 1.36: `PermissionMode` loses `auto`; new `PermissionKind`s; `CommandSandbox` gains `proxyUrl`, `writableRoots`, `denyRead`, `denyWrite` (`network` now means "unsandboxed, unrestricted"); `exec_command` input changes as above; permission capability `settings.trust`; `PermissionSettingsPort` and snapshot types; `status()` gains `sandbox` and `bypassAvailable` and loses the Codex fields; the SDK gains `cyclePermissionMode`, `permissionSettings`, `authorizeNetwork`, `approvePendingSettings`, `setSettingsTrustPrompts`, `setPromptsAvailable`; removed: `setPermissionPreset`, `cyclePermissionPreset`, `setSandboxMode`, `sandboxConfig`.

## Needs verification

- Exact Claude Code behavior where this ADR guessed: whether `bypassPermissions` also silences `ask` rules and sandbox domain prompts; the precise `excludedCommands` matching grammar and whether Claude Code requires every sub-command to match; the `Read`/`Edit` path anchoring (`/x`, `//x`, `~/x`) beyond what is documented; the default sensitive list contents; whether the `dangerouslyDisableSandbox` parameter keeps asking in `bypassPermissions`.
- Live macOS verification covers: Seatbelt reads/writes/credential directories/deny globs/additional directories, proxy allow/deny/private-address/direct-egress (`tests/security/claude-sandbox.test.ts`, `sandbox-proxy.test.ts`). Not verified: Linux bubblewrap (any of it), real HTTPS through the proxy to the public internet, `git`/`npm`/`pip` through the proxy, Windows.
- `NODE_USE_ENV_PROXY=1` support depends on the Node version of the user's toolchain.
- Live authenticated generation is still not verified (unchanged).

## Live upstream documentation check

### 2026-11-22: outside-working-directory boundary is not OS sandboxing

Official documentation retrieved through Context7 on 2026-11-22:

- <https://code.claude.com/docs/en/security> states that in Manual mode file
  tools ask before reading/writing outside the starting folder, and that the
  boundary is a permission prompt: an approved Bash command can write anywhere
  the user's OS account can. OS-level path limits require sandboxing.
- <https://code.claude.com/docs/en/permissions#working-directories> documents
  optional `permissions.blockReadsOutsideWorkingDirectories` and
  `permissions.blockWritesOutsideWorkingDirectories` for hard file-tool refusal,
  including bypassPermissions. The write block requires v2.1.314 or later and
  does not constrain Bash/MCP/hooks; the OS sandbox is a separate layer.
- <https://code.claude.com/docs/en/settings-reference> documents those explicit
  block settings and `sandbox.filesystem.allowWrite` for extra sandbox write paths.

The installed executable reports **Claude Code 2.1.330** (`claude --version`).
This check read documentation/version metadata only; actual Claude tool approval
and outside-write behavior on this host remains **Needs verification**.

**Documented parity deviation:** Cosmew's unconditional file-tool refusal outside
the project plus trusted additional directories (ADR 0067 and current project
instructions) is stricter than Claude's documented default permission boundary.
Do not present that hard refusal as a consequence of disabling sandboxing or as
Claude's universal behavior. Conversely, disabling the OS sandbox does not by
itself approve a command or cancel deny rules. Approved unsandboxed Bash and
the built-in file tools must be distinguished. No filesystem policy, settings
trust or permission grant was changed by this documentation check.

Checked 2026-11-21 against the current Claude Code documentation:

- Settings and precedence: <https://code.claude.com/docs/en/settings> (accessed 2026-11-21). The current CLI documents managed settings, a per-session `--settings` overlay, hot reload of settings files, and `/status` source attribution.
- Permissions: <https://code.claude.com/docs/en/permissions> (accessed 2026-11-21). The current CLI documents `auto` and `dontAsk` modes in addition to the modes implemented here, plus `disableAutoMode`, `disableBypassPermissionsMode`, and `denyInsteadOfPrompting`.
- Keybindings: <https://code.claude.com/docs/en/keybindings> (accessed 2026-11-21). The current schema includes additional contexts/actions and keeps typo text literal when a completion is highlighted but not explicitly selected.
- Terminal configuration: <https://code.claude.com/docs/en/terminal-config> (accessed 2026-11-21). `/terminal-setup`, Vim editor mode, and terminal integration settings are documented there.

Futryn's current implementation intentionally keeps the `.futryn` storage namespace and the four-mode permission contract from this ADR. `auto`, `dontAsk`, managed settings, `--settings`, Vim mode, and `/terminal-setup` remain separate parity work; they are not silently inferred from the documentation check.

## Update 2026-11-22: outside-working-directory approval

ADR 0092 supersedes the hard outside-root refusal of ADR 0067. External file access now asks instead of requiring additionalDirectories. Default/acceptEdits ask; explicit allow rules, exact grants and bypass may permit. Bash outside cwd uses ordinary command approval; OS sandbox write roots remain unchanged. Evidence: https://code.claude.com/docs/en/security and https://code.claude.com/docs/en/permissions#working-directories, retrieved 2026-11-22 through Context7 (`/websites/code_claude`); local CLI version 2.1.330. Docs distinguish manual file-tool approval from optional blockReadsOutsideWorkingDirectories/blockWritesOutsideWorkingDirectories hard refusal. Exact Claude runtime prompt/grant behavior: **Needs verification**; no Claude agent invocation was made.
