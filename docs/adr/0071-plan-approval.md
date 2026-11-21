# ADR 0071 — Duyệt kế hoạch tường minh

Ngày: 2026-11-20. Trạng thái: Chấp nhận. Public contract: 1.38; SQLite: 9 (chung migration với ADR 0069).

## Quyết định

`update_plan` tiếp tục là checklist cung cấp thông tin. `exit_plan_mode {plan}` gửi đề xuất riêng để người dùng duyệt tường minh, chỉ khi chế độ quyền của phiên cha là `plan`. Tool này không được cung cấp cho agent con. ToolDispatcher kiểm tra đầu vào, ghi audit, redact và điều phối lời gọi; SDK kiểm tra lại chế độ, phiên và trạng thái huỷ trước khi áp dụng câu trả lời.

SDK cung cấp `pendingPlanApproval()`, `onPlanProposed(listener)` và `resolvePlanApproval('acceptEdits' | 'manual' | {feedback})`. Lựa chọn tường minh acceptEdits chuyển chế độ quyền sang `acceptEdits`; manual chuyển sang `default`. Cả hai đưa workflow về chat và cho model tiếp tục qua dispatcher thông thường. Feedback trả văn bản đã làm sạch cho model và giữ chế độ plan. Câu trả lời không duyệt riêng một thao tác sửa file, lệnh shell, thao tác mạng hay ghi đè deny rule. Sandbox, rules và cơ chế duyệt hiện có tiếp tục áp dụng cho mọi tool sau đó.

Composition root cung cấp các port persistence và nối `exit_plan_mode` với SDK. UI bật khả năng nhận đầu vào tương tác qua cơ chế hiện có và hiển thị đề xuất từ SDK; lời gọi headless trả `unavailable` ngay. Bản thân việc duyệt không chạy phần triển khai hay phát lại tool.

## Trạng thái bền vững và hành vi khi lỗi

Persistence sở hữu `session_plan_approval`, lưu một bản ghi đề xuất có giới hạn cho mỗi phiên. Bản ghi chứa id không mang ý nghĩa quyền hạn, id phiên, kế hoạch đã redact, thời điểm tạo, trạng thái và câu trả lời nếu có. Bản ghi độc lập với checklist. Đề xuất được lưu trước khi observer nhìn thấy; kết quả duyệt được lưu trước khi đổi chế độ quyền. Lỗi lưu trữ giữ nguyên chế độ plan. SQLite 8 được nâng lên 9 trong transaction cùng thay đổi thu hồi đầu vào; schema mới hơn bị từ chối theo nguyên tắc fail closed.

`planProposal()` cung cấp lịch sử bền vững. Recovery không tạo lại waiter, hộp thoại hay grant đang chờ từ bản ghi, kể cả bản ghi còn trạng thái proposed sau khi tiến trình bị dừng đột ngột. Chỉ đề xuất mới được gửi trong phiên đang hoạt động mới có thể đổi chế độ. Xoá phiên sẽ xoá bản ghi. Huỷ lượt, đổi quyền, thu hồi đồng ý truy cập thư mục, đặt lại quyền của phiên hoặc ngắt UI nhập liệu đều xoá waiter đang chờ và ghi nhận huỷ. Câu trả lời đến muộn bị từ chối. Mỗi observer nhận bản sao riêng và không thể sửa trạng thái đang chờ.

## Bằng chứng và giới hạn

`tests/contracts/plan-approval.test.ts` kiểm tra SDK/composition root thật, SQLite store và ToolDispatcher mà không mở cổng mạng: các lựa chọn duyệt tường minh, feedback, kiểm tra đầu vào, redaction, cách ly observer, huỷ, câu trả lời cũ, đổi chế độ, ngắt UI/chạy headless, khôi phục dữ liệu không khôi phục grant và lỗi lưu trữ trước khi duyệt.

Không thêm dependency. Payload chính xác của hộp thoại duyệt kế hoạch và hành vi sau khi khởi động lại của Claude Code upstream: **Needs verification**. ADR này mô tả hành vi Futryn, không tuyên bố đã xác minh tương thích provider live hay hệ điều hành.
