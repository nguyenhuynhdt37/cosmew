# ADR 0125 — User-Scoped Plugin Host, In-Session Automation (`/loop`, `/schedule`) & Parallel `/batch`

- **Trạng thái**: Đã triển khai (2026-11-27)
- **Hợp đồng chia sẻ**: `1.70` (từ `1.69`, chỉ cộng thêm / additive)
- **Dependency mới**: 0

## 1. Bối cảnh & Mục tiêu

Sau khi hoàn thiện Phase 1 (ADR 0124), hệ sinh thái mở rộng của Cosmew vẫn còn 2 khoảng trống lớn so với Claude Code và lộ trình parity:
1. Người dùng chưa thể đóng gói và quản lý chung `skills + commands + agents + hooks + mcpServers` theo từng gói plugin (với `capabilities().pluginHost` vẫn trả `'not-implemented'`).
2. Chưa có cơ chế tự động lặp/hẹn giờ có giới hạn trong phiên (`/loop`, `/schedule`) và chia việc fan-out song song nhiều subagent có cô lập worktree (`/batch`).
3. `/setup-bedrock` và `/setup-vertex` vẫn nằm ở trạng thái `unavailable` dù backend AWS Bedrock và Google Vertex AI đã hoàn tất từ ADR 0122.

## 2. Quyết định Thiết kế

### 2.1. User-Scoped Plugin Host (`2A`)
- **Nơi lưu trữ**: Duy nhất cấp người dùng tại `<stateDirectory>/plugins/<id>/` (mặc định `~/.cosmew/plugins/`) và registry nguyên tử `<stateDirectory>/plugins.json` (mode `0600`). **Không bao giờ tự nạp hay tự cài plugin từ trong thư mục repository.**
- **Bố cục tương thích**: Chấp nhận `plugin.json`, `.cosmew-plugin/plugin.json` hoặc `.claude-plugin/plugin.json`, cùng các thư mục mặc định `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` / `mcp.json`.
- **Giới hạn an toàn tại `packages/workspace/src/plugins.ts`**: Chặn tuyệt đối symlink mọi cấp, path traversal, thư mục `.git`/`node_modules` bên trong gói, giới hạn mỗi tệp ≤ 256 KiB, tổng gói ≤ 4 MiB, tối đa 256 tệp/gói và 64 plugin đã cài. Cài đặt local qua staging + atomic rename (`copyPluginDirectorySafe`).
- **Cổng tin cậy SHA-256 bắt buộc (Cryptographic Content Trust)**:
  - `computePluginDirectoryHash` tính SHA-256 tất định trên toàn bộ cây tệp và nội dung plugin.
  - Tài nguyên chỉ đọc (`skills`, `commands`, `agents`) được nạp ở độ ưu tiên thấp hơn project & user (`project > user > plugin > system`) và luôn là dữ liệu không tin cậy.
  - Tài nguyên thực thi (`hooks` và `mcpServers`) **mặc định bị chặn (`untrusted`)** cho đến khi người dùng duyệt đúng `contentHash` (`expectedHash === currentHash`, chống TOCTOU). Thay đổi bất kỳ byte nào trên đĩa lập tức chuyển trạng thái sang `trust-changed` và ngắt thực thi cho đến khi duyệt lại.
  - Hooks của plugin đi qua `HookExecutor` hiện hữu (tự tắt ở `plan`, tuân thủ `sandbox.enabled`, không bao giờ cấp quyền). MCP servers của plugin đã tin cậy đi qua `McpManager` → `McpHub` → `ToolDispatcher` (user `mcp.json` luôn ưu tiên nếu trùng tên server, mọi secrets được đăng ký vào `Redactor`).
- **Giao diện**: `cosmew plugin <list|install|uninstall|enable|disable|trust|revoke|reload> [--json]`, TUI overlay `PluginsDialog` (`/plugin`, `/plugins`) và `/reload-plugins`. `capabilities().pluginHost` phản ánh thật `'implemented'` khi backend nối `PluginManager`.

### 2.2. In-Session Autonomous Loop & Scheduling (`/loop`, `/schedule`) (`2B`)
- Triển khai `SessionScheduler` trong `packages/core/src/automation/scheduler.ts` (tiêm clock để kiểm thử tất định) cùng parsers dùng chung ở `packages/contracts/src/automation.ts`.
- **Chỉ sống trong phiên hiện tại** (không cài cron hệ thống ngầm sau khi thoát).
- **Chốt chặn cứng**:
  - Tối đa `8` job hoạt động/phiên; khoảng lặp bị kẹp cứng `5s .. 24h`; trần số vòng mặc định `10` (`/loop`) hoặc `20` (`/schedule`), tối đa tuyệt đối `100`.
  - Hỗ trợ điều kiện dừng sớm `--until "<text>"`, trần chi phí `--max-cost <usd>`, hẹn giờ 1 lần `/schedule in <dur>`, và tự dừng sau `3` lỗi liên tiếp.
  - Cấm re-entrancy khi phiên đang bận hoặc có prompt quyền/câu hỏi đang chờ.
  - Hủy sạch bằng `Esc`, `/loop stop`, `/schedule stop`, chuyển phiên hoặc tắt TUI/ứng dụng.

### 2.3. Parallel Fan-out (`/batch`) (`2B`)
- Triển khai `BatchRunner` trong `packages/agents/src/batch.ts`, gọi thẳng `SubagentExecutionPort` (`SubagentManager`) với worker pool bị kẹp bởi `SubagentScheduler.maxThreads()` và tối đa `12` tác vụ/lượt.
- Hỗ trợ tách tác vụ bằng `;;` hoặc `--targets "a,b,c"` với placeholder `{{target}}`, tùy chọn `--isolation worktree` (tái sử dụng ADR 0097 worktree handoff), `--agent <type>`, `--concurrency <n>`.
- Chế độ `plan` / `review` từ chối `--isolation worktree` (`POLICY`) và tự ép agent chỉ đọc (`explore`).

### 2.4. Metadata Cloud Setup (`2C`)
- Kích hoạt `/setup-bedrock` và `/setup-vertex` trong `packages/sdk/src/commands.ts` nối thẳng sang luồng kết nối provider `bedrock` / `vertex` (ADR 0122).

## 3. Tương thích & Quy tắc Phụ thuộc

- **0 cạnh phụ thuộc mới** trong [dependency-rules.md](../architecture/dependency-rules.md): parsers thuần nằm ở `contracts`, `workspace` giữ scanner/hasher/copier, `core` giữ `SessionScheduler`, `agents` giữ `BatchRunner`, `apps/cli` là composition root duy nhất nối `PluginManager` / `McpManager` / `HookExecutor` / `SessionScheduler` / `BatchRunner`, `apps/tui` chỉ dùng `sdk` + `contracts`.
- Nâng `CONTRACT_VERSION` lên `'1.70'`; mọi trường và port mới đều tùy chọn (additive).
