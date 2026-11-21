# Futryn/Hannes repository audit — implementation vs declared backlog

Date: 2026-11-21
Scope: local repository only (`/Users/huynh/codes/hannes`). No source code was changed for this audit. The notes distinguish current implementation from historical plans; older delivery pages contain pre-P3 statements and should not override the current source/CLAUDE.md.

## 1. What is implemented strongly

### Agent loop, tools, persistence and security

- The project has a first-party agent loop and provider adapters. It does not launch an external Codex/Claude/OpenCode agent process. The declared implementation list is in `CLAUDE.md:5`.
- Workspace tools are present: `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `exec_command`, `write_stdin`; extended read covers media/notebooks and nested instructions (`CLAUDE.md:5,68`). Source handler inventory is under `packages/tools/src/handlers/` and `packages/tools/src/builtin/`.
- Tool calls have a single dispatcher/policy path, with validation, path normalization, policy, revalidation, audit and redaction (`CLAUDE.md:59`; `packages/tools/src/dispatcher.ts`; `packages/tools/src/orchestrator.ts`). Security tests cover command/file/network/secret policy under `tests/security/`.
- Claude-style permission modes/settings/sandbox are implemented in the source and ADR 0061: `default`, `acceptEdits`, `plan`, `bypassPermissions`; settings precedence; untrusted project settings; macOS Seatbelt; proxy-based network checks; no fallback when sandbox startup fails (`docs/adr/0061-claude-code-permissions-and-sandbox.md`, `tests/security/permission-modes.test.ts`, `permission-settings.test.ts`, `claude-sandbox.test.ts`, `sandbox-proxy.test.ts`).
- Durable sessions/checkpoints/recovery/compaction and P3 rewind/diff are implemented with contract/persistence tests: `tests/contracts/runtime-recovery.test.ts`, `model-compaction.test.ts`, `checkpoints.test.ts`, `workspace-diff-bases.test.ts`, `workspace-diff-regressions.test.ts`, `input-retraction.test.ts`, `plan-approval.test.ts`; current P3 status is recorded in `docs/delivery/tui-v4/p2-status.md:90-104`.
- Plans/questions, memory CRUD, user-scoped memories and citations are implemented (`packages/tools/src/handlers/plan.ts`, `question.ts`, `memory.ts`; `tests/contracts/memories.test.ts`, `memory-citations.test.ts`, `sdk-memory-write.test.ts`).
- Subagents support sync/background, custom agent files, `agent_message/agent_wait/agent_close`, budget reservations and `isolation: "worktree"` (`CLAUDE.md:5`; `packages/agents/src/`; `tests/contracts/subagents*.test.ts`, `tests/end-to-end/subagents*.test.ts`, `tests/security/subagent-worktree.test.ts`).
- Web search/fetch exists with bounded/redacted untrusted output and SSRF/network policy (`CLAUDE.md:71-72`; `packages/tools/src/handlers/web-*.ts`; `tests/end-to-end/web-search.test.ts`, `tests/security/web-fetch.test.ts`).

### TUI and keyboard layer

- Ink fullscreen TUI, transcript, streaming display, dialogs, permissions/questions, slash commands, model/account/usage/context/status panels and background task panel are implemented (`CLAUDE.md:49`; `apps/tui/src/ink/`; `tests/end-to-end/tui-ink-pty.test.ts`; `docs/delivery/tui-v4/g3-status.md`).
- The central keymap supports 17 contexts, chords, reserved keys, user `~/.futryn/keybindings.json`, hot reload and generated help (`CLAUDE.md:49`; `docs/delivery/tui-v4/keys-status.md:1-35,106-107`; `apps/tui/src/ink/hooks/keymap/`). This addresses the requested Claude-style keyboard config path.
- P3 features declared done: Current/Uncommitted/Branch diff, selective queued-text retraction, atomic plan approval with editable artifact, summarize rewind, session-only model/effort, timestamped prompt-history scopes (`CLAUDE.md:49`; `docs/delivery/tui-v4/p2-status.md:90-100`).

### Provider/auth baseline

- API adapters and account/auth flows are implemented for OpenAI Responses, Anthropic, Gemini, OpenAI-compatible/DeepSeek/OpenRouter/xAI/Ollama and ChatGPT OAuth paths (source: `packages/models/src/`, `apps/cli/src/subscriptions/`, provider contract tests such as `tests/contracts/provider-adapters.test.ts`, `provider-foundations.test.ts`, `tests/end-to-end/chatgpt-oauth.test.ts`).
- The architecture explicitly disallows an external agent runtime; `CLAUDE.md:5` says provider/auth is API adapters only and no external runtime. Subscription docs are partially historical and must not be read as working native runtime support (`docs/delivery/subscription-auth.md:1,76-95`).

### User MCP slice

- User-only MCP is implemented for stdio and Streamable HTTP from `<state>/mcp.json`, with listing and calls routed through ToolDispatcher. Project MCP files are not started (`docs/adr/0068-user-mcp-connect.md:11-14`; `packages/mcp/src/`; `tests/mcp/user-servers.test.ts`).
- The SDK correctly reports this as partial (`packages/sdk/src/client.ts:145,831-832`), not as a complete MCP host.

## 2. Partial, fragile or explicitly Needs verification

### Provider login, live generation and usage/token accounting

- Deterministic adapter/OAuth fixtures and local PTY tests do not prove user-account login, model discovery, tool calls or authenticated generation for every provider. `CLAUDE.md:5` forbids claiming Product MVP/live authenticated generation; `docs/delivery/subscription-auth.md:49,76-79,179,185` marks Gemini/Qwen/Copilot/other live paths as Needs verification.
- Subscription runtimes are not part of the current agent backend. The old Copilot/Gemini/Qwen/Grok/Codex-runtime sections in `docs/delivery/subscription-auth.md` are historical; current code policy is API calls + Futryn loop. Native-runtime compatibility must not be reported as complete.
- Usage/price/context projections exist (`tests/contracts/turn-usage.test.ts`, `usage-context.test.ts`, `apps/tui/src/ink/features/usage/`), but exact provider tokenization, authoritative billing, cache/reasoning subsets, quota refresh and provider-specific context remain unavailable when a runtime omits usage. `docs/delivery/commands-usage-context-acceptance.md` and `docs/delivery/tui-v4/p2-status.md:98,102-104` record this limit. Unknown values are intended to remain unknown; no exact universal token calculator exists.

### MCP

- Implemented: user `mcp.json`, stdio/HTTP connect, list/status, ToolDispatcher permission and redaction.
- Missing from this slice: OAuth, project MCP launch/config, registry install, `tool_search`, `mcp_resource`, sampling, roots, annotation modes/automatic allow, broad MCP server management and plugin hosting (`CLAUDE.md:5`; `docs/adr/0068-user-mcp-connect.md:18`; TUI panel `apps/tui/src/ink/features/panels/index.tsx:68-69`). Linux and third-party server behavior remains Needs verification.

### TUI parity limits

- Fast mode and thinking toggle are intentionally not implemented because there is no provider contract (`docs/delivery/tui-v4/keys-status.md:45-46,149`; `apps/tui/src/ink/features/composer/use-composer.ts:786-790`). `/effort`/reasoning-effort is the supported alternative.
- Native clipboard read is only bounded/parser-tested; macOS OS clipboard and other hosts are Needs verification (`docs/delivery/tui-v4/keys-status.md:52,136`; `apps/tui/src/clipboard.ts`).
- Ink has no mouse event layer for wheel scrolling, mouse selection or Ctrl/Cmd terminal copy; these remain gaps (`docs/delivery/tui-v4/keys-status.md:97,150`; `docs/adr/0066-claude-code-fullscreen-layout.md:14`).
- Vim/editor mode is visibly unavailable; settings reports this at `apps/tui/src/ink/features/settings/logic.ts:110-114`. Desktop notifications and interface language are also unavailable (`logic.ts:104-105`); automatic resume preference is unavailable (`logic.ts:224-226`).
- `/hooks` is an inspection-only unsupported panel, and `/plugin` is an explicit unsupported command (`packages/sdk/src/commands.ts:153-174`; `apps/tui/src/ink/features/panels/index.tsx:77-88`).
- Command metadata and host routing still have a compatibility rough edge: `/mcp`, `/rewind`, and `/hooks` are host panels while `/mcp`/`/rewind` are marked `handler: unavailable` in `packages/sdk/src/commands.ts:143-165`; line CLI handles `/compact` as “Not implemented” (`apps/cli/src/index.ts:691`) although the SDK/TUI has a compact backend (`packages/sdk/src/client.ts:302,2181-2187`, `apps/cli/src/bootstrap/startup.ts:1744`). This means line-mode vs TUI feature parity is partial and should be tested separately.
- `/help`/keymap does not include unsupported `/btw` and some Claude-only shortcuts (`docs/delivery/tui-v4/g3-status.md`, `docs/delivery/tui-v4/keys-status.md:45-46`). Dropped UI surfaces include companion/mascot, sidebar, wallpaper overlay, theme editor, command palette and mouse text selection (`CLAUDE.md:49`).

### Sandbox/code intelligence/platform

- macOS Seatbelt has local native checks, but Linux bubblewrap is untested/no network bridge and Windows command sandbox is refused; this is explicit in `CLAUDE.md:9`, `docs/adr/0061-claude-code-permissions-and-sandbox.md` and `packages/tools/src/exec/native.ts:1026`.
- LSP/rename is implemented but Python/Go/Rust and non-macOS support are Needs verification; servers are optional project/PATH binaries and no automatic installation is provided (`CLAUDE.md:70`; `tests/end-to-end/lsp.test.ts`).
- Web fetch intentionally refuses binary/compressed/unsupported encodings and has bounded redirects/size; it is not a browser renderer (`CLAUDE.md:72`; `packages/tools/src/runtimes/web-fetch.ts:311`).
- Worktree subagents cannot commit because the shared `.git` is read-only to the child; Linux bubblewrap/Windows worktree isolation is unverified (`docs/delivery/wave-2/deferred.md:53`, `docs/adr/0058-synchronous-subagents.md`).

### Memories and background execution

- Memory CRUD/citations/usage tracking are implemented, but automatic extraction and a consolidation agent are deliberately deferred/off. Even `auto_extract=true` yields a diagnostic and no runner (`CLAUDE.md:78`; `docs/delivery/wave-2/deferred.md:23-45`; `apps/cli/src/bootstrap/host-config.ts:132`).
- Background tasks are session-scoped and have durable notifications/output, but they do not survive process restart automatically; headless `fyn exec` exits after handling queued notifications unless it explicitly waits (`docs/adr/0058-synchronous-subagents.md`, `docs/delivery/tui-v4/p2-status.md`).

## 3. Clearly missing functionality

### Agent orchestration

- Remote/cloud agents and cloud execution.
- Agent teams/teammates: shared task list, peer mailbox, lead coordination and direct child-to-child messaging. Current tree is parent-child; child messaging goes only through parent (`docs/delivery/wave-2/deferred.md:50-52`).
- Codex-style TOML agent roles, recursive agent discovery, agent hooks/permissionMode frontmatter, UI create/edit agent, automatic background-agent resume after process restart (`docs/delivery/wave-2/deferred.md:51-53`; `docs/adr/0058-synchronous-subagents.md`).
- Rich multi-agent TUI beyond `/agents` list/inspect/stop; `/agents` is a compact viewer, not a teams dashboard.

### Extensions/plugins/hooks and OpenCode compatibility

- No plugin/extension host, trusted package install/discovery, lifecycle/reload/dispose ledger, hook execution, hook transforms/veto, or extension service bridge (`packages/sdk/src/client.ts:145`; `packages/sdk/src/commands.ts:153-174`; `docs/contracts/plugins-and-hooks.md:1`; `apps/tui/src/ink/features/panels/index.tsx:77-88`).
- OpenCode V1 function/object plugins, V2 server/TUI/GUI/RPC/SDK compatibility and Effect/Promise interop are all marked **Not implemented** (`docs/compatibility/opencode-v1-v2.md:3-35`, `docs/compatibility/opencode-tui-gui-rpc.md:3-24`). The compatibility matrix is a design target, not evidence of implementation (`docs/compatibility/compatibility-matrix.md:5-24`).
- DeepSeek/Cordis composition, effect/service DI, sidecar delegation, profiles/bundles and arbitrary plugin config are also design-only (`docs/compatibility/compatibility-matrix.md`).

### UI/product surfaces

- GUI/desktop/web/server products are absent; `apps/{server,web,desktop}` placeholders were removed. There is no OpenCode GUI renderer/window host/RPC bridge (`CLAUDE.md:5`; `docs/compatibility/opencode-tui-gui-rpc.md:16-22`).
- Plugin-provided TUI routes/slots/dialogs/keybindings and remote TUI context are absent.
- Claude-style Vim mode, mouse selection/wheel, desktop notifications and language selection remain absent; automatic resume preference remains absent (`apps/tui/src/ink/features/settings/logic.ts:104-114,224-226`; `docs/delivery/tui-v4/keys-status.md:97,106`).

### Advanced MCP/skills

- MCP OAuth, registry install, project MCP config, `tool_search`, `mcp_resource`, sampling/roots and full server management are absent (`docs/adr/0068-user-mcp-connect.md:18`; `CLAUDE.md:5`).
- Skill index URL download/cache/version pinning, admin `/etc/futryn/skills`, self-installer, MCP dependencies declared by skills, plugin/cloud skills are deferred (`docs/delivery/wave-2/deferred.md:7-15`). Local skill discovery/activation is present (`packages/workspace/skills/`, `tests/contracts/skills.test.ts`), but remote/admin/plugin skill distribution is not.

## 4. Priority view for final gap list

P0 (user-visible broken/absent):

1. Authenticated live provider/login/generation acceptance across all configured providers; exact usage/quota/token reporting when vendors omit usage.
2. Advanced MCP operations (OAuth/project config/registry/resource/tool search) and plugin/hooks host.
3. OpenCode V1/V2 server/TUI/GUI/RPC compatibility and GUI/web/desktop host.
4. Agent teams/remote/cloud orchestration if parity with modern Codex/OpenCode is required.

P1 (partial parity):

1. Claude keyboard/UI gaps: fast/thinking toggles, Vim, mouse/wheel, clipboard OS, notifications/language, automatic resume.
2. Linux/Windows sandbox/LSP/worktree verification and provider subscription runtimes.
3. CLI/TUI command registry consistency (`/compact`, `/rewind`, `/mcp` handlers).
4. Deferred skill distribution/admin/auto-memory extraction.

P2 (explicitly constrained by policy/design):

1. External agent runtimes (intentionally prohibited by ADR 0045-0049; this is a policy boundary, not an accidental stub).
2. Browser-like binary web fetch and arbitrary untrusted plugin JS (security boundary).

## 5. Test/evidence inventory

- Contract/security/end-to-end tests cover the implemented local behaviors. Main suites: `tests/contracts/`, `tests/security/`, `tests/end-to-end/`, `tests/mcp/user-servers.test.ts`.
- Tests are mostly deterministic fixtures. The repository docs repeatedly require reporting live authenticated vendor acceptance, OS matrix and exact upstream compatibility separately; fixture-green must not be called OpenCode/Codex parity (`CLAUDE.md:62`; `docs/delivery/subscription-auth.md:49,185`; `docs/compatibility/opencode-v1-v2.md:33-35`).
- Historical delivery pages include pre-P3 failures and stale “not implemented” baseline sections. For final reporting, use current source and the P3 final table in `docs/delivery/tui-v4/p2-status.md:90-104`, then list the remaining explicit limits above.
