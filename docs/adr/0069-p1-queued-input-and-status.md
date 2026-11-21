# ADR 0069 — P1: rút input và snapshot trạng thái SDK

Ngày: 2026-11-20. Trạng thái: Accepted (queue/status); hooks execution: **Proposed, not built**.

## Quyết định

Contract 1.37 → 1.38 (additive). Không đổi quyền hay dependency DAG. `queuedInput()` hợp nhất steering chưa giao và inbox turn sau. `retractQueuedInput()` lấy hết nội dung còn chờ, trả một chuỗi nối bằng newline; input đã được runtime nhận để giao không được rút lại. Claim/retract đồng bộ trên một Conversation; SQLite transaction IMMEDIATE tuần tự hóa với beginExecution. Snapshot không phải quyền và không được dùng làm bằng chứng giao input.

SQLite 8 → 9 thêm `input_retractions` (id, conversation, at), receipt chỉ append; journal user.steered được giữ nguyên. Reconstruction loại steering đã rút khỏi model context; không rewrite journal/compaction. Inbox được xóa trong cùng transaction ghi receipt. Claim cũ sau rút thất bại; receipt rút không áp dụng lên input đã giao. Schema cũ tự migration khi mở; binary cũ từ chối version mới. SDK embedding không có port retract trả UNSUPPORTED.

`sendQueuedNow()` chuyển shell đang chạy xuống nền nếu movable; nếu không thì abort turn hiện tại. Steering chưa claim được chuyển atomically sang next-turn inbox (receipt rút + enqueue cùng transaction), tránh bị kẹt sau interrupt hoặc giao hai lần. Inbox bền vững được giao ở lượt kế qua cùng takeQueuedMessage/sendMessage của host; API trả backgrounded/interrupted/idle, không tự chạy agent loop thứ hai.

`hooks()` luôn `{supported:false,hooks:[]}`. Contract `HookRanEvent` và SDK `onHookRan`/event `hook.ran` dành cho renderer; không có producer execution. Tên và summary qua redactor trước callback. Thiết kế tương lai: chỉ hooks từ user-level settings.json `hooks`; command hook qua dispatcher và sandbox, policy/intent/revalidation/audit như Bash. Repository settings là dữ liệu không tin cậy, không được tự thêm lệnh hay mở rộng quyền. Chưa xây hook execution, timeout, cancellation, durable result hay cơ chế nạp cấu hình.

`mcpServers()` chiếu từ mcpStatus đang nối tại composition root, chỉ metadata tên/trạng thái/toolCount/source. `supported.stdioManagement=false`, `supported.oauthManagement=false`; kết nối stdio hiện có theo ADR0068 vẫn giữ nguyên, không tuyên bố OAuth/registry management. Không lộ URL/header/env.

## Consumer / bằng chứng

CLI inject port retract từ Conversation/SqliteConversations; SDK không import persistence/core. Consumer TUI chuyển API ở wave sau, không sửa apps/tui. ModelEvent thêm hook.ran additive; consumer bỏ qua event lạ phải nâng contract trước bật producer. Tests `input-retraction.test.ts`: hai thứ tự acceptance/retraction, stale snapshot, redaction, giữ journal và recovery loại input đã rút. Claude Code live behavior chi tiết: **Needs verification**; yêu cầu tham chiếu từ docs/delivery/tui-v4/keys.md và user wave P1, không khẳng định parity 100%.
