# Driver UAT cho agent Cosmew (headless)

Chạy agent thật (cùng đường code với TUI: `startup` → `createFutrynClient` → `setToolsEnabled(true)`) trên một thư mục dự án, không cần giao diện.

## Chạy một lượt bằng CLI (S1, contract 1.24)

```sh
bun run fyn exec "Đọc README và tóm tắt" --cd /path/to/project --json -o answer.txt
cat prompt.txt | bun run cosmew exec - -C /path/to/project --approval never --sandbox read-only
```

`--cd`/`-C` phải rõ ràng để đồng ý thư mục; không có cờ này thì exit 2. Có thể chọn
`--account <id-or-alias>` và `--model <id>` đã có trong catalog. `--approval` nhận
`untrusted|on-request|never`; không TTY mặc định `never` (ưu tiên hơn env). Mọi yêu cầu
cần duyệt mà không có TTY đều bị từ chối ngay và trả kết quả lỗi cho model, kể cả khi
đặt `on-request`/`untrusted`; không chờ polling. Khi có TTY và prompt argv, chỉ `y`/`yes`
duyệt một lần. Prompt `-` đọc stdin tối đa 1 MiB, không dùng stdin để hỏi quyền.
Exec luôn tắt `request_user_input` bằng `setUserInputAvailable(false)`.

`--json` là JSONL sự kiện theo [agent-events](../../docs/contracts/agent-events.md),
mỗi dòng có `contractVersion`, `seq`, `type`; kết thúc bằng `turn.completed` hoặc
`turn.failed`. Diagnostic tham số/startup ở stderr. Không `--json` chỉ in response cuối.
`--output-last-message`/`-o` lưu response cuối đã redact, có newline; path tương đối tính
từ `--cd`. Exit: 0 xong; 1 lỗi turn/output hoặc SIGINT/SIGTERM; 2 thiếu consent/account/model
dùng tool; 64 sai tham số/stdin. Sandbox hiện có: `read-only|workspace-write`;
`danger-full-access` bị từ chối (64), không fallback.

## Driver nhiều lượt và evidence

```sh
bun scripts/uat/agent-run.ts --workspace <thư-mục> --prompts <file.txt> --report <report.json> \
  [--approve all|none] [--turn-timeout-ms <n>] [--state-dir <thư-mục>]
```

- `--workspace`: thư mục dự án; đây chính là sự đồng ý (folder consent) cho phiên chạy.
- `--prompts`: file UTF-8, các lượt cách nhau bằng một dòng chỉ có `---`; gửi tuần tự trong cùng một phiên.
- `--approve all` (mặc định): tự động chấp nhận (một lần) mọi yêu cầu quyền; `none`: từ chối hết.
- Câu hỏi `request_user_input` được trả lời bằng lựa chọn đầu tiên.
- Contract 1.24: driver đăng ký `client.onInteractionEvent` cho `permission.requested` /
  `question.asked` thay polling; CLI cũ giữ nguyên, option lập trình `pollMs` bị bỏ qua.
  Snapshot thêm `permissionMode` (ADR 0061). Driver bật user input riêng vì có bộ trả lời tự động;
  hành vi này khác exec một lượt ở trên.
- Thư mục trạng thái giống CLI: `COSMEW_HOME`, mặc định `~/.cosmew` (đọc `FUTRYN_HOME` rồi `HANNES_HOME` và dùng lại legacy roots nếu có). Cần đã chọn account và model.
- Timeout mỗi lượt mặc định 20 phút (huỷ bằng AbortSignal). Ctrl+C huỷ gọn. Mã thoát 0 chỉ khi mọi lượt hoàn tất không lỗi.
- Báo cáo JSON: từng lượt (prompt, finalText, toolCalls, permissions, questions, planFinal, error, durationMs), usage và status. Mọi đầu ra đi qua redactor.
  Call lỗi/bị từ chối (`status` khác `ok`) có thêm `toolCalls[].error`: text kết quả tool mà model nhìn thấy (đã redact, gộp một dòng, tối đa 300 ký tự) để chẩn đoán nguyên nhân như `INVALID_INPUT`; call `ok` không có trường này. `evidence` vẫn không chứa input/path/nội dung.
- Contract 1.23 thêm `contractVersion`, `toolCalls[].callId` và `turns[].evidence` nếu đã xác định được session/turn.
  Evidence đối chiếu journal với audit SQLite: call/intent/result, thứ tự requested/decided/completed,
  outcome và scope hash. `decision: deny` vẫn là bằng chứng dispatcher đã từ chối; hash không phải quyền.
  Projection không chứa input, path hay nội dung file; tối đa 1.000 calls/10.000 audit rows được xác minh.
  Thiếu/trùng bản ghi, storage không đọc được hoặc `truncated: true` không được coi là dispatcher verified.
  `ok` và exit code chỉ báo các lượt hoàn tất; cần xem `journalVerified`/`dispatcherVerified` riêng.
  Đây là bằng chứng tương quan cho lượt chạy quan sát được, không phải chứng nhận mọi đường thực thi.

**CẢNH BÁO:** `--approve all` tự động chấp nhận MỌI yêu cầu (ghi file, chạy lệnh, mạng). Chỉ dùng cho UAT trên dự án có thể bỏ đi, không dùng với dữ liệu thật.
