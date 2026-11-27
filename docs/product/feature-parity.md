# Feature parity theo capability

## Trạng thái mã nguồn hiện tại — 2026-11-27

Đây là kiểm kê implementation, không phải chứng nhận tương thích toàn bộ provider/OS hay Product MVP complete. Các bảng P0–P9 cũ ở cuối trang là lịch sử thiết kế.

| Capability | Trạng thái hiện tại | Giới hạn / bằng chứng |
|---|---|---|
| Agent headless và file/shell tools | Có CLI (`cosmew exec` gồm `--json-schema`, `--max-turns`, `--max-budget-usd`, `--fallback-model`, `--system-prompt`, `--add-dir`, `--resume`/`--continue`), SDK, dispatcher, stdin/JSONL, shell/PTY/background | [Hợp đồng](../contracts/agent-events.md), [ADR 0124](../adr/0124-exec-cicd-context-rules-auto-memory-and-lsp.md), [test strategy](../delivery/test-strategy.md); mọi tool vẫn qua policy/approval/audit |
| Provider abstraction | Có adapters/protocols (`chat`, `responses`, `anthropic`, `gemini`, `azure`, `bedrock`, `vertex`, `vertex-anthropic`), AWS SigV4 & Bedrock Bearer + `cachePoint`, Google ADC/Service Account OAuth2, Azure v1 & deployment + Entra Bearer, Anthropic ephemeral prompt caching, OpenAI `prompt_cache_key`, provider tùy chỉnh, API/OAuth | [Providers/auth](../subsystems/providers-and-auth.md), [ADR 0120](../adr/0120-executable-hooks-and-prompt-caching.md), [ADR 0122](../adr/0122-enterprise-cloud-providers-bedrock-vertex-azure.md); xác minh live theo từng model/cloud tenant là Needs verification, không chạy CLI agent bên ngoài |
| Streaming/TUI | Có Ink fullscreen, queue/steer, hủy, search, transcript windowing, `/add-dir`, `/reload-skills`, `/autocompact`, `/btw`, clipboard text/ảnh đa nền tảng (macOS/Linux/Windows) và external editor | [Performance](../delivery/tui-v4/performance-transcript.md), [ADR 0123](../adr/0123-cross-platform-bwrap-proxy-clipboard-packaging-windows.md); clipboard Linux/Windows và PTY cần acceptance trên host thật |
| Session/context/recovery | Có resume theo workspace, compaction, checkpoints, rewind, rename, `/clear <name>`, export Markdown/JSON/text | [Stability delivery](../delivery/product-stability-fixes-2026-11-22.md), [ADR 0120](../adr/0120-executable-hooks-and-prompt-caching.md) |
| Git/LSP/worktrees | Có diff, search, LSP/rename (13 preset ngôn ngữ + `[lsp.<id>]` cấp người dùng trong `config.toml`), isolated agents và handoff qua patch | [ADR 0097](../adr/0097-worktree-review-handoff.md), [ADR 0124](../adr/0124-exec-cicd-context-rules-auto-memory-and-lsp.md); binary/symlink/oversized có đường review thủ công |
| MCP | Có stdio/HTTP, manager, reconnect, OAuth/bearer, discovery, managed npm install/update/rollback provenance, deferred `tool_search`, `mcp_resource`, MCP prompts (`/mcp__server__prompt`), ảnh/PDF attachments và `list_changed` notifications | [ADR 0102](../adr/0102-mcp-manager.md), [ADR 0119](../adr/0119-deferred-mcp-tool-search-and-resources.md), [ADR 0121](../adr/0121-mcp-prompts-media-notifications-and-provenance.md); sampling/roots/elicitation còn backlog |
| Skills và memory | Có discovery/visibility/reload (`skills` + `.cosmew/.claude/commands`), path-scoped `.cosmew/.claude/rules` + `@import`, memory CRUD/index/citations/recovery và `memories.auto_extract` có kiểm duyệt bí mật | [ADR 0124](../adr/0124-exec-cicd-context-rules-auto-memory-and-lsp.md); settings trust và quyền ghi vẫn áp dụng |
| Hooks/plugins | Có Executable Hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`) chuẩn trust SHA-256; chưa có general plugin host | [ADR 0120](../adr/0120-executable-hooks-and-prompt-caching.md); plugin host vẫn backlog |
| Subagents/background/sandbox | Có agents, budget, cancel, background tasks, sandbox tùy chọn (macOS Seatbelt + Linux bubblewrap kèm Unix-socket `socat` proxy bridge), đóng gói binary (`build:binary`) và Windows unsandboxed hardening | [ADR 0123](../adr/0123-cross-platform-bwrap-proxy-clipboard-packaging-windows.md); macOS có native tests & compiled binary smoke test; Linux bubblewrap/network và Windows host cần acceptance riêng (Needs verification) |
| IDE/ACP, web/desktop product, marketplace | Backlog | LSP đã có không đồng nghĩa IDE bridge hoặc giao diện web/desktop đã có |

Ưu tiên lỗi và tính năng được theo dõi trong [audit hiện tại](../delivery/next-priorities-2026-11-22.md). Đọc báo cáo kiểm thử mới nhất trước khi dùng các số liệu acceptance cũ.

## Lịch sử backlog Phase 0

Bảng dưới đây ghi backlog mục tiêu tại Phase 0; nhãn **Not implemented** là trạng thái lịch sử, được thay thế bởi kiểm kê hiện tại ở trên. Nguồn tham khảo mô tả công khai, không chứng minh Cosmew tương đương.

| Capability | Cảm hứng | Đích Cosmew | Acceptance / phase |
|---|---|---|---|
| Headless agent và tools | Codex, Goose | Một loop độc lập UI | P1: task đọc/chỉnh sửa có kết quả xác thực |
| Provider abstraction | OpenCode | 9Router trước; adapter đổi endpoint | P1: fixture tool call/usage/error qua cùng contract |
| Streaming/TUI | OpenCode | Delta có sequence, cancel qua TUI | P2: partial call không execute |
| Sessions/resume | Goose, Codex | Event log/checkpoint bền | P2–3: crash không replay shell mù |
| Context/project rules | Coding agents tham khảo | Budget, instructions, compaction có provenance | P3: không mất pending approval |
| Git/code intelligence | OpenCode/Codex | Diff, search, LSP, AST | P3: stale index được đánh dấu |
| MCP | Goose/OpenCode | Official SDK; tools/resources/prompts | P4: transport/OAuth/permission fixtures |
| Skills/hooks/plugins | OpenCode, DeepSeek | Capability-scoped extension host | P5: rollback registration khi init lỗi |
| OpenCode compatibility | API công khai được pin | V1/V2 server/TUI/GUI/RPC riêng | P6: từng fixture riêng; GUI chưa có host không đạt |
| Cordis composition | DeepSeek Harness | In-process/sidecar/hybrid chưa chốt | P7: effect cleanup, reload, service version |
| Subagents/background/sandbox | Codex/harness patterns | Budget phân bổ, isolation kiểm chứng | P8: child không mở rộng quyền |
| Web/desktop/marketplace | OpenCode/Goose | Interfaces và cài plugin có provenance | P9: host và conformance gates |

Chi tiết phiên bản, strategy và bài kiểm định tại [compatibility matrix](../compatibility/compatibility-matrix.md). Không dùng phần trăm tương thích tổng hợp.
