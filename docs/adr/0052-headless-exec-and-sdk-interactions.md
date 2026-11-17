# ADR 0052 — Exec headless và sự kiện tương tác SDK

Ngày: 2026-11-17. Trạng thái: accepted; wave 2 **chỉ S1**. Contract 1.23 → 1.24;
không đổi SQLite, không thêm dependency.

## Quyết định

`fyn exec` (cũng qua entry point `hannes`/`futryn`) chạy một lượt bằng SDK và agent loop
Futryn hiện có. Các cờ: prompt hoặc `-` đọc UTF-8 stdin (tối đa 1 MiB), `--cd`/`-C`,
`--approval`, `--sandbox`, `--json`, `--output-last-message`/`-o`, `--account`, `--model`.
Thư mục phải tồn tại; chỉ `--cd` rõ ràng mới cấp folder consent. Không có consent hoặc
account/model dùng tool thì exit 2. Sai tham số/stdin rỗng thì 64, hoàn tất thì 0,
lỗi turn/provider/output hoặc SIGINT/SIGTERM thì 1. Không đổi hành vi `run` cũ.

Không TTY: mặc định `never`, kể cả khi env đặt policy tương tác. Cờ policy rõ ràng
được ưu tiên. Với `untrusted`/`on-request` nhưng không có TTY, yêu cầu cần duyệt
được trả lời deny ngay qua SDK, không chờ poll/timeout. Với TTY và prompt argv,
chỉ `y`/`yes` cấp quyền một lần; EOF, hủy hoặc mọi câu trả lời khác là deny.
Prompt đọc stdin không dùng lại stdin để hỏi quyền. `setUserInputAvailable(false)`
luôn tắt câu hỏi tương tác trong exec.

SDK thêm `onInteractionEvent(listener)` trả hàm unsubscribe, với union contract
`InteractionEvent`: `permission.requested`/`question.asked`, payload `request` đầy đủ,
đã sanitize, clone riêng cho mỗi observer. Lỗi observer không làm đổi quyết định.
Permission notification được đưa vào microtask để waiter tồn tại trước callback
trả lời đồng bộ; không phát lại yêu cầu đã được hủy/settle. `status().approvalPolicy`
phản ánh mode hiện tại. Reactive observer cũ giữ nguyên; thông báo typed không thay
trạng thái hoạt động của TUI. UAT chuyển sang typed subscription; CLI UAT giữ nguyên,
`pollMs` chỉ còn là tham số tương thích bị bỏ qua.

JSONL dùng `HeadlessEvent`: ModelEvent hiện có, InteractionEvent và terminal
`turn.completed`/`turn.failed`, mỗi dòng có `contractVersion: "1.24"` và `seq` tăng
liên tiếp từ 1. `completed` của provider khác terminal `turn.completed` của cả lượt.
Parse/startup diagnostics ở stderr; stdout JSONL không có banner/log. Plain output và
file cuối chỉ chứa response cuối, bỏ response trung gian/retry. File cuối được redact,
thêm newline; path tương đối tính từ `--cd`, path tuyệt đối được giữ. Đây là destination
artifact do người gọi CLI chọn, không phải công cụ ghi file do model chọn.

Mọi tool vẫn qua SDK → core → ToolDispatcher và các cổng quyền/audit/sandbox hiện có.
Không có executor mới, không gọi agent ngoài. Sandbox chỉ nhận `read-only` và
`workspace-write` mà runtime hiện có hỗ trợ; `danger-full-access` bị từ chối (64),
không giả hỗ trợ hoặc fallback ngoài sandbox. Mở rộng runtime ngoài sandbox không thuộc S1.

## Tham chiếu và giới hạn bằng chứng

Port hành vi, không chép mã/văn bản upstream. Revision tham chiếu Codex:
`090be4df0724cdef5758e6a0934ba557af8b6bbe` (theo AGENTS.md).

- [exec/src/cli.rs](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/exec/src/cli.rs):
  cờ JSONL, output-last-message, cd và stdin. Truy cập 2026-11-17 qua raw URL thất bại
  (`Cache miss`): **Needs verification** ở revision này.
- [exec/src/lib.rs](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/exec/src/lib.rs):
  mặc định không hỏi và chi tiết exit code upstream: **Needs verification**, chưa đọc
  thành công ở revision ghim. Exit 0/1/2/64 của Futryn là contract S1 đã chọn,
  không tuyên bố trùng mã lỗi của Codex.
- OpenCode run và Claude `-p --output-format stream-json`: nguồn cảm hứng trong plan;
  **Needs verification**, không dùng để khẳng định tương thích wire format.

Test provider giả là bằng chứng cho agent loop/dispatcher và giao thức headless,
không chứng minh provider live hoặc sandbox OS. Môi trường phiên này chặn loopback
`Bun.serve(port: 0)` với `EADDRINUSE`; test CLI HTTP/signal có trong suite nhưng chưa
xác minh được trong môi trường đó. Fetch-port fixture và test SDK không cần socket.
