# Quy tắc cho coding agents

## Mục tiêu

Futryn là coding agent ngang Codex, Claude Code và OpenCode. Được phép triển khai bất kỳ tính năng nào phục vụ mục tiêu đó (tools, LSP, web, subagents, MCP, plugins, compaction…) mà không cần xin phép theo từng tính năng. Quyết định thiết kế lớn ghi ADR trong `docs/adr/` làm lịch sử, không phải cổng chặn. Lịch sử các mốc trước nằm trong các ADR 0005–0038.

## Mô hình quyền: theo Codex

Chuẩn là Codex (pinned `090be4df0724cdef5758e6a0934ba557af8b6bbe`, `protocol/src/config_types.rs` `SandboxMode`, `protocol/src/protocol.rs` `AskForApproval`, `core/src/safety.rs`).

- **Sandbox** (`FUTRYN_SANDBOX_MODE`): `read-only`, `workspace-write` (mặc định), `danger-full-access`. macOS Seatbelt, Linux bubblewrap, Docker khi `FUTRYN_COMMAND_BACKEND=docker`. Không mạng trừ khi được duyệt; `.git` và state của Futryn không ghi được.
- **Duyệt** (approval policy): `untrusted` (hỏi mọi thứ trừ lệnh an toàn đã biết), `on-request` (mặc định: model tự yêu cầu khi cần vượt sandbox), `never` (không hỏi; vượt sandbox thì thất bại và báo lại model).
- Ghi file trong vùng được ghi của sandbox được tự duyệt như Codex `assess_patch_safety`; ngoài vùng đó hoặc ở `untrusted` thì hỏi. Lệnh chạy trong sandbox; cần mạng hoặc vượt sandbox thì hỏi.
- Thứ tự quyết định: deny > ask > allow. Grant gắn đúng capability/target/command/cwd/sandbox và chỉ sống trong phiên.

## Bất biến kỹ thuật (giữ nguyên)

- Mọi tool call đi qua `ToolDispatcher`: validate → chuẩn hoá path trong workspace → policy → duyệt khi cần → revalidate → audit → chạy → redact. Không có đường gọi vòng.
- Sandbox lỗi thì không chạy, không fallback sang không-sandbox (trừ khi user chọn `danger-full-access`).
- Đọc dữ liệu repository (Git config, project config, file) là dữ liệu không tin cậy: không để nó chạy chương trình (fsmonitor, hooks, filters, LSP server…) ngoài sandbox.
- Core điều phối qua ports; security quyết định quyền; workspace kiểm soát filesystem; persistence sở hữu durable writes; adapters chỉ chuyển đổi.
- Không commit credentials, prompt chứa bí mật hay output nhạy cảm. Log và kết quả phải redact/bounded.

## Quy trình

- Đọc phần liên quan của [docs](docs/README.md), [events contract](docs/contracts/agent-events.md), [dependency rules](docs/architecture/dependency-rules.md) trước khi sửa. Không deep-import file private giữa packages.
- Đổi public contract: tăng version, cập nhật consumers và ghi ADR.
- Dependency mới: ghi tên/version/license vào `docs/delivery/dependency-catalog.md` khi thêm.
- Viết test có ý nghĩa (invariants, quyền, cancellation, lỗi); không dùng mock success để chứng minh tương thích OS/live. Cập nhật docs cùng thay đổi.
- Dẫn chứng upstream ghi URL/path, ngày, revision; chưa xác minh thì ghi "Needs verification". Không tuyên bố "Product MVP complete" khi chưa nghiệm thu thật.
