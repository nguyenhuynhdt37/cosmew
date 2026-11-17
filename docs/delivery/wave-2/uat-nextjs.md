# S0 — UAT thật: Futryn tạo project Next.js

- Ngày: 2026-11-17. Code: `dev` `2b7f480` + thay đổi chưa commit gỡ Codex runtime (ADR 0049).
- Tài khoản `chatgpt-api` (OAuth direct API), model `gpt-6.1-terra`. Driver `scripts/uat/agent-run.ts --approve all`, sandbox mặc định `workspace-write` (Seatbelt), approval `on-request`.
- Kịch bản: [uat-nextjs-prompts.txt](uat-nextjs-prompts.txt) (5 lượt). Workspace bỏ đi: `uat-futryn/run-20261117-2140` (nằm bên trong repo hannes).
- Đây là bằng chứng live đầu tiên cho đăng nhập ChatGPT direct API + agent loop có tool.

## Kết quả

| Lượt | Thời gian | Tool call | Tool lỗi | Hỏi quyền | Kết quả thật |
|---|---|---|---|---|---|
| 1 Tạo project | 147 s | 24 | 3 | 4 | Tạo thủ công (create-next-app không ghi được config/cache), cài deps xong; **build EPERM** |
| 2 Trang bán hoa | 120 s | 19 | 2 | 0 | Component + state giỏ hàng; typecheck/lint đạt |
| 3 API + test | 83 s | 16 | 0 | 0 | `/api/products`, trang lấy từ API, 1 test đạt |
| 4 Dev server + curl | 20 s | 3 | 1 | 0 | **`listen EPERM 0.0.0.0:3000`**, không curl được |
| 5 Rà soát | 63 s | 14 | 0 | 0 | lint/tsc/test đạt; báo trung thực build và HTTP chưa xác nhận |

Tổng: 76 tool call, 5/5 lượt hoàn tất, input 1 110 482 token, output 12 491, cache read rất thấp (lượt cuối 15 360/351 773).
Agent báo cáo trung thực (không bịa build/HTTP thành công).

## Lỗi của Futryn tìm được

| # | Mức | Lỗi | Hướng sửa |
|---|---|---|---|
| F1 | Cao | Sandbox chặn bind cổng localhost → không chạy được dev server/test server. | Cho phép `network-bind`/`network-inbound` trên loopback trong Seatbelt/bwrap (đối chiếu policy Codex ở revision ghim — Needs verification), hoặc gắn vào duyệt `network.*`. |
| F2 | Cao | Lệnh thất bại vì sandbox nhưng không có đường leo quyền: model không được gợi ý chạy lại với quyền rộng hơn, user không được hỏi (dù `--approve all`). | Như Codex on-request: nhận diện lỗi do sandbox (exit + EPERM/Operation not permitted) → kết quả tool ghi rõ "sandbox denied" + model có thể gọi lại với yêu cầu leo quyền (`request_permissions`/tham số escalation) → hỏi user. |
| F3 | Trung bình | `next build` EPERM khi chạm `.git` của repo cha (workspace lồng trong repo khác). | Xác định thao tác bị chặn (đọc hay ghi). Codex chỉ cấm ghi `.git`; nếu Futryn cấm đọc thì nới về chỉ-đọc. |
| F4 | Trung bình | `create-next-app`/npm không ghi được cache/config ở home (home bị ẩn); agent phải tự đặt `npm_config_cache` trong project. | Đặt mặc định cache công cụ (`npm_config_cache`, `XDG_CACHE_HOME`, …) vào thư mục tạm có thể ghi của phiên, như Codex dùng TMPDIR. |
| F5 | Chi phí | ~1,1 triệu token input cho 5 lượt, cache hit ~4%. | Prompt caching cho provider OpenAI/ChatGPT: `prompt_cache_key` theo session + giữ prefix ổn định (instructions, tool schema). |

## Kết luận

Agent loop, tool, ghi file, lint/typecheck/test chạy được thật trên ChatGPT direct API. Chưa đạt "làm trọn project" vì F1–F2 (không build/không chạy server được trong sandbox mà không có đường leo quyền). Sửa F1–F5 (mỗi lỗi một phiên `fix`) rồi chạy lại S0, trước hoặc song song S1 khác file.

## Trạng thái sửa (2026-11-17, ADR 0053)

Quyết định của user: theo Codex đúng nghĩa, bỏ các kiểm soát chặt hơn Codex. Đã sửa trong code + test (chưa chạy lại S0 live):

| # | Sửa |
|---|---|
| F1 | Seatbelt cho phép bind/listen/connect localhost (3 rule `allow_local_binding` của Codex); mạng ngoài vẫn cần duyệt. Linux bubblewrap chưa đổi (Needs verification). |
| F2 | `require_escalated` + `justification`: hỏi user (prompt ghi rõ KHÔNG sandbox), duyệt thì chạy đúng lệnh đó một lần; `never` từ chối; kết quả `SANDBOX_DENIED` gợi ý model dùng `require_escalated`/mạng. |
| F3 | Cho đọc `.git` của workspace và các thư mục cha; ghi vẫn bị chặn. |
| F4 | Cache công cụ (`npm_config_cache`, `XDG_*`, `YARN_CACHE_FOLDER`, ...) trong thư mục scratch của phiên; scratch được `realpath` (trước đây quy tắc ghi không khớp do symlink `/var`). |
| F6 | `on-request`/`never` chạy lệnh không parse được và input `write_stdin` trong sandbox; `untrusted` vẫn hỏi; lệnh nguy hiểm vẫn hỏi/bị cấm. |
| F7 | Thêm Mach service `com.apple.FSEvents` (Node recursive watch: `EMFILE` khi thiếu, chạy khi có). Turbopack thật chưa chạy lại. |
