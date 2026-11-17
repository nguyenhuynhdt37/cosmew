# Driver UAT cho agent Futryn (headless)

Chạy agent thật (cùng đường code với TUI: `startup` → `createFutrynClient` → `setToolsEnabled(true)`) trên một thư mục dự án, không cần giao diện.

```sh
bun scripts/uat/agent-run.ts --workspace <thư-mục> --prompts <file.txt> --report <report.json> \
  [--approve all|none] [--turn-timeout-ms <n>] [--state-dir <thư-mục>]
```

- `--workspace`: thư mục dự án; đây chính là sự đồng ý (folder consent) cho phiên chạy.
- `--prompts`: file UTF-8, các lượt cách nhau bằng một dòng chỉ có `---`; gửi tuần tự trong cùng một phiên.
- `--approve all` (mặc định): tự động chấp nhận (một lần) mọi yêu cầu quyền; `none`: từ chối hết.
- Câu hỏi `request_user_input` được trả lời bằng lựa chọn đầu tiên.
- Thư mục trạng thái giống CLI: `FUTRYN_HOME`/`HANNES_HOME`, mặc định `~/.futryn` (dùng lại `~/.hannes` nếu có). Cần đã chọn account và model.
- Timeout mỗi lượt mặc định 20 phút (huỷ bằng AbortSignal). Ctrl+C huỷ gọn. Mã thoát 0 chỉ khi mọi lượt hoàn tất không lỗi.
- Báo cáo JSON: từng lượt (prompt, finalText, toolCalls, permissions, questions, planFinal, error, durationMs), usage và status. Mọi đầu ra đi qua redactor.

**CẢNH BÁO:** `--approve all` tự động chấp nhận MỌI yêu cầu (ghi file, chạy lệnh, mạng). Chỉ dùng cho UAT trên dự án có thể bỏ đi, không dùng với dữ liệu thật.
