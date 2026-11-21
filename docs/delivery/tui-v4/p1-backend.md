# P1 backend / SDK

Ngày: 2026-11-20. Contract 1.38, SQLite 9; không thêm dependency.

ADR0069: queue retraction và hooks/MCP snapshot. ADR0070/0071/0072: background shell, plan approval, image attachments (xem từng ADR cho trạng thái và giới hạn). TUI chưa chuyển sang các API mới ở wave này.

`queuedInput` bao gồm live steering và next-turn inbox; `retractQueuedInput` trả text đã redact, chỉ rút phần runtime chưa claim để giao. `sendQueuedNow` trả trạng thái và host tiếp tục giao inbox qua API queue hiện có. Hooks execution chưa có; snapshot supported false. MCP snapshot giữ trạng thái thực từ user MCP hub, management flags false.

ADR0073: checkpoint text patch có conversationIndex/promptId/text/fileChanges (+/-),
rewind conversation tạo phiên mới và append rewind_events; code restore đi qua dispatcher
và so post hash/mode. Không rollback shell/MCP/subagent/worktree/binary changes. Xung đột
được từ chối trước ghi; lỗi OS giữa nhiều file có thể partial, không tuyên bố filesystem
transaction. Ảnh pending chỉ trong RAM, journal chứa chip; restart mất payload (ADR0072).

## Kiểm tra thực tế trong managed sandbox

- `bun run format`: qua; lần cuối chỉ database.ts cần format, apps/tui và các file bảo vệ unchanged.
- `bun run typecheck`: qua, không còn lỗi paths.ts tại thời điểm kiểm tra; không sửa paths.ts.
- 10 file tập trung (input-retraction, queued-input, status-tools, plan-approval,
  image-attachments, background-tasks, checkpoints, security/background-tasks,
  execution-session-permissions, read-extended): **43 pass, 4 skip, 0 fail**, 269 assertions.
- `bun test tests/contracts`: **231 pass, 34 fail**. 33 lỗi `Bun.serve`
  `EADDRINUSE` tại port 0 (provider-adapters/provider-limits/usage-context/configuration/
  user-shell-history và các consumers fixture HTTP); 1 lỗi process-observer vì `ps`
  không quan sát được process trong sandbox. Không gọi các test này là qua.
- Chạy mở rộng `tests/security/exec-command.test.ts`: 5 native candidate tests thất bại
  tại isolation probe (`The sandbox profile was rejected.`). Background native tests
  yêu cầu `COSMEW_TEST_REAL_BACKGROUND=1`, chưa có live OS evidence trên host này.
- `git diff --check`: qua. Không thêm dependency, không commit, không sửa apps/tui.

## P1 fix round — contract 1.38

Coordinator báo cáo full suite ngoài sandbox: 1104 pass, 11 skip, 7 fail;
đây là kết quả coordinator cung cấp, không phải một lần chạy local mới. Năm lỗi P1
đều do expectation JSONL còn 1.37: headless final response, permission flags, memory
context, dollar skill và subagent event stream. Đổi literal sang 1.38 và đổi tên
test memory; giữ nguyên mọi assertion quyền, thứ tự started/progress/finished,
TUI collapsed/expanded, recovery, context và redaction. Không cần đổi runtime/event.

Đã rà README, CLAUDE.md, docs và tests; cập nhật ghi chú phiên bản hiện hành thành
contract 1.38 / SQLite 9. Các mốc lịch sử trong ADR và acceptance cũ giữ nguyên,
không viết lại bằng chứng của contract 1.37 / SQLite 8.

Kiểm tra local fix round: format, typecheck và lint qua. Chạy đủ bốn file
end-to-end được yêu cầu: 23 pass, 8 fail; 7 lỗi bind port 0 `EADDRINUSE` ở
headless-exec, 1 lỗi child usage `CONTEXT_LIMIT` đúng hunk turn.ts của phiên khác.
Không sửa hai lỗi không thuộc P1 (apply-patch context và subagent child usage),
không sửa runtime hay apps/tui, không commit.
Chạy riêng đúng năm test P1: **3 pass, 2 fail**; hai test headless bị
`EADDRINUSE` trước khi tới assertion. Ba test memory/skill/subagent event+TUI qua.
