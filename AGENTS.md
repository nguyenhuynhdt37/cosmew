# Quy tắc cho coding agents

## Mục tiêu

Futryn là coding agent ngang Codex, Claude Code và OpenCode. Được phép triển khai bất kỳ tính năng nào phục vụ mục tiêu đó (tools, LSP, web, subagents, MCP, plugins, compaction…) mà không cần xin phép theo từng tính năng. Quyết định thiết kế lớn ghi ADR trong `docs/adr/` làm lịch sử, không phải cổng chặn. Lịch sử các mốc trước nằm trong các ADR 0005–0038.

## Mô hình quyền: theo Codex

Chuẩn là Codex (pinned `090be4df0724cdef5758e6a0934ba557af8b6bbe`, `protocol/src/config_types.rs` `SandboxMode`, `protocol/src/protocol.rs` `AskForApproval`, `core/src/safety.rs`).

- **Sandbox** (`FUTRYN_SANDBOX_MODE`, hoặc `sandbox_mode` trong `~/.futryn/config.toml`): `read-only`, `workspace-write` (mặc định), `danger-full-access`. macOS Seatbelt, Linux bubblewrap, Docker khi `FUTRYN_COMMAND_BACKEND=docker` (Docker từ chối `danger-full-access`). Ở `workspace-write`, mặc định chỉ localhost (bind/connect), mạng ngoài cần duyệt trừ khi bật `[sandbox_workspace_write] network_access = true` trong `~/.futryn/config.toml` hoặc `FUTRYN_SANDBOX_NETWORK=1` (cấp user, không bao giờ đọc từ workspace; ghi ngoài workspace và ghi `.git` vẫn bị chặn); `.git` đọc được nhưng không ghi được, state của Futryn bị chặn (ADR 0053, 0055).
- **Duyệt** (`FUTRYN_APPROVAL_POLICY`, hoặc `approval_policy` trong `~/.futryn/config.toml`): `untrusted` (hỏi mọi thứ trừ rule allow đã lưu), `on-request` (mặc định: model tự yêu cầu khi cần vượt sandbox), `never` (không hỏi; vượt sandbox thì thất bại và báo lại model, trừ khi phiên đang ở `danger-full-access`).
- **Preset & câu trả lời duyệt (ADR 0055)**: TUI (`/permissions`, `Shift+Tab`) có 3 preset như Codex: `Read Only` (`read-only` + `on-request`), `Auto` (mặc định: `workspace-write` + `on-request`), `Full Access` (`danger-full-access` + `never`, không sandbox và không hỏi, kèm cảnh báo rõ; `fyn exec --sandbox danger-full-access` hoặc `--dangerously-bypass-approvals-and-sandbox`). Câu trả lời khi hỏi quyền theo Codex `ReviewDecision`: `once` ("Lần này"), `session` ("Cả phiên"), `always` ("Luôn cho project" — ghi allow rule `Bash`/`Network`/`Unsandboxed`/`Edit`/`Read`/`WebFetch`). Xin mạng bằng `request_permissions` chọn `session` có hiệu lực suốt cả phiên và cấp mạng ngầm cho lệnh trong sandbox; `require_escalated` chọn `session` nhớ đúng lệnh/cwd/sandbox đó như Codex.
- Ghi file trong vùng được ghi của sandbox được tự duyệt như Codex `assess_patch_safety`; ngoài vùng đó hoặc ở `untrusted` thì hỏi. `on-request`/`never` chạy mọi lệnh không bị coi là nguy hiểm (kể cả script không parse được và input `write_stdin`); `untrusted` hỏi. Mạng ngoài (khi chưa bật `network_access`/grant) và `sandbox_permissions: "require_escalated"` (ngoài Full Access) thì hỏi, `never` từ chối (ADR 0053, 0055).
- Thứ tự quyết định: deny > ask > allow > mode/preset. Deny rule của project luôn thắng ở mọi chế độ (kể cả Full Access); audit luôn ghi đầy đủ. Grant gắn đúng capability/target/command/cwd/sandbox và chỉ sống trong phiên.

## Bất biến kỹ thuật (giữ nguyên)

- Mọi tool call đi qua `ToolDispatcher`: validate → chuẩn hoá path trong workspace → policy → duyệt khi cần → revalidate → audit → chạy → redact. Không có đường gọi vòng.
- Sandbox lỗi thì không chạy (`SANDBOX_FAILED`), không tự fallback sang không-sandbox. Chạy không sandbox chỉ xảy ra khi phiên được đặt ở `danger-full-access` (config user/env/preset/cờ `exec`) hoặc khi model yêu cầu `require_escalated` và được user/rule `Unsandboxed` duyệt (`never` ngoài Full Access: từ chối).
- Đọc dữ liệu repository (Git config, project config, file) là dữ liệu không tin cậy: không để nó chạy chương trình (fsmonitor, hooks, filters, LSP server…) ngoài sandbox.
- Core điều phối qua ports; security quyết định quyền; workspace kiểm soát filesystem; persistence sở hữu durable writes; adapters chỉ chuyển đổi.
- Không commit credentials, prompt chứa bí mật hay output nhạy cảm. Log và kết quả phải redact/bounded.

## Quy trình

- Đọc phần liên quan của [docs](docs/README.md), [events contract](docs/contracts/agent-events.md), [dependency rules](docs/architecture/dependency-rules.md) trước khi sửa. Không deep-import file private giữa packages.
- Đổi public contract: tăng version, cập nhật consumers và ghi ADR.
- Dependency mới: ghi tên/version/license vào `docs/delivery/dependency-catalog.md` khi thêm.
- Viết test có ý nghĩa (invariants, quyền, cancellation, lỗi); không dùng mock success để chứng minh tương thích OS/live. Cập nhật docs cùng thay đổi.
- Dẫn chứng upstream ghi URL/path, ngày, revision; chưa xác minh thì ghi "Needs verification". Không tuyên bố "Product MVP complete" khi chưa nghiệm thu thật.
- Đăng nhập/provider (ADR 0045–0049): Futryn chỉ gọi API của provider và nhận response; mọi model chạy agent loop và tool của Futryn. Cấm mọi tiến trình agent bên ngoài: không còn backend `delegated`/`codex-bridge`, không còn runtime Codex/Copilot/Gemini/Qwen/Grok; ChatGPT chỉ đăng nhập qua API (OAuth). Provider tuỳ chỉnh khai báo ở `~/.futryn/config.toml` `[model_providers.<id>]` (chỉ cấp người dùng, không token dạng chữ). ChatGPT API thuần và DeepSeek cần xác minh live ("Needs verification").
