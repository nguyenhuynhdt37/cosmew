# Audit khoảng trống Codex CLI / OpenCode / Cosmew

Ngày audit: 2026-11-21

Phạm vi: đối chiếu source hiện tại của Cosmew với Codex CLI `main` và OpenCode `dev`. Đây là backlog parity; các repo upstream thay đổi liên tục nên cần kiểm tra lại revision trước mỗi phase.

## Đã có khá tốt

- Agent loop riêng, không chạy tiến trình Codex/Claude/OpenCode bên ngoài.
- `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `exec_command`, `write_stdin`.
- Permission modes, settings precedence, macOS Seatbelt, network proxy, audit/redaction.
- Durable sessions, recovery, compaction, checkpoints, rewind, plan approval, queue retraction.
- Subagents sync/background/custom agents/worktree isolation.
- LSP/rename, web search/fetch, memories CRUD/citations, user MCP stdio/HTTP.
- Ink fullscreen TUI, transcript, slash commands, panels, permissions, questions, usage, diff, keymap hot reload.

Bằng chứng local: [repo audit](../research_notes/Codex%20OpenCode%20Cosmew%20audit/repo.md).

## Thiếu hẳn

### Codex CLI parity

Codex hiện có các nhóm lệnh/host mà Cosmew chưa có đầy đủ: `app-server`, `remote-control`, `cloud`, `queue`, `archive`, `delete`, `unarchive`, `fork`, `sandbox`, `apply`, `features`, desktop app và completion scripts. [Codex CLI source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)

Thiếu tiếp:

- Cloud tasks/remote agents.
- App-server protocol và remote control/pairing.
- Agent teams/teammates/shared mailbox/shared task coordination.
- Codex TOML agent roles.
- Auto-review/approval reviewer.
- Apps/connectors.
- Shell snapshots và deferred executors.
- Full memory extraction/consolidation.
- Claude/Codex import flows.

Codex TUI cũng có nhiều lệnh chưa có tương đương: `/init`, `/recap`, `/rename`, `/export`, `/raw`, `/worktree`, `/goal`, `/side`, `/btw`, `/vim`, `/presets`, `/apps`, `/plugins`, `/voice`, `/daemon`, `/warnings`, `/statusline`, `/rollout`, `/keymap`. [Codex TUI commands](https://github.com/openai/codex/blob/main/codex-rs/tui/src/slash_command.rs)

### OpenCode parity

OpenCode có server/client architecture riêng, HTTP API/OpenAPI/SSE, `serve`, `pair`, web/desktop UI và ACP; Cosmew hiện chỉ có CLI/TUI một tiến trình. [OpenCode CLI commands](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/cli/commands.mdx)

Thiếu:

- Plugin SDK/runtime/lifecycle/reload.
- Custom tools và plugin-provided commands.
- Plugin hooks/transforms/veto.
- OpenCode V1/V2 plugin compatibility.
- Web/desktop GUI.
- Server mode/API/RPC.
- ACP integration.
- Session move/rename/worktree management.
- Persistent background terminals.
- Archived scripted runs.
- Artifacts/static HTML publishing.
- Usage stats/export dashboards.
- Provider catalog breadth comparable to Models.dev.
- Automatic formatter/LSP/provider discovery.

OpenCode hiện có permission-controlled tools, custom tools/MCP và plugin runtime. [Tools](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/tools.mdx), [plugins](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/plugins.mdx), [config/providers/worktrees](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/config.mdx).

### Plugin/hooks platform

Repo hiện báo plugin host chưa triển khai và hooks `supported: false`.

Thiếu toàn bộ:

- Plugin install/discovery/update.
- Trusted package lifecycle.
- Plugin config/schema.
- Hook runner.
- `before/after` transforms.
- Hook veto/cancel.
- Plugin-provided tools, commands, panels, keybindings.
- Extension service bridge.

### MCP đầy đủ

Đã có user MCP stdio/HTTP, nhưng còn thiếu:

- OAuth.
- Project MCP config.
- MCP registry/install.
- `tool_search`.
- `mcp_resource`.
- Sampling.
- Roots.
- Prompts/resources/annotations.
- Server management đầy đủ.
- Remote/shared MCP connection pooling.

### Agent orchestration

Đã có parent-child subagents, nhưng thiếu:

- Remote/cloud child agents.
- Agent teams.
- Peer-to-peer mailbox.
- Shared task board.
- Lead/worker coordination.
- Cross-agent live presence.
- Automatic background-agent resume sau process restart.
- Rich teams dashboard.

### Provider/auth/live generation

- Live authenticated generation chưa được xác minh đồng đều cho từng provider.
- Subscription runtimes không còn là backend thực thi.
- Provider-specific auth refresh, quota, cache billing, tool support và context limits chưa đồng nhất.
- Không có tokenizer fallback khi provider không trả usage.
- Exact token/cost không thể tính nếu API không trả usage.
- Login status từ một số SDK có thể nằm ở `status`, `statusCode` hoặc `response.status`; adapter đã được chuẩn hóa để giữ `AUTH`/`FORBIDDEN`/`NOT_FOUND` thay vì biến thành `PROTOCOL`.
- Login wizard custom gateway đã có fallback API-key/none khi provider không nằm trong integration catalog.

## Có nhưng còn sơ sài

### TUI

- Fast mode/thinking toggle chưa có provider contract.
- Vim mode chưa có.
- Mouse selection/wheel/terminal copy chưa có.
- Native clipboard mới được kiểm một phần; OS parity chưa xác minh.
- Desktop notifications chưa có.
- Interface language chưa có.
- Automatic resume preference chưa có.
- Một số slash command TUI có backend nhưng CLI line mode vẫn báo chưa hỗ trợ.
- `/hooks`, một số MCP/rewind routes còn metadata/handler lệch nhau.

### Sandbox/platform

- macOS Seatbelt có kiểm thử tốt.
- Linux bubblewrap chưa được xác minh đầy đủ.
- Windows command sandbox chưa có.
- Linux network proxy/sandbox parity chưa có.
- LSP Python/Go/Rust và non-macOS chưa xác minh.
- Worktree isolation trên Linux/Windows chưa xác minh.

### Memories/background

- Memory CRUD, usage tracking, citations có.
- Automatic extraction/consolidation vẫn tắt/deferred.
- Background tasks có notification và output tail, nhưng process không tự sống qua restart như server-managed job.

### Skills

- Local project/user skill discovery có.
- Thiếu remote skill distribution, registry, admin/system skill management, version pinning, MCP dependencies của skill, plugin/cloud skills.

## Ưu tiên fix

### P0 — ảnh hưởng trực tiếp người dùng

1. Chuẩn hóa login/provider lifecycle và live acceptance cho từng provider.
2. Chuẩn hóa usage/token/quota/cost reporting.
3. Plugin/hooks host.
4. MCP OAuth/resources/registry/tool search.
5. Server/API/remote execution layer.

### P1 — parity quan trọng

1. Agent teams/mailbox/cloud agents.
2. OpenCode plugin/server/ACP compatibility.
3. Codex app-server/remote-control.
4. Vim, mouse, clipboard, notifications, automatic resume.
5. Linux/Windows sandbox và LSP verification.

### P2 — sản phẩm mở rộng

1. GUI/web/desktop.
2. Artifacts/static publishing.
3. Persistent background terminals.
4. Provider catalog rộng kiểu Models.dev.
5. Memory auto-extraction/consolidation.
6. Skills registry/admin distribution.

## Ranh giới thiết kế cần giữ

- External agent runtimes bị cấm theo ADR 0045–0049; đây là quyết định bảo mật/ownership, không phải TODO vô tình bỏ sót.
- Browser-like binary web fetch và arbitrary untrusted plugin JS cần thiết kế security riêng trước khi triển khai.
- Provider không trả usage thì không được bịa số token; cần tokenizer/provider billing API hoặc giữ trạng thái unknown.

## Kiểm thử hiện tại

Audit trước đó đã chạy toàn bộ suite: **828 pass, 8 skip, 0 fail** trên 836 test. Provider/auth fix gần nhất chạy **54 pass, 2 skip, 0 fail**; `bun run lint` sạch.

Mỗi nhóm P0/P1 nên được tách thành một phase có ADR, contract, acceptance test và bằng chứng live riêng; fixture xanh không đủ để tuyên bố parity provider hoặc OS.
