# ADR 0070 — Background tasks từ unified exec và subagent registry

Ngày: 2026-11-20. Trạng thái: Accepted. Contract 1.38, additive.

## Quyết định

SDK `backgroundTasks(sessionId?)` trả snapshot `{id, kind: shell|agent, description, status: running|done|failed|stopped, startedAt, exitCode?, outputTail}`. Shell dùng đúng ID unified-exec hiện có. Agent là projection từ `SubagentManager`/`SubagentSummaryView`, không có executor hoặc scheduler mới. Chỉ children có `background` xuất hiện; `completed` → `done`, `cancelled|closed|interrupted` → `stopped`. Snapshot và event qua redactor, không cấp quyền.

`backgroundCurrentTask()` đồng bộ trả task hoặc undefined. Chuyển một lệnh foreground đang đợi sang background: trả session sớm, tháo liên kết abort của lượt cha, giữ nguyên process, sandbox, timeout lease và ID. Lệnh tự yield cũng trở thành task. Không chạy shell wrapper, không rerun command, không cấp quyền mới. `stopBackgroundTask(id)` trả Promise<boolean>; chỉ nhắm ID đang chạy của phiên hiện hành, shell dùng group termination hiện có, agent dùng stopSubagent. ID lạ/đã kết thúc trả false.

Native runtime giữ output tail riêng tối đa 8.192 ký tự, không consume cửa sổ `write_stdin`; giữ tối đa 200 task snapshots hoàn thành gần đây. Khi hết terminal slots, reclaim session nền đã kết thúc (tail còn trong snapshot), không evict session đang chạy; polling ID đã reclaim có thể bị từ chối. `task.started|task.updated|task.finished` là SDK observer notifications (qua `onBackgroundTaskEvent` và reactive event), không phải provider ModelEvent hay journal envelope mới. Subscriber lỗi không phá thực thi. Agent task events chiếu sự kiện subagent hiện hữu. Không đổi dependency DAG, không dependency mới, không thêm durable process replay.

Completion shell dùng composition-root registry gắn parent session từ trusted `CommandRequest.taskSessionId` ở lúc launch (dispatcher callback), không lấy active root thay child. Background transfer lọc cùng conversation; metadata này không nhận từ model args. Owner không đổi sau lần đăng ký đầu tiên. Khi parent còn chạy, `Conversation.steer` nhận `<task-notification>` và journal hiện có đảm bảo input bền; khi idle, `SqliteConversations.enqueueNextTurn` lưu inbox trước khi thông báo observer. Dùng chung đường enqueue/steer với kết quả background subagent. Không khởi động agent loop thứ hai; host tiêu thụ inbox bằng API queue hiện có. Đổi phiên không gửi completion vào phiên mới. Registry bỏ completion trùng. Task runtime không phục hồi tiến trình sau restart; notification đã enqueue vẫn còn sau restart. Shutdown hủy tasks qua runtime shutdown hiện có.

## Bằng chứng và giới hạn

`tests/contracts/background-tasks.test.ts`: SQLite thật, giữ notification đúng parent khi đổi phiên, redact trước durable write/callback, duplicate finish không enqueue hai lần, stop không xuyên phiên và completion giao vào lượt đang chạy. Đây là test composition/contract với runtime fixture, không phải chứng minh OS compatibility.

`tests/security/background-tasks.test.ts` chạy process thật bằng NativeCommandRuntime khi `FUTRYN_TEST_REAL_BACKGROUND=1`: foreground transfer giữ ID/output sau parent abort, exit code lỗi, stop một lần và foreground cancellation. Trên host managed của phiên này native availability probe không qua (`UNSUPPORTED` do sandbox không khả dụng), nên các test OS được opt-in và **Needs verification**; không dùng mock success thay bằng chứng sandbox. Seatbelt descendant containment vẫn `unconfirmed` theo ADR0035, không có bảo đảm mới. Linux/Windows và Claude Code live parity: **Needs verification**.

Không sửa apps/tui trong wave này. UI hosts cần subscribe `onBackgroundTaskEvent`, render snapshot và gọi đường queue đang có để chạy notification tiếp theo. Một native runtime có thể dùng chung root/children nhưng snapshot/control được lọc theo conversation launch; isolated child runtime gửi event cùng metadata. `fyn exec` chờ cả shell/agent đang chạy rồi tiêu thụ notification qua queue hiện có. Không tuyên bố process recovery hay remote task execution.
